package space.nuvio.webtvinstaller

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.URL
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Base64
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream

/** Mirrors Node errors from the desktop installer (message plus optional code/stdout/stderr). */
class InstallerError(
    message: String,
    val code: String? = null,
    val stdout: String = "",
    val stderr: String = ""
) : Exception(message)

fun errorMessage(error: Throwable): String = error.message ?: error.toString()

typealias Emit = (type: String, text: String) -> Unit

class InstallerConfig(json: JSONObject) {
    class Platform(json: JSONObject) {
        val appId: String = json.optString("appId")
        val assetPattern: String = json.optString("assetPattern")
        val packageId: String = json.optString("packageId")
        val appIds: List<String> = json.optJSONArray("appIds")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
    }
    val githubRepo: String = json.getString("githubRepo")
    val webos = Platform(json.getJSONObject("webos"))
    val tizen = Platform(json.getJSONObject("tizen"))
}

/** Equivalent of Electron app.getPath("userData") and os.homedir(). */
object Paths {
    lateinit var userData: File
    lateinit var temp: File
    val home: File get() = File(userData, "home")

    fun init(filesDir: File, cacheDir: File) {
        userData = File(filesDir, "Nuvio TV Installer").apply { mkdirs() }
        temp = cacheDir
    }
}

fun requireValue(value: String?, label: String): String {
    val normalized = value.orEmpty().trim()
    if (normalized.isEmpty()) throw InstallerError("$label is required.")
    return normalized
}

fun sha256Hex(data: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }

fun sha512Base64(data: ByteArray): String =
    Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-512").digest(data))

fun isoNow(): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
    .apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())

fun parseIsoDate(value: String?): Double {
    if (value.isNullOrEmpty()) return 0.0
    for (pattern in listOf("yyyy-MM-dd'T'HH:mm:ss.SSSX", "yyyy-MM-dd'T'HH:mm:ssX")) {
        try {
            return SimpleDateFormat(pattern, Locale.US).parse(value)?.time?.toDouble() ?: continue
        } catch (_: Exception) {}
    }
    return 0.0
}

fun String.matchesI(pattern: String): Boolean = Regex(pattern, RegexOption.IGNORE_CASE).containsMatchIn(this)
fun String.firstGroup(pattern: String): String? = Regex(pattern, RegexOption.IGNORE_CASE).find(this)?.groupValues?.getOrNull(1)
fun String.lines2(): List<String> = split("\n").map { it.removeSuffix("\r") }

// MARK: Versions (compareTizenVersions)

fun parseTizenVersion(value: String): List<Int> {
    val m = Regex("""\b(\d+)(?:\.(\d+))?(?:\.(\d+))?\b""").find(value) ?: return emptyList()
    return (1..3).map { m.groupValues[it].toIntOrNull() ?: 0 }
}

fun compareTizenVersions(left: String, right: String): Int? {
    val l = parseTizenVersion(left)
    val r = parseTizenVersion(right)
    if (l.isEmpty() || r.isEmpty()) return null
    for (i in 0 until 3) if (l[i] != r[i]) return if (l[i] > r[i]) 1 else -1
    return 0
}

// MARK: JSON helpers (org.json <-> Kotlin)

fun fromJson(value: Any?): Any? = when (value) {
    null, JSONObject.NULL -> null
    is JSONObject -> value.keys().asSequence().associateWith { fromJson(value.get(it)) }
    is JSONArray -> (0 until value.length()).map { fromJson(value.get(it)) }
    else -> value
}

fun parseJson(text: String): Any? = fromJson(org.json.JSONTokener(text).nextValue())

fun toJson(value: Any?): String = when (value) {
    null -> "null"
    is String -> JSONObject.quote(value)
    else -> JSONObject.wrap(value)?.toString() ?: "null"
}

@Suppress("UNCHECKED_CAST")
fun Any?.asMap(): Map<String, Any?> = this as? Map<String, Any?> ?: emptyMap()
@Suppress("UNCHECKED_CAST")
fun Any?.asList(): List<Any?> = this as? List<Any?> ?: emptyList()
fun Any?.str(): String = when (this) {
    null -> ""
    is String -> this
    is Double -> if (this % 1.0 == 0.0) toLong().toString() else toString()
    else -> toString()
}

// MARK: HTTP

object Http {
    class Response(val status: Int, val body: ByteArray) {
        val text: String get() = String(body, Charsets.UTF_8)
        val ok: Boolean get() = status in 200..299
    }

    private fun open(url: String, headers: Map<String, String>, timeoutMs: Int): HttpURLConnection {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = timeoutMs
        c.readTimeout = timeoutMs
        c.instanceFollowRedirects = true
        headers.forEach { (k, v) -> c.setRequestProperty(k, v) }
        return c
    }

    fun get(url: String, headers: Map<String, String> = emptyMap(), timeoutMs: Int = 60_000): Response {
        val c = open(url, headers, timeoutMs)
        try {
            val status = c.responseCode
            val stream = if (status in 200..399) c.inputStream else c.errorStream
            return Response(status, stream?.use { it.readBytes() } ?: ByteArray(0))
        } finally {
            c.disconnect()
        }
    }

    fun statusText(code: Int): String = when (code) {
        400 -> "Bad Request"; 401 -> "Unauthorized"; 403 -> "Forbidden"; 404 -> "Not Found"
        429 -> "Too Many Requests"; 500 -> "Internal Server Error"; 502 -> "Bad Gateway"; 503 -> "Service Unavailable"
        else -> ""
    }

    fun fetchJson(url: String): Any? {
        val r = get(url, mapOf("Accept" to "application/vnd.github+json", "User-Agent" to "Nuvio-TV-Installer"))
        if (!r.ok) throw InstallerError("GitHub request failed: ${r.status} ${statusText(r.status)}")
        return parseJson(r.text)
    }

    fun downloadFile(emit: Emit, url: String, target: File, progressLabel: String? = null) {
        emit("info", "Download $url")
        val c = open(url, mapOf("User-Agent" to "Nuvio-TV-Installer"), 60_000)
        try {
            val status = c.responseCode
            if (status !in 200..299) throw InstallerError("Download failed: $status ${statusText(status)}")
            target.parentFile?.mkdirs()
            val total = c.contentLengthLong
            val tmp = File(target.parentFile, target.name + ".part")
            var received = 0L
            var lastPercent = 0
            c.inputStream.use { input ->
                tmp.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        received += n
                        if (progressLabel != null && total > 0) {
                            val percent = (received * 100 / total).toInt()
                            if (percent >= lastPercent + 10) {
                                lastPercent = percent
                                emit("info", "$progressLabel: $percent%")
                            }
                        }
                    }
                }
            }
            if (!tmp.renameTo(target)) { tmp.copyTo(target, overwrite = true); tmp.delete() }
        } finally {
            c.disconnect()
        }
    }

    fun multipart(url: String, fields: List<Pair<String, String>>, fileField: String, fileName: String, fileData: ByteArray): Response {
        val boundary = "--------------------------" + (100000000000L..999999999999L).random()
        val body = ByteArrayOutputStream()
        for ((k, v) in fields) {
            body.write("--$boundary\r\nContent-Disposition: form-data; name=\"$k\"\r\n\r\n$v\r\n".toByteArray())
        }
        body.write("--$boundary\r\nContent-Disposition: form-data; name=\"$fileField\"; filename=\"$fileName\"\r\nContent-Type: application/octet-stream\r\n\r\n".toByteArray())
        body.write(fileData)
        body.write("\r\n--$boundary--\r\n".toByteArray())
        val c = open(url, mapOf("Content-Type" to "multipart/form-data; boundary=$boundary"), 120_000)
        try {
            c.requestMethod = "POST"
            c.doOutput = true
            c.outputStream.use { it.write(body.toByteArray()) }
            val status = c.responseCode
            val stream = if (status in 200..399) c.inputStream else c.errorStream
            return Response(status, stream?.use { it.readBytes() } ?: ByteArray(0))
        } finally {
            c.disconnect()
        }
    }
}

// MARK: Releases (same logic as main.js)

object Releases {
    private fun assetFor(release: Map<String, Any?>, pattern: String): Map<String, Any?>? =
        release["assets"].asList().map { it.asMap() }.firstOrNull { it["name"].str().matchesI(pattern) }

    fun normalizePlatform(platform: String): String = when (val n = platform.trim().lowercase()) {
        "lg" -> "webos"; "samsung" -> "tizen"; else -> n
    }

    private fun platformConfig(config: InstallerConfig, platform: String) = when (platform) {
        "webos" -> config.webos; "tizen" -> config.tizen; else -> null
    }

    fun recent(config: InstallerConfig, platform: String, limit: Int = 3): List<Map<String, Any?>> {
        val releasePlatform = normalizePlatform(platform)
        val pc = platformConfig(config, releasePlatform) ?: throw InstallerError("Unsupported platform: $platform")
        val releases = Http.fetchJson("https://api.github.com/repos/${config.githubRepo}/releases?per_page=20").asList().map { it.asMap() }
        return releases
            .filter { it["draft"] != true && assetFor(it, pc.assetPattern) != null }
            .take(limit)
            .map { r ->
                val tag = r["tag_name"].str()
                val name = r["name"].str().ifEmpty { tag }
                mapOf("id" to r["id"], "tagName" to tag, "name" to name, "publishedAt" to r["published_at"], "prerelease" to (r["prerelease"] == true))
            }
    }

    private fun releaseUrl(config: InstallerConfig, releaseId: String?): Pair<String, String> {
        val id = releaseId.orEmpty().trim()
        if (id.isNotEmpty() && !Regex("^\\d+$").matches(id)) throw InstallerError("Invalid GitHub release selection.")
        val url = if (id.isEmpty()) "https://api.github.com/repos/${config.githubRepo}/releases/latest"
        else "https://api.github.com/repos/${config.githubRepo}/releases/$id"
        return url to id
    }

    fun resolveAsset(config: InstallerConfig, emit: Emit, platform: String, releaseId: String?): File {
        val (url, id) = releaseUrl(config, releaseId)
        val release = Http.fetchJson(url).asMap()
        val pc = platformConfig(config, platform)!!
        val tag = release["tag_name"].str().ifEmpty { id.ifEmpty { "latest" } }
        val asset = assetFor(release, pc.assetPattern)
            ?: throw InstallerError("No $platform package was found in GitHub release $tag.")
        val cacheKey = tag.replace(Regex("[^a-z0-9._-]+", RegexOption.IGNORE_CASE), "-")
        val target = File(File(File(Paths.userData, "packages"), cacheKey), asset["name"].str())
        if (target.canRead()) {
            emit("info", "Using already downloaded package: ${target.path}")
        } else {
            Http.downloadFile(emit, asset["browser_download_url"].str(), target)
        }
        return target
    }

    private fun version(config: InstallerConfig, releaseId: String?): String {
        val (url, _) = releaseUrl(config, releaseId)
        return Http.fetchJson(url).asMap()["tag_name"].str().replace(Regex("^v", RegexOption.IGNORE_CASE), "")
    }

    /** isAlreadyUpToDate from main.js. */
    fun isAlreadyUpToDate(config: InstallerConfig, emit: Emit, installed: String, releaseId: String?): Boolean {
        if (installed.isEmpty()) {
            emit("info", "Nuvio TV is not installed on this TV; installing it.")
            return false
        }
        val target = version(config, releaseId)
        val c = compareTizenVersions(installed, target)
        if (c != null && c >= 0) {
            emit("info", "Nuvio TV $installed is already installed (release $target); nothing to update.")
            return true
        }
        emit("info", "Updating Nuvio TV from $installed to $target.")
        return false
    }
}

// MARK: ZIP helpers (central directory order, like JSZip)

class ZipEntryData(val name: String, val isDirectory: Boolean, val data: ByteArray)

object Zip {
    fun read(file: File): List<ZipEntryData> = ZipFile(file).use { zip ->
        zip.entries().asSequence().map { e ->
            ZipEntryData(e.name, e.isDirectory, if (e.isDirectory) ByteArray(0) else zip.getInputStream(e).use { it.readBytes() })
        }.toList()
    }

    fun read(data: ByteArray): List<ZipEntryData> {
        val tmp = File.createTempFile("nuvio-zip", ".zip", Paths.temp)
        try {
            tmp.writeBytes(data)
            return read(tmp)
        } finally {
            tmp.delete()
        }
    }

    fun write(files: List<Pair<String, ByteArray>>, target: File) {
        target.parentFile?.mkdirs()
        ZipOutputStream(target.outputStream().buffered()).use { out ->
            out.setMethod(ZipOutputStream.DEFLATED)
            for ((name, data) in files) {
                out.putNextEntry(ZipEntry(name))
                out.write(data)
                out.closeEntry()
            }
        }
    }
}

// MARK: Local IPv4 (os.networkInterfaces)

fun localIPv4Addresses(): List<String> = try {
    NetworkInterface.getNetworkInterfaces().toList()
        .filter { it.isUp && !it.isLoopback }
        .flatMap { it.inetAddresses.toList() }
        .filterIsInstance<Inet4Address>()
        .map { it.hostAddress ?: "" }
        .filter { it.isNotEmpty() && !it.startsWith("169.254.") }
} catch (_: Exception) {
    emptyList()
}
