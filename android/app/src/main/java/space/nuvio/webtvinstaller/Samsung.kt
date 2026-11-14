package space.nuvio.webtvinstaller

import kotlinx.coroutines.delay
import java.io.File
import java.security.SecureRandom
import java.util.Base64

/** Calls into nuvio-core.js (the desktop signing/certificate code) running in the WebView. */
typealias CoreCall = suspend (body: String, args: Map<String, Any?>) -> Any?

/** runSamsung and helpers from main.js. */
class Samsung(
    private val config: InstallerConfig,
    private val emit: Emit,
    private val core: CoreCall,
    private val auth: suspend () -> Map<String, String>
) {
    companion object {
        const val PACKAGE_COMMAND_COMPLETE = "spend time|install failed|uninstall failed|download failed|check certificate error|invalid certificate chain"
        const val EXTENSION_INFO_URL = "https://download.tizen.org/sdk/tizenstudio/official/extension_info.xml"
        val CA_FILES = listOf("vd_tizen_dev_author_ca.cer", "vd_tizen_dev_public2.crt", "vd_tizen_dev_partner2.crt")
        val caDirectory get() = File(Paths.home, "share/.samsung-cert")
        val caMarker get() = File(caDirectory, ".extension")
        val certDirectory get() = File(Paths.userData, "samsung-certificates")

        /** Only the text files the validators read cross into the WebView. */
        val INSPECTED_FILES = setOf("config.xml", "tizen-manifest.xml", "main.js", "index.html",
            "services/tizen/enginefs-service.js", "services/tizen/plugin-service.js")

        fun isClosedOutput(output: String) = output.lines2().any { it.trim().lowercase() == "closed" }
        fun isClosedError(error: Throwable): Boolean {
            val e = error as? InstallerError
            return isClosedOutput(e?.stdout.orEmpty()) || isClosedOutput(e?.stderr.orEmpty()) || errorMessage(error).matchesI("""\bclosed\b""")
        }
        private fun combined(error: Throwable): String {
            val e = error as? InstallerError
            return "${e?.stdout.orEmpty()}\n${e?.stderr.orEmpty()}\n${errorMessage(error)}"
        }
        fun isPlatformIncompatibility(output: String) = output.matchesI("""install failed\s*\[\s*(?:118019|118\s*,\s*-?19)\s*\]""")
        fun isPlatformIncompatibility(error: Throwable) =
            (error as? InstallerError)?.code == "SAMSUNG_UNSUPPORTED_PLATFORM" || isPlatformIncompatibility(combined(error))
        fun isCertificateRejection(output: String): Boolean {
            if (isPlatformIncompatibility(output)) return false
            return output.matchesI("""install failed\s*\[\s*(?:118012|118(?:\s*,[^\]]*)?)\s*\]""") ||
                output.matchesI("check certificate error") || output.matchesI("invalid certificate chain") ||
                output.matchesI("Samsung TV rejected the signed package")
        }
        fun isCertificateRejection(error: Throwable) = if (isPlatformIncompatibility(error)) false else isCertificateRejection(combined(error))

        fun platformIncompatibilityError(required: String = "", actual: String = ""): InstallerError {
            val modelRange = if (required == "5.0") " (Samsung TVs from 2019 onward)" else ""
            val requirement = if (required.isEmpty()) "This package requires a newer Samsung Tizen version. "
            else "This package requires Tizen $required or later$modelRange. "
            val detected = if (actual.isEmpty()) "" else " The TV reported Tizen $actual."
            return InstallerError("This Samsung TV is not compatible with this Nuvio package. ${requirement}The standalone WGT was not installed.$detected",
                code = "SAMSUNG_UNSUPPORTED_PLATFORM")
        }

        fun throwIfFailed(output: String, context: String) {
            val failedLine = output.lines2().map { it.trim() }.firstOrNull {
                it.matchesI("install failed|uninstall failed|download failed|check certificate error|invalid certificate chain|error") || it.lowercase() == "closed"
            } ?: return
            if (failedLine.lowercase() == "closed") {
                throw InstallerError("$context: Samsung TV closed the shell command before installation completed.", stdout = output)
            }
            if (isCertificateRejection(output)) {
                throw InstallerError("$context: $failedLine\n\nSamsung TV rejected the signed package. " +
                    "The installer will retry any previous signing identities saved for this TV DUID. " +
                    "The failure can indicate an invalid certificate chain, a DUID mismatch, or a signing profile with insufficient privileges.", stdout = output)
            }
            throw InstallerError("$context: $failedLine", stdout = output)
        }

        fun parseAppList(output: String): List<Map<String, String>> =
            output.split("---------------------------------------------------------------------------------------------")
                .map {
                    it.replace("--------------", "").replace("-------------", "")
                        .replace(Regex("""\s+="""), "=").replace("\r", "").trim()
                }
                .filter { it.isNotEmpty() }
                .map { entry ->
                    val app = LinkedHashMap<String, String>()
                    for (line in entry.split("\n")) {
                        val i = line.indexOf('=')
                        if (i <= 0) continue
                        app[line.substring(0, i).trim()] = line.substring(i + 1).trim()
                    }
                    app
                }
                .filter { it.isNotEmpty() }

        fun configPath(target: String) =
            File(certDirectory, "${target.ifEmpty { "default" }.replace(Regex("[^a-z0-9_.-]+", RegexOption.IGNORE_CASE), "_")}.json")
        fun configPathForDuid(duid: String) = File(certDirectory, "duid-${sha256Hex(duid.toByteArray())}.json")
        fun fingerprint(c: Map<String, Any?>): String = c["authorCert"].str().let { if (it.isEmpty()) "" else sha256Hex(it.toByteArray()) }
        fun isUsable(c: Map<String, Any?>?, duid: String = ""): Boolean {
            if (c == null) return false
            return listOf("authorCert", "distributorCert", "password").all { c[it].str().isNotEmpty() } && (duid.isEmpty() || c["duid"].str() == duid)
        }
        fun readConfig(file: File): Map<String, Any?>? = try { parseJson(file.readText()).asMap() } catch (_: Exception) { null }
        fun writeConfig(file: File, c: Map<String, Any?>) {
            file.parentFile?.mkdirs()
            val tmp = File(file.parentFile, "${file.name}.${System.nanoTime()}.tmp")
            tmp.writeText(org.json.JSONObject(c).toString(2))
            tmp.setReadable(false, false); tmp.setReadable(true, true)
            if (!tmp.renameTo(file)) { tmp.copyTo(file, overwrite = true); tmp.delete() }
        }
    }

    private val configuredIds get() = candidates(listOf(config.tizen.appId, config.tizen.packageId) + config.tizen.appIds)

    private fun candidates(values: List<String?>): List<String> =
        values.mapNotNull { it?.trim() }.filter { it.isNotEmpty() }.distinct()

    // MARK: Transport

    /**
     * connectSamsungTransport: direct connection, then the sdb fallback. sdb speaks the same protocol on
     * port 26101, so the fallback is a fresh `sdb connect`-style session verified with getduid.
     */
    suspend fun connectTransport(ip: String): SamsungTransport {
        var transport: SamsungTransport? = null
        try {
            transport = SamsungTransport.connect(emit, ip)
            transport.shell(emit, listOf("0", "getduid"), SamsungTransport.ShellOptions(timeoutMs = 8000, logOutput = false))
            return transport
        } catch (error: Exception) {
            transport?.close()
            emit("info", "Direct connection failed (${errorMessage(error)}). Trying sdb fallback.")
        }
        emit("command", "$ sdb connect $ip")
        delay(1000)
        transport = null
        try {
            transport = SamsungTransport.connect(emit, ip)
            transport.shell(emit, listOf("0", "getduid"), SamsungTransport.ShellOptions(timeoutMs = 10_000, logOutput = false))
            emit("info", "Detected SDB target: $ip:26101")
            return transport
        } catch (error: Exception) {
            transport?.close()
            emit("stderr", errorMessage(error))
        }
        throw InstallerError("Samsung TV was not found in \"sdb devices\" after connecting to $ip. Check Developer Mode and Host PC IP on the TV.")
    }

    private suspend fun capabilities(t: SamsungTransport): Map<String, String> {
        val out = try { t.shell(emit, listOf("0", "capability"), SamsungTransport.ShellOptions(timeoutMs = 10_000, logOutput = false)) } catch (_: Exception) { return emptyMap() }
        val caps = HashMap<String, String>()
        for (line in out.lines2()) {
            val i = line.indexOfFirst { it == ':' || it == '=' }
            if (i < 0) continue
            caps[line.substring(0, i).trim()] = line.substring(i + 1).trim()
        }
        return caps
    }

    // MARK: Shell helpers

    private suspend fun ensureTempDirectory(t: SamsungTransport): Boolean {
        val note = "Samsung TV closed the generic shell setup command; continuing with direct push and vd_appinstall."
        return try {
            val output = t.shell(emit, listOf("0", "mkdir", "-p", "/home/owner/share/tmp/sdk_tools"), SamsungTransport.ShellOptions(noOutputSuccessMs = 1500))
            if (isClosedOutput(output)) { emit("info", note); false } else true
        } catch (error: Exception) {
            if (isClosedError(error)) { emit("info", note); false } else throw error
        }
    }

    private suspend fun push(t: SamsungTransport, local: File, remote: String) {
        emit("command", "$ adbhost push ${local.path} $remote")
        t.push(remote, local.readBytes())
    }

    private suspend fun verifyRemotePackage(t: SamsungTransport, local: File, remote: String) {
        val expected = local.length()
        val closedNote = "Samsung package upload check was closed by the TV; continuing because the push command completed."
        val output = try {
            t.shell(emit, listOf("0", "ls", "-l", remote), SamsungTransport.ShellOptions(timeoutMs = 10_000, idleAfterDataMs = 800, noOutputSuccessMs = 2500))
        } catch (error: Exception) {
            if (isClosedError(error)) { emit("info", closedNote); return }
            throw error
        }
        if (isClosedOutput(output)) { emit("info", closedNote); return }
        val parts = output.trim().split(Regex("\\s+"))
        val remoteSize = parts.getOrNull(4)?.toLongOrNull() ?: 0L
        if (remoteSize == 0L) {
            emit("info", "Samsung package upload check did not return a remote size; continuing because the push command completed.")
            return
        }
        if (remoteSize != expected) throw InstallerError("Samsung package upload failed: remote size $remoteSize, expected $expected.")
        emit("info", "Samsung package uploaded correctly ($remoteSize bytes).")
    }

    private suspend fun readPlatformVersion(t: SamsungTransport): String = try {
        t.shell(emit, listOf("0", "capability"), SamsungTransport.ShellOptions(timeoutMs = 10_000))
            .firstGroup("""(?:^|\n)\s*platform_version\s*[:=]\s*([^\s\r\n]+)""")?.trim().orEmpty()
    } catch (error: Exception) {
        emit("info", "Samsung platform capability check was unavailable; continuing with package validation. ${errorMessage(error)}")
        ""
    }

    private suspend fun validatePlatformVersion(t: SamsungTransport, required: String) {
        if (required.isEmpty()) return
        val actual = readPlatformVersion(t)
        if (actual.isEmpty()) {
            emit("info", "Samsung TV did not expose platform_version; the installer will continue without guessing the TV version.")
            return
        }
        val c = compareTizenVersions(actual, required)
        if (c != null && c < 0) throw platformIncompatibilityError(required, actual)
        emit("info", "Samsung TV reports Tizen $actual; package requires Tizen $required or later.")
    }

    private suspend fun getDuid(t: SamsungTransport): String {
        val out = t.shell(emit, listOf("0", "getduid"), SamsungTransport.ShellOptions(timeoutMs = 10_000))
        val duid = out.lines2().map { it.trim() }.firstOrNull { it.isNotEmpty() } ?: throw InstallerError("Unable to read the Samsung TV DUID.")
        emit("info", "Detected Samsung DUID: $duid")
        return duid
    }

    // MARK: App list

    private suspend fun findInstalled(t: SamsungTransport, identifiers: List<String>): Map<String, String>? {
        val ids = candidates(identifiers)
        if (ids.isEmpty()) return null
        val out = t.shell(emit, listOf("0", "vd_applist"), SamsungTransport.ShellOptions(timeoutMs = 30_000, logOutput = false))
        return parseAppList(out).firstOrNull { app ->
            listOf(app["app_id"], app["app_tizen_id"], app["app_package_id"], app["package_id"]).any { ids.contains(it.orEmpty().trim()) }
        }
    }

    private suspend fun verifyInstalled(t: SamsungTransport, metadata: Map<String, String>) {
        val app = try {
            findInstalled(t, candidates(listOf(metadata["packageId"], metadata["appId"])))
        } catch (error: Exception) {
            emit("info", "Samsung install verification could not read the installed app list: ${errorMessage(error)}")
            throw InstallerError("The Samsung install command finished, but the installer could not verify that Nuvio TV is installed on the TV. " +
                "Retry the install, or install the WGT with Tizen Studio/sdb using vd_appinstall.")
        } ?: throw InstallerError("The Samsung install command finished but Nuvio TV is not installed on the TV. " +
            "The package was uploaded but not registered; retry the install, or install the WGT with Tizen Studio/sdb using vd_appinstall.")
        val installedVersion = app["app_version"].orEmpty().trim()
        val expected = metadata["version"].orEmpty().trim()
        val c = compareTizenVersions(installedVersion, expected)
        if (c != null && c != 0) {
            throw InstallerError("The Samsung install command finished but the TV still reports Nuvio TV $installedVersion, expected $expected. " +
                "The update was not applied; retry the install, or install the WGT with Tizen Studio/sdb using vd_appinstall.")
        }
        val label = listOf(app["app_id"], app["app_tizen_id"], metadata["appId"], metadata["packageId"]).firstOrNull { !it.isNullOrEmpty() }.orEmpty()
        emit("info", "Verified Samsung installation on the TV: $label${if (installedVersion.isEmpty()) "" else " ($installedVersion)"}.")
    }

    // MARK: Package inspection (JS core)

    private fun coreEntries(entries: List<ZipEntryData>): Map<String, Any?> =
        entries.associate { e ->
            val item = mutableMapOf<String, Any?>("dir" to e.isDirectory)
            if (e.name in INSPECTED_FILES) item["text"] = String(e.data, Charsets.UTF_8)
            e.name to item
        }

    private suspend fun metadata(file: File): Map<String, String> =
        core("return await __nuvioCore.metadata(entries)", mapOf("entries" to coreEntries(Zip.read(file)))).asMap().mapValues { it.value.str() }

    class Candidate(val config: Map<String, Any?>, val path: File?, val priority: Int, val createdAt: Double)

    /** prepareSamsungPackage: normalize id, check platform and services, pick certificates. */
    private suspend fun prepare(t: SamsungTransport, packageFile: File, options: Map<String, Any?>): Triple<File, String, List<Candidate>> {
        var path = packageFile
        var entries = Zip.read(path)
        val inspected = core("return await __nuvioCore.inspect(entries)", mapOf("entries" to coreEntries(entries))).asMap()
        inspected["logs"].asList().map { it.asMap() }.forEach { emit(it["type"].str().ifEmpty { "info" }, it["text"].str()) }
        val normalized = inspected["normalizedConfig"] as? String
        if (normalized != null) {
            entries = entries.map { if (it.name == "config.xml") ZipEntryData(it.name, false, normalized.toByteArray()) else it }
            val dir = File(Paths.userData, "prepared")
            val base = path.nameWithoutExtension
            val ext = path.extension.ifEmpty { "wgt" }
            path = File(dir, "$base-samsung-normalized-${System.currentTimeMillis()}.$ext")
            Zip.write(entries.filter { !it.isDirectory }.map { it.name to it.data }, path)
        }
        val metadata = inspected["metadata"].asMap().mapValues { it.value.str() }
        validatePlatformVersion(t, metadata["requiredVersion"].orEmpty())
        core("return await __nuvioCore.validate(entries)", mapOf("entries" to coreEntries(entries))).asList().map { it.asMap() }
            .forEach { emit(it["type"].str().ifEmpty { "info" }, it["text"].str()) }
        val (duid, list) = certificateCandidates(t, options)
        return Triple(path, duid, list)
    }

    // MARK: Certificates

    private suspend fun hasValidAuthorChain(c: Map<String, Any?>): Boolean = try {
        core("return __nuvioCore.hasValidSamsungAuthorChain(a, p)", mapOf("a" to c["authorCert"].str(), "p" to c["password"].str())) == true
    } catch (_: Exception) {
        false
    }

    private suspend fun readCandidates(duid: String, target: String, invalid: MutableList<File>): List<Candidate> {
        val files = certDirectory.listFiles()?.filter { it.name.lowercase().endsWith(".json") } ?: return emptyList()
        val canonical = configPathForDuid(duid)
        val targetPath = configPath(target)
        val list = mutableListOf<Candidate>()
        for (file in files) {
            val c = readConfig(file)
            if (!isUsable(c, duid)) continue
            c!!
            if (c["profileName"].str().isEmpty() && !hasValidAuthorChain(c)) { invalid.add(file); continue }
            list.add(Candidate(c, file, if (file == canonical) 0 else if (file == targetPath) 1 else 2, parseIsoDate(c["createdAt"].str())))
        }
        val seen = HashSet<String>()
        return list.sortedWith(compareBy<Candidate> { it.priority }.thenByDescending { it.createdAt })
            .filter { val f = fingerprint(it.config); f.isNotEmpty() && seen.add(f) }
    }

    private fun manualCertificate(options: Map<String, Any?>): Map<String, Any?>? {
        val manual = options["samsungCert"].asMap()
        if (manual.isEmpty() || manual["auto"] != false) return null
        val profileName = manual["profileName"].str().trim()
        // Tizen Studio is a desktop program: on Android a security profile is used through its own
        // author/distributor .p12 files (tizen-studio-data/keystore), signed with the built-in signer.
        val missing = listOf("authorPath", "distributorPath", "password").filter { manual[it].str().trim().isEmpty() }
        if (profileName.isNotEmpty() && missing.isNotEmpty()) {
            throw InstallerError("Tizen Studio security profile \"$profileName\": on Android select the profile's Author Certificate (.p12), " +
                "Distributor Certificate (.p12) and Certificate Password (from tizen-studio-data/keystore on your computer) to sign with it.")
        }
        val authorPath = requireValue(manual["authorPath"].str(), "Samsung author certificate")
        val distributorPath = requireValue(manual["distributorPath"].str(), "Samsung distributor certificate")
        val password = requireValue(manual["password"].str(), "Samsung certificate password")
        val encoder = Base64.getEncoder()
        return mapOf(
            "authorCert" to encoder.encodeToString(File(authorPath).readBytes()),
            "distributorCert" to encoder.encodeToString(File(distributorPath).readBytes()),
            "distributorXML" to "", "password" to password, "profileName" to "", "profileLabel" to profileName,
            "duid" to "", "createdAt" to isoNow()
        )
    }

    private suspend fun certificateCandidates(t: SamsungTransport, options: Map<String, Any?>): Pair<String, List<Candidate>> {
        manualCertificate(options)?.let {
            emit("info", "Using the Samsung certificates selected manually.")
            return "" to listOf(Candidate(it, null, 0, System.currentTimeMillis().toDouble()))
        }
        val duid = getDuid(t)
        val invalid = mutableListOf<File>()
        val list = readCandidates(duid, t.target, invalid)
        if (invalid.isNotEmpty()) {
            emit("info", "Ignoring ${invalid.size} saved Samsung signing identit${if (invalid.size == 1) "y" else "ies"} with an invalid certificate chain; a new certificate will be created.")
        }
        if (list.isNotEmpty()) {
            emit("info", if (list.size == 1) "Using the Samsung certificate already saved for this TV DUID."
            else "Found ${list.size} saved Samsung signing identities for this TV DUID; previous identities will be available for update recovery.")
            return duid to list
        }
        val existingDuid = readConfig(configPath(t.target))?.get("duid").str()
        if (existingDuid.isNotEmpty() && existingDuid != duid) emit("info", "Saved Samsung certificate belongs to a different TV, creating a new one.")
        val created = createCertificate(t, duid)
        return duid to listOf(Candidate(created, configPathForDuid(duid), 0, parseIsoDate(created["createdAt"].str())))
    }

    // ensureSamsungCertificateAuthorities
    private fun cachedAuthorities() = CA_FILES.all { File(caDirectory, it).exists() }

    private fun extensionRepository(): String {
        val r = Http.get(EXTENSION_INFO_URL, mapOf("User-Agent" to "Nuvio-TV-Installer"), 30_000)
        if (!r.ok) throw InstallerError("Samsung certificate extension info failed: ${r.status} ${Http.statusText(r.status)}")
        for (block in r.text.split(Regex("<extension\\b[^>]*>")).drop(1)) {
            val name = block.firstGroup("""<name>([\s\S]*?)</name>""")?.trim()
            val repo = block.firstGroup("""<repository>([\s\S]*?)</repository>""")?.trim()
            if (name == "Samsung Certificate Extension" && !repo.isNullOrEmpty()) return repo
        }
        throw InstallerError("Samsung certificate extension info did not contain a repository.")
    }

    private fun ensureAuthorities() {
        val repository = try { extensionRepository() } catch (error: Exception) {
            if (cachedAuthorities()) {
                emit("info", "Could not check for a newer Samsung certificate extension; using the cached certificate authorities. ${errorMessage(error)}")
                return
            }
            throw error
        }
        val marker = try { caMarker.readText().trim() } catch (_: Exception) { "" }
        if (repository == marker && cachedAuthorities()) return

        emit("info", "The cached Samsung certificate authorities are out of date; refreshing them before signing.")
        val archive = File(Paths.temp, "nuvio-samsung-certificate-extension-${System.currentTimeMillis()}.zip")
        try {
            Http.downloadFile(emit, repository, archive, "Downloading Samsung certificate authorities")
            val addon = Zip.read(archive).firstOrNull { it.name.endsWith(".zip") }
                ?: throw InstallerError("The Samsung certificate extension did not contain an add-on package.")
            val jar = Zip.read(addon.data).firstOrNull { it.name.endsWith(".jar") }
                ?: throw InstallerError("The Samsung certificate extension did not contain a certificate manager.")
            val certs = Zip.read(jar.data).filter { it.name.matchesI("""\.(crt|cer)$""") }
            if (certs.isEmpty()) throw InstallerError("The Samsung certificate extension did not contain certificate authorities.")
            caDirectory.mkdirs()
            caMarker.delete()
            caDirectory.listFiles()?.filter { it.name.matchesI("""\.(crt|cer)$""") }?.forEach { it.delete() }
            certs.forEach { File(caDirectory, it.name.substringAfterLast('/')).writeBytes(it.data) }
            caMarker.writeText(repository)
        } finally {
            archive.delete()
        }
    }

    private suspend fun createCertificate(t: SamsungTransport, duid: String): Map<String, Any?> {
        val accessInfo = auth()
        val accessToken = accessInfo["access_token"] ?: accessInfo["accessToken"] ?: ""
        val userId = accessInfo["userId"] ?: accessInfo["user_id"] ?: ""
        if (accessToken.isEmpty() || userId.isEmpty()) throw InstallerError("Samsung did not return valid authorization data. Try signing in again.")
        val random = ByteArray(18).also { SecureRandom().nextBytes(it) }
        val password = Base64.getUrlEncoder().withoutPadding().encodeToString(random)
        val email = accessInfo["inputEmailID"].takeUnless { it.isNullOrEmpty() } ?: accessInfo["email"].takeUnless { it.isNullOrEmpty() } ?: userId
        val authorInfo = mapOf("name" to "Nuvio", "email" to email, "password" to password, "privilegeLevel" to "Partner")

        ensureAuthorities()
        emit("info", "Creating the Samsung certificate for this TV. This may take 30-60 seconds.")
        val requests = core("return __nuvioCore.createRequests(info, duids)", mapOf("info" to authorInfo, "duids" to listOf(duid))).asMap()
        val authorCsr = requests["author"].asMap()["csr"].str()
        val distributorCsr = requests["distributor"].asMap()["csr"].str()

        fun post(path: String, extra: List<Pair<String, String>>, csr: String, filename: String, label: String): String {
            val r = Http.multipart("https://svdca.samsungqbe.com/apis/v3/$path",
                listOf("access_token" to accessToken, "user_id" to userId, "platform" to "VD") + extra, "csr", filename, csr.toByteArray())
            if (!r.ok) throw InstallerError("Failed to fetch $label certificate\n${r.text}")
            return r.text
        }
        val distributorFields = listOf("privilege_level" to "Partner", "developer_type" to "Individual")
        val authorVD = post("authors", emptyList(), authorCsr, "author.csr", "author")
        val distributorXML = post("distributors", distributorFields, distributorCsr, "distributor.csr", "distributor")
        val distributorVD = post("distributors", distributorFields, distributorCsr, "distributor.csr", "distributor")

        val caTexts = CA_FILES.associateWith { try { File(caDirectory, it).readText() } catch (_: Exception) { "" } }
        val built = core("return __nuvioCore.buildPkcs12(req, a, d, info, ca)",
            mapOf("req" to requests, "a" to authorVD, "d" to distributorVD, "info" to authorInfo, "ca" to caTexts)).asMap()
        val authorCert = built["authorCert"].str()
        val distributorCert = built["distributorCert"].str()
        if (authorCert.isEmpty() || distributorCert.isEmpty()) throw InstallerError("Samsung did not return a valid certificate.")

        val certificateConfig = mapOf(
            "authorCert" to authorCert, "distributorCert" to distributorCert,
            "distributorXML" to if (distributorXML.isEmpty()) "" else Base64.getEncoder().encodeToString(distributorXML.toByteArray()),
            "password" to password, "duid" to duid, "createdAt" to isoNow()
        )
        if (!hasValidAuthorChain(certificateConfig)) {
            throw InstallerError("Samsung issued an author certificate that does not match the downloaded certificate authorities. " +
                "To avoid producing a WGT the TV would reject, the certificate was not saved; retry the install.")
        }
        writeConfig(configPathForDuid(duid), certificateConfig)
        writeConfig(configPath(t.target), certificateConfig)

        if (distributorXML.isNotEmpty()) {
            val profile = File(certDirectory, "${t.target.replace(Regex("[^a-z0-9_.-]+", RegexOption.IGNORE_CASE), "_")}-device-profile.xml")
            profile.writeText(distributorXML)
            try {
                ensureTempDirectory(t)
                push(t, profile, "/home/owner/share/tmp/sdk_tools/device-profile.xml")
            } catch (error: Exception) {
                emit("info", "Skipping Samsung device profile upload because the TV rejected the helper path: ${errorMessage(error)}")
            }
        }
        emit("success", "Samsung certificate created and saved for this TV.")
        return certificateConfig
    }

    private fun markSuccessful(t: SamsungTransport, duid: String, c: Map<String, Any?>, metadata: Map<String, String>) {
        if (duid.isEmpty() || !isUsable(c, duid)) return
        val persisted = c + mapOf("duid" to duid, "lastSuccessfulInstallAt" to isoNow(), "lastSuccessfulPackageId" to metadata["packageId"].orEmpty())
        try {
            writeConfig(configPathForDuid(duid), persisted)
            writeConfig(configPath(t.target), persisted)
            emit("success", "Saved the working Samsung signing identity for future updates on this TV DUID.")
        } catch (error: Exception) {
            emit("error", "The app was installed, but the working Samsung certificate could not be saved for the next update: ${errorMessage(error)}")
        }
    }

    private fun describe(c: Candidate, index: Int, total: Int): String {
        c.config["profileName"].str().takeIf { it.isNotEmpty() }?.let { return "Tizen Studio profile \"$it\"" }
        c.config["profileLabel"].str().takeIf { it.isNotEmpty() }?.let { return "Tizen Studio profile \"$it\" certificates" }
        val f = fingerprint(c.config).take(12)
        return "saved identity ${index + 1}/$total${if (f.isEmpty()) "" else " ($f)"}"
    }

    // MARK: Signing

    private suspend fun resign(packageFile: File, c: Map<String, Any?>): File {
        if (c["profileName"].str().isNotEmpty()) {
            throw InstallerError("Tizen Studio CLI was not found. Install Tizen Studio or leave the profile name empty to use the built-in signer.")
        }
        emit("info", "Automatically signing the WGT with the saved Samsung certificate.")
        val unsigned = Zip.read(packageFile).filter { !it.isDirectory && it.name != "author-signature.xml" && it.name != "signature1.xml" }
        val files = unsigned.map { mapOf("name" to it.name, "digest" to sha512Base64(it.data)) }
        val signed = core("return await __nuvioCore.sign(files, a, d, p)",
            mapOf("files" to files, "a" to c["authorCert"].str(), "d" to c["distributorCert"].str(), "p" to c["password"].str())).asList().map { it.asMap() }
        val byName = unsigned.associate { it.name to it.data }
        val output = signed.map { item ->
            val name = item["name"].str()
            val xml = item["xml"] as? String
            name to (xml?.toByteArray() ?: byName[name] ?: throw InstallerError("Signed package is missing $name."))
        }
        val base = packageFile.nameWithoutExtension
        val ext = packageFile.extension.ifEmpty { "wgt" }
        val target = File(File(Paths.userData, "resigned"), "$base-samsung-signed-${System.currentTimeMillis()}.$ext")
        Zip.write(output, target)
        emit("info", "Automatically signed WGT: ${target.path}")
        return target
    }

    // MARK: Install / launch / uninstall

    private suspend fun installPackage(t: SamsungTransport, packageFile: File): Map<String, String> {
        val metadata = metadata(packageFile)
        val installIds = candidates(listOf(metadata["packageId"], metadata["appId"]))
        if (installIds.isEmpty()) throw InstallerError("Unable to read the application id or package id from the Tizen package.")
        val remote = "/home/owner/share/tmp/sdk_tools/nuvio-package.${metadata["extension"].orEmpty().ifEmpty { "wgt" }}"
        emit("info", "Detected package id: ${metadata["packageId"].orEmpty()}")
        metadata["appId"]?.takeIf { it.isNotEmpty() }?.let { emit("info", "Detected application id: $it") }

        if (ensureTempDirectory(t)) {
            val cleanup = try {
                t.shell(emit, listOf("0", "rm", "-f", remote), SamsungTransport.ShellOptions(noOutputSuccessMs = 1500))
            } catch (error: Exception) {
                if (isClosedError(error)) "closed" else ""
            }
            if (isClosedOutput(cleanup)) emit("info", "Samsung TV closed the cleanup shell command; continuing because push can overwrite the package.")
        }
        push(t, packageFile, remote)
        verifyRemotePackage(t, packageFile, remote)
        return appInstall(t, metadata, installIds, remote)
    }

    /** vd_appinstall with the package id, then the app id, verifying the TV app list afterwards. */
    private suspend fun appInstall(t: SamsungTransport, metadata: Map<String, String>, installIds: List<String>, remote: String): Map<String, String> {
        var lastError: Exception? = null
        var certificateError: Exception? = null
        for (installId in installIds) {
            try {
                val out = t.shell(emit, listOf("0", "vd_appinstall", installId, remote),
                    SamsungTransport.ShellOptions(timeoutMs = 180_000, completeWhen = PACKAGE_COMMAND_COMPLETE))
                throwIfFailed(out, "vd_appinstall failed with $installId")
                verifyInstalled(t, metadata)
                return metadata
            } catch (error: Exception) {
                if (isPlatformIncompatibility(error)) throw platformIncompatibilityError(metadata["requiredVersion"].orEmpty())
                if (isCertificateRejection(error)) {
                    if (certificateError == null) certificateError = error
                    emit("info", "Samsung rejected $installId; trying the next Samsung identifier before reporting a certificate error.")
                    continue
                }
                lastError = error
                emit("error", "vd_appinstall with $installId failed: ${errorMessage(error)}")
                emit("info", "Trying the next Samsung identifier if available.")
            }
        }
        throw certificateError ?: lastError ?: InstallerError("vd_appinstall failed.")
    }

    /** What `sdb install` does on a TV: push with the checked sync protocol into sdk_toolpath, then vd_appinstall. */
    private suspend fun sdbInstall(t: SamsungTransport, packageFile: File): Map<String, String> {
        val metadata = metadata(packageFile)
        val installIds = candidates(listOf(metadata["packageId"], metadata["appId"]))
        if (installIds.isEmpty()) throw InstallerError("Unable to read the application id or package id from the Tizen package.")
        emit("command", "$ sdb -s ${t.target}:26101 install ${packageFile.path}")
        val caps = capabilities(t)
        val defaultDir = if (caps["platform_version"].orEmpty().startsWith("2.")) "/opt/usr/apps/tmp" else "/home/owner/share/tmp/sdk_tools"
        val dir = caps["sdk_toolpath"].takeUnless { it.isNullOrEmpty() }?.trimEnd('/') ?: defaultDir
        val remote = "$dir/nuvio-package.${metadata["extension"].orEmpty().ifEmpty { "wgt" }}"
        val data = packageFile.readBytes()
        t.pushChecked(remote, data)
        emit("stdout", "pushed ${packageFile.name} 100% (${data.size} bytes)")
        verifyRemotePackage(t, packageFile, remote)
        return appInstall(t, metadata, installIds, remote)
    }

    /** What `sdb uninstall` does on a TV: vd_appuninstall, decided by the app list afterwards. */
    private suspend fun uninstall(t: SamsungTransport) {
        val app = findInstalled(t, configuredIds) ?: throw InstallerError("Nuvio TV is not installed on this TV.")
        val ids = candidates(listOf(app["app_package_id"], app["package_id"], app["app_package_name"], app["app_id"], app["app_tizen_id"]) + configuredIds)
        var lastOutput = ""
        for (id in ids) {
            emit("command", "$ sdb -s ${t.target}:26101 uninstall $id")
            lastOutput = try {
                t.shell(emit, listOf("0", "vd_appuninstall", id),
                    SamsungTransport.ShellOptions(timeoutMs = 120_000, completeWhen = "spend time|uninstall completed|uninstall failed|can not uninstall"))
            } catch (error: Exception) {
                errorMessage(error)
            }
            if (findInstalled(t, configuredIds) == null) {
                emit("info", "Verified: Nuvio TV is no longer installed on the TV.")
                return
            }
            emit("info", "Nuvio TV is still installed after uninstalling $id; trying the next Samsung identifier if available.")
        }
        val line = lastOutput.lines2().map { it.trim() }.lastOrNull { it.isNotEmpty() }.orEmpty()
        throw InstallerError("The TV did not remove Nuvio TV${if (line.isEmpty()) " (no answer from vd_appuninstall)" else ": $line"}. " +
            "Remove it from the TV instead: Apps, Settings, Nuvio, Delete.")
    }

    private suspend fun launch(t: SamsungTransport) {
        val app = findInstalled(t, configuredIds)
        val launchId = app?.get("app_id") ?: app?.get("app_tizen_id") ?: configuredIds.firstOrNull()
        if (launchId.isNullOrEmpty()) throw InstallerError("Samsung app was not found. Install Nuvio or check appId in installer.config.json.")
        throwIfFailed(t.shell(emit, listOf("0", "was_execute", launchId)), "Samsung app launch failed")
    }

    /** startSamsungLogCapture: debug launch, then the CDP target on the TV. */
    suspend fun startLogs(ip: String): Map<String, Any?> {
        val t = connectTransport(ip)
        try {
            val app = findInstalled(t, configuredIds)
            val appId = candidates(listOf(app?.get("app_tizen_id"), app?.get("app_id")) + configuredIds).firstOrNull { it.contains(".") }
                ?: throw InstallerError("Samsung app was not found. Install Nuvio first.")
            val isTizen3 = compareTizenVersions(readPlatformVersion(t), "4.0") == -1
            val out = t.shell(emit, listOf("0", "debug", appId) + if (isTizen3) listOf("0") else emptyList(),
                SamsungTransport.ShellOptions(timeoutMs = 30_000, completeWhen = """debug[\s\S]*:\s*\d{2,5}"""))
            val port = if (out.matchesI("debug")) out.firstGroup(""":\s*(\d{2,5})""")?.toIntOrNull() ?: 0 else 0
            if (port == 0) {
                throw InstallerError("Samsung TV did not open a debug port. Check that Host PC IP on the TV matches this computer. Output: ${out.trim().ifEmpty { "(empty)" }}")
            }
            emit("info", "Nuvio started in debug mode on port $port.")
            var lastError: Exception? = null
            repeat(10) {
                try {
                    val targets = parseJson(Http.get("http://$ip:$port/json", timeoutMs = 3000).text).asList().map { it.asMap() }
                    val ws = targets.firstOrNull { it["webSocketDebuggerUrl"] != null }?.get("webSocketDebuggerUrl").str()
                    val path = java.net.URI(ws).path
                    if (path.isNullOrEmpty()) throw InstallerError("Invalid URL")
                    return mapOf("ok" to true, "wsUrl" to "ws://$ip:$port$path")
                } catch (error: Exception) {
                    lastError = error
                    delay(1000)
                }
            }
            throw InstallerError("Unable to reach the app inspector on $ip:$port: ${lastError?.let(::errorMessage).orEmpty()}")
        } finally {
            t.close()
        }
    }

    suspend fun run(action: String, options: Map<String, Any?>) {
        val ip = requireValue(options["ip"].str(), "IP Samsung TV")
        val t = connectTransport(ip)
        try {
            when (action) {
                "uninstall" -> { uninstall(t); return }
                "launch" -> { launch(t); return }
                "update" -> {
                    val app = findInstalled(t, configuredIds)
                    if (Releases.isAlreadyUpToDate(config, emit, app?.get("app_version").orEmpty().trim(), options["releaseId"].str())) return
                }
            }

            val packagePathOption = options["packagePath"].str()
            val packageFile = if (packagePathOption.isEmpty()) Releases.resolveAsset(config, emit, "tizen", options["releaseId"].str()) else File(packagePathOption)
            val (preparedPath, duid, list) = prepare(t, packageFile, options)
            var directInstallError: Exception? = null
            var lastInstallPath: File? = null
            var activeConfig: Map<String, Any?>? = null

            for ((index, candidate) in list.withIndex()) {
                val description = describe(candidate, index, list.size)
                emit("info", "Signing Samsung package with $description.")
                val installPath = try {
                    resign(preparedPath, candidate.config)
                } catch (error: Exception) {
                    if (index + 1 < list.size) {
                        emit("info", "Could not use $description; trying the next saved identity. ${errorMessage(error)}")
                        continue
                    }
                    throw error
                }
                lastInstallPath = installPath
                activeConfig = candidate.config
                try {
                    val installed = installPackage(t, installPath)
                    markSuccessful(t, duid, candidate.config, installed)
                    directInstallError = null
                    break
                } catch (error: Exception) {
                    directInstallError = error
                    if (isCertificateRejection(error) && index + 1 < list.size) {
                        emit("info", "Samsung rejected $description; retrying with the previous signing identity saved for this TV DUID.")
                        continue
                    }
                    break
                }
            }

            directInstallError?.let { error ->
                if (isPlatformIncompatibility(error)) throw error
                if (isCertificateRejection(error)) {
                    throw InstallerError("${errorMessage(error)}\n\nTried ${list.size} saved signing ${if (list.size == 1) "identity" else "identities"} for this TV. " +
                        "The TV did not accept any available signing identity. Keep the working author certificate for future updates and, if this is a new installation, verify the Samsung certificate/profile and TV DUID.")
                }
                emit("error", "Samsung direct package install failed before fallback: ${errorMessage(error)}")
                emit("info", "vd_appinstall failed on direct connection, trying fallback with sdb install.")
                t.close()
                val installPath = lastInstallPath ?: throw error
                val fallback = connectTransport(ip)
                try {
                    val installed = sdbInstall(fallback, installPath)
                    markSuccessful(fallback, duid, activeConfig ?: emptyMap(), installed)
                } finally {
                    fallback.close()
                }
            }

            emit("info", "If you want to use debug/autolaunch, set Host PC IP to 127.0.0.1 on the TV after installation.")
        } finally {
            t.close()
        }
    }
}
