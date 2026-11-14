package space.nuvio.webtvinstaller

import com.jcraft.jsch.ChannelExec
import com.jcraft.jsch.ChannelSftp
import com.jcraft.jsch.JSch
import com.jcraft.jsch.JSchException
import com.jcraft.jsch.KeyPair
import com.jcraft.jsch.Session
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.security.MessageDigest

/**
 * runLg / device profile handling from main.js. The webOS CLI (ares-*) is replaced by the same
 * operations done natively: novacom-devices.json profiles, the :9991 key download and SSH + luna-send.
 */
object LG {
    private val dataDir get() = File(Paths.home, ".webos/tv")
    private val sshDir get() = File(Paths.home, ".ssh")
    private val devicesFile get() = File(dataDir, "novacom-devices.json")
    private const val NO_KEY = "No usable SSH key was found for this LG device. Enter the TV IP and current Developer Mode passphrase, then press Install to create or overwrite the saved profile."

    // MARK: Device store

    fun readDevices(): MutableList<MutableMap<String, Any?>> = try {
        parseJson(devicesFile.readText()).asList().map { it.asMap().toMutableMap() }.toMutableList()
    } catch (_: Exception) {
        mutableListOf()
    }

    private fun writeDevices(devices: List<Map<String, Any?>>) {
        dataDir.mkdirs()
        devicesFile.writeText(JSONArray(devices.map { JSONObject(it) }).toString(2))
    }

    private fun keyName(entry: Map<String, Any?>) = entry["privateKey"].asMap()["openSsh"].str().trim()
    private fun isDefault(entry: Map<String, Any?>) = entry["default"] == true || entry["default"].str().lowercase() == "true"
    private fun keyReadable(name: String) = name.isNotEmpty() && File(sshDir, name).canRead()

    fun listRegistered(): List<Map<String, Any?>> {
        val unique = LinkedHashMap<String, Map<String, Any?>>()
        fun score(d: Map<String, Any?>) = (if (d["keyReady"] == true) 2 else 0) + (if (d["default"] == true) 1 else 0)
        for (entry in readDevices()) {
            val name = entry["name"].str().trim()
            if (name.isEmpty()) continue
            val device = mapOf(
                "name" to name, "host" to entry["host"].str().trim(), "default" to isDefault(entry),
                "keyReady" to keyReadable(keyName(entry)), "removable" to (entry["indelible"] != true)
            )
            val key = name.lowercase()
            if (score(device) > (unique[key]?.let(::score) ?: -1)) unique[key] = device
        }
        return unique.values.sortedWith(compareByDescending<Map<String, Any?>> { it["default"] == true }.thenBy { it["name"].str() })
    }

    private fun defaultDeviceName(ip: String): String {
        val slug = ip.trim().replace(Regex("[^a-z0-9]+", RegexOption.IGNORE_CASE), "-").trim('-')
        return "nuvio-lg-${slug.ifEmpty { "tv" }}"
    }

    private fun infoArgs(host: String) = listOf("--info", "username=prisoner", "--info", "host=$host", "--info", "port=9922", "--info", "default=true")

    private fun command(emit: Emit, cmd: String, args: List<String>) {
        val shown = args.mapIndexed { i, a -> if (i > 0 && args[i - 1] == "--passphrase") "********" else a }
        emit("command", "$ $cmd ${shown.joinToString(" ")}")
    }

    /** ares-setup-device --add/--modify (makes the profile the default one, like default=true). */
    private fun setupDevice(name: String, host: String) {
        val devices = readDevices().onEach { it["default"] = false }
        val existing = devices.firstOrNull { it["name"].str() == name }
        if (existing != null) {
            existing["host"] = host; existing["port"] = 9922; existing["username"] = "prisoner"; existing["default"] = true
        } else {
            devices.add(mutableMapOf("name" to name, "host" to host, "port" to 9922, "username" to "prisoner", "profile" to "tv",
                "type" to "starfish", "description" to "new device", "default" to true, "files" to "stream"))
        }
        writeDevices(devices)
    }

    private fun removeDevice(name: String) {
        val devices = readDevices()
        devices.filter { it["name"].str() == name }.forEach { d -> keyName(d).takeIf { it.isNotEmpty() }?.let { File(sshDir, it).delete() } }
        writeDevices(devices.filter { it["name"].str() != name })
    }

    // MARK: Profile resolution (same as main.js)

    class ResolvedDevice(val name: String, val host: String, val keyFile: File, val passphrase: String)

    private fun findExistingWithKey(deviceName: String, host: String, allowDifferentHostForName: Boolean): ResolvedDevice? {
        val withKeys = readDevices().filter { keyName(it).isNotEmpty() }
        val hostMatches = if (host.isEmpty()) withKeys else withKeys.filter { it["host"].str() == host }
        var device = if (deviceName.isEmpty()) null else hostMatches.firstOrNull { it["name"].str() == deviceName }
        if (device == null && allowDifferentHostForName && deviceName.isNotEmpty()) device = withKeys.firstOrNull { it["name"].str() == deviceName }
        if (device == null && deviceName.isEmpty() && host.isEmpty()) device = hostMatches.firstOrNull(::isDefault)
        if (device == null) device = hostMatches.firstOrNull()
        val d = device ?: return null
        val keyFile = File(sshDir, keyName(d))
        if (!keyFile.canRead()) return null
        return ResolvedDevice(d["name"].str(), d["host"].str(), keyFile, d["passphrase"].str())
    }

    private fun resolveExisting(emit: Emit, requestedName: String, ip: String): String {
        val deviceName = requestedName.trim()
        val host = ip.trim()
        val existing = findExistingWithKey(deviceName, host, deviceName.isNotEmpty() && host.isNotEmpty()) ?: throw InstallerError(NO_KEY)
        if (deviceName.isEmpty() && host.isEmpty()) {
            emit("info", "Using saved LG webOS device profile: ${if (existing.host.isEmpty()) existing.name else "${existing.name} (${existing.host})"}.")
        }
        if (deviceName.isNotEmpty() && host.isNotEmpty() && existing.name == deviceName && existing.host != host) {
            emit("info", "Updating LG device profile \"$deviceName\" from ${existing.host.ifEmpty { "unknown host" }} to $host.")
            command(emit, "ares-setup-device", listOf("--modify", deviceName) + infoArgs(host))
            setupDevice(deviceName, host)
            emit("success", "LG device IP updated.")
        }
        return existing.name
    }

    private fun downloadKey(host: String): String {
        val r = try { Http.get("http://$host:9991/webos_rsa", timeoutMs = 10_000) } catch (_: Exception) { null }
        if (r == null || !r.ok || r.body.isEmpty()) {
            throw InstallerError("Failed to get the SSH private key from $host:9991. Check that Developer Mode is enabled and Key Server is ON.")
        }
        return r.text
    }

    private fun validateKey(pem: String, passphrase: String) {
        val key = KeyPair.load(JSch(), pem.toByteArray(), null)
        if (key.isEncrypted && !key.decrypt(passphrase)) throw InstallerError("Wrong Developer Mode passphrase for the saved SSH key.")
    }

    private fun configure(emit: Emit, ip: String, requestedName: String, passphrase: String): String {
        val host = requireValue(ip, "IP LG TV")
        val deviceName = requestedName.trim().ifEmpty { defaultDeviceName(host) }
        emit("info", "Automatically configuring LG webOS device: $deviceName")
        val matching = readDevices().filter { it["name"].str() == deviceName }
        val canReplace = matching.isNotEmpty() && matching.all { it["indelible"] != true }
        when {
            canReplace -> {
                emit("info", "Replacing existing LG device profile \"$deviceName\" and its saved authentication.")
                command(emit, "ares-setup-device", listOf("--remove", deviceName)); removeDevice(deviceName)
                command(emit, "ares-setup-device", listOf("--add", deviceName) + infoArgs(host)); setupDevice(deviceName, host)
            }
            matching.isNotEmpty() -> {
                emit("info", "Updating protected LG device profile \"$deviceName\".")
                command(emit, "ares-setup-device", listOf("--modify", deviceName) + infoArgs(host)); setupDevice(deviceName, host)
            }
            else -> {
                command(emit, "ares-setup-device", listOf("--add", deviceName) + infoArgs(host)); setupDevice(deviceName, host)
            }
        }
        emit("info", "Downloading and overwriting the SSH key for \"$deviceName\".")
        command(emit, "ares-novacom", listOf("--device", deviceName, "--getkey", "--passphrase", passphrase))
        val pem = downloadKey(host)
        validateKey(pem, passphrase)
        sshDir.mkdirs()
        val keyFileName = "${deviceName}_webos"
        val keyFile = File(sshDir, keyFileName)
        keyFile.writeText(pem)
        val devices = readDevices()
        devices.filter { it["name"].str() == deviceName }.forEach {
            it["privateKey"] = mapOf("openSsh" to keyFileName)
            it["passphrase"] = passphrase
        }
        writeDevices(devices)
        emit("stdout", "SSH Private Key: ${keyFile.path}")
        emit("success", "LG profile and SSH key saved.")
        return deviceName
    }

    fun delete(emit: Emit, requestedName: String) {
        val deviceName = requireValue(requestedName, "LG device name")
        val matching = readDevices().filter { it["name"].str() == deviceName }
        if (matching.isEmpty()) throw InstallerError("LG device profile \"$deviceName\" was not found.")
        if (matching.any { it["indelible"] == true }) throw InstallerError("LG device profile \"$deviceName\" is protected by the webOS CLI and cannot be deleted.")
        command(emit, "ares-setup-device", listOf("--remove", deviceName))
        removeDevice(deviceName)
        emit("success", "LG device profile \"$deviceName\" deleted.")
    }

    // MARK: runLg

    fun run(config: InstallerConfig, emit: Emit, action: String, options: Map<String, Any?>) {
        val ip = options["ip"].str().trim()
        val passphrase = options["lgPassphrase"].str().trim()
        val deviceName = options["deviceName"].str()
        val device = if (passphrase.isEmpty()) resolveExisting(emit, deviceName, ip) else configure(emit, ip, deviceName, passphrase)
        val profile = findExistingWithKey(device, "", true) ?: throw InstallerError(NO_KEY)
        val appId = config.webos.appId

        when (action) {
            "launch" -> {
                command(emit, "ares-launch", listOf("--device", device, appId))
                withSession(profile, "ares-launch", emit) { s ->
                    val out = exec(s, "/usr/bin/luna-send-pub -n 1 -f luna://com.webos.applicationManager/launch ${sh("""{"id":"$appId"}""")}")
                    if (!out.contains("\"returnValue\":true") && !out.contains("\"returnValue\": true")) {
                        throw toolFailure(emit, "ares-launch", "[com.webos.applicationManager failure]: luna-send command failed ${lunaReason(out)}")
                    }
                    emit("stdout", "[Info] Set target device : $device\nLaunched application $appId")
                }
                return
            }
            "uninstall" -> {
                command(emit, "ares-install", listOf("--device", device, "--remove", appId))
                withSession(profile, "ares-install", emit) { s ->
                    val failure = lunaSubscribe(s, "luna://com.webos.appInstallService/dev/remove", """{"id":"$appId","subscribe":true}""", "removed|^SUCCESS")
                    if (failure != null) throw toolFailure(emit, "ares-install", "[com.webos.appInstallService failure]: luna-send command failed $failure")
                    emit("stdout", "Removing package $appId\nSuccess")
                }
                return
            }
            "update" -> {
                val installed = withSession(profile, "ares-install", emit) { s ->
                    listedVersion(exec(s, "/usr/bin/luna-send-pub -n 1 -f luna://com.webos.applicationManager/dev/listApps '{}'"), appId)
                }
                if (Releases.isAlreadyUpToDate(config, emit, installed, options["releaseId"].str())) return
            }
        }

        val packagePathOption = options["packagePath"].str()
        val packageFile = if (packagePathOption.isEmpty()) Releases.resolveAsset(config, emit, "webos", options["releaseId"].str()) else File(packagePathOption)
        command(emit, "ares-install", listOf("--device", device, packageFile.path))
        try {
            withSession(profile, "ares-install", emit) { s -> install(s, emit, packageFile) }
        } catch (error: InstallerError) {
            if (passphrase.isEmpty() && "${error.message}\n${error.stderr}".matchesI("authentication methods failed|ssh exec failure")) {
                throw InstallerError("LG authentication failed for device \"$device\". Enter the current Developer Mode passphrase and press Install again to overwrite the saved profile and SSH key.")
            }
            throw error
        }
    }

    // MARK: SSH + luna-send (what ares-install / ares-launch do on the TV)

    private fun toolFailure(emit: Emit, tool: String, detail: String): InstallerError {
        val stderr = "$tool ERR! $detail"
        emit("stderr", stderr)
        return InstallerError("$tool exited with code 1", code = "1", stderr = stderr)
    }

    private fun <T> withSession(profile: ResolvedDevice, tool: String, emit: Emit, body: (Session) -> T): T {
        val session: Session
        try {
            val jsch = JSch()
            jsch.addIdentity("webos", profile.keyFile.readBytes(), null, profile.passphrase.toByteArray())
            session = jsch.getSession("prisoner", profile.host, 9922)
            session.setConfig("StrictHostKeyChecking", "no") // same as ares: TV host keys are not pinned
            session.setConfig("PreferredAuthentications", "publickey")
            // webOS TVs run old and new dropbear builds: accept both SHA-1 and SHA-2 RSA signatures.
            session.setConfig("server_host_key", "${session.getConfig("server_host_key")},ssh-rsa")
            session.setConfig("PubkeyAcceptedAlgorithms", "rsa-sha2-512,rsa-sha2-256,ssh-rsa")
            session.connect(20_000)
        } catch (error: Exception) {
            val text = errorMessage(error)
            val auth = error is JSchException && text.matchesI("auth|passphrase|invalid privatekey")
            throw toolFailure(emit, tool, if (auth) "[ssh exec failure]: All configured authentication methods failed ($text)"
            else "[Tips]: Unable to connect to the target device ${profile.host}:9922 ($text)")
        }
        try {
            return body(session)
        } finally {
            session.disconnect()
        }
    }

    private fun sh(s: String) = "'" + s.replace("'", "'\\''") + "'"

    private fun exec(session: Session, command: String): String {
        val channel = session.openChannel("exec") as ChannelExec
        channel.setCommand(command)
        val input = channel.inputStream
        channel.connect(20_000)
        try {
            return input.readBytes().toString(Charsets.UTF_8)
        } finally {
            channel.disconnect()
        }
    }

    private fun lunaReason(output: String) =
        output.firstGroup(""""errorText"\s*:\s*"([^"]*)"""") ?: output.firstGroup(""""reason"\s*:\s*"([^"]*)"""") ?: output.trim()

    private fun states(text: String) = Regex(""""state"\s*:\s*"([^"]*)"""").findAll(text).map { it.groupValues[1] }.toList()

    /** Subscribes like ares (luna-send -i) and returns null on success or the failure reason. */
    private fun lunaSubscribe(session: Session, uri: String, param: String, success: String): String? {
        val channel = session.openChannel("exec") as ChannelExec
        channel.setCommand("/usr/bin/luna-send-pub -i $uri ${sh(param)}")
        val input = channel.inputStream
        channel.connect(20_000)
        try {
            val text = StringBuilder()
            val buf = ByteArray(4096)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                text.append(String(buf, 0, n, Charsets.UTF_8))
                val all = text.toString()
                for (state in states(all)) {
                    if (state.matchesI("FAILED")) return lunaReason(all).ifEmpty { state }
                    if (state.matchesI(success)) return null
                }
                if (all.contains("\"returnValue\":false") || all.contains("\"returnValue\": false")) return lunaReason(all)
            }
            return "luna-send closed before completion"
        } finally {
            channel.disconnect()
        }
    }

    private fun listedVersion(output: String, appId: String): String =
        parseJson(output.trim().ifEmpty { "{}" }).asMap()["apps"].asList().map { it.asMap() }.firstOrNull { it["id"].str() == appId }?.get("version").str()

    private fun install(session: Session, emit: Emit, packageFile: File) {
        val tempDir = "/media/developer/temp"
        val ipk = packageFile.readBytes()
        val remote = "$tempDir/${packageFile.name}"
        exec(session, "/usr/bin/test -d $tempDir || /bin/mkdir -p $tempDir")
        emit("stdout", "Installing package ${packageFile.path}")

        val sftp = session.openChannel("sftp") as ChannelSftp
        sftp.connect(20_000)
        try {
            sftp.put(ByteArrayInputStream(ipk), remote, ChannelSftp.OVERWRITE)
        } finally {
            sftp.disconnect()
        }

        // Same transfer check as ares-install: md5 of the last 200 bytes.
        val srcMd5 = MessageDigest.getInstance("MD5").digest(ipk.copyOfRange(maxOf(0, ipk.size - 200), ipk.size)).joinToString("") { "%02x".format(it) }
        val dstMd5 = exec(session, "/usr/bin/tail -c 200 ${sh(remote)} | /usr/bin/md5sum").trim().split(' ', '-').firstOrNull().orEmpty()
        if (dstMd5.isNotEmpty() && dstMd5 != srcMd5) throw toolFailure(emit, "ares-install", "[Tips]: Failed to transmit package file")

        val failure = lunaSubscribe(session, "luna://com.webos.appInstallService/dev/install",
            """{"id":"com.ares.defaultName","ipkUrl":"$remote","subscribe":true}""", "installed|^SUCCESS")
        exec(session, "/bin/rm -f ${sh(remote)}")
        if (failure != null) throw toolFailure(emit, "ares-install", "[com.webos.appInstallService failure]: luna-send command failed $failure")
        emit("stdout", "Success")
    }
}
