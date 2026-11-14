package com.nuvio.installer

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeout
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder

/** waitForSamsungAccessInfo: local callback server on port 4794 receiving the Samsung OAuth redirect. */
class SamsungAuthServer {
    companion object {
        const val AUTH_URL = "https://account.samsung.com/mobile/account/check.do?serviceID=v285zxnl3h&actionID=StartOAuth2&accessToken=Y&redirect_uri=http://localhost:4794/signin/callback"

        fun query(s: String): Map<String, String> {
            val out = LinkedHashMap<String, String>()
            for (pair in s.split('&')) {
                if (pair.isEmpty()) continue
                val kv = pair.split('=', limit = 2).map { try { URLDecoder.decode(it, "UTF-8") } catch (_: Exception) { it } }
                if (kv[0].isNotEmpty() && kv[0] !in out) out[kv[0]] = kv.getOrElse(1) { "" }
            }
            return out
        }

        /** parseSamsungAccessInfo: JSON object or query string. */
        fun parseAccessInfo(raw: String?): Map<String, String>? {
            val value = raw?.trim().orEmpty()
            if (value.isEmpty()) return null
            try {
                val obj = parseJson(value)
                if (obj is Map<*, *>) return obj.asMap().mapValues { it.value.str() }
            } catch (_: Exception) {}
            return query(value).takeIf { it.isNotEmpty() }
        }

        fun hasAccessInfo(info: Map<String, String>?) = !(info?.get("access_token") ?: info?.get("accessToken")).isNullOrEmpty()

        fun extract(target: String, body: String): Map<String, String>? {
            val q = query(target.substringAfter('?', ""))
            parseAccessInfo(q["code"] ?: q["accessInfo"])?.let { return it }
            if (!(q["access_token"] ?: q["accessToken"]).isNullOrEmpty()) return q
            val form = query(body)
            return parseAccessInfo(form["code"] ?: form["accessInfo"]) ?: form
        }

        fun page(done: Boolean): String = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Nuvio Samsung Login</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700&display=swap" rel="stylesheet">
<style>
:root { color-scheme: dark; --bg: #0d0d0d; --panel: rgba(24,24,24,0.72); --border: rgba(255,255,255,0.1); --text: #fff; --muted: #a8a8a8; --success: #34d399; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; font-family: "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--text); background: radial-gradient(circle at 18% 12%, rgba(255,255,255,0.08), transparent 32%), radial-gradient(circle at 82% 78%, rgba(52,211,153,0.08), transparent 30%), var(--bg); display: grid; place-items: center; overflow: hidden; }
main { position: relative; width: min(680px, calc(100vw - 40px)); padding: 42px; border: 1px solid var(--border); border-radius: 28px; background: linear-gradient(180deg, rgba(255,255,255,0.08), transparent 34%), var(--panel); box-shadow: 0 28px 80px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.12); }
.brand { display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 13px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; margin-bottom: 34px; }
.mark { width: 12px; height: 12px; border-radius: 50%; background: var(--success); box-shadow: 0 0 0 8px rgba(52,211,153,0.12), 0 0 34px rgba(52,211,153,0.46); }
.status { display: inline-flex; align-items: center; gap: 10px; padding: 8px 12px; border: 1px solid rgba(52,211,153,0.28); border-radius: 999px; color: var(--success); background: rgba(52,211,153,0.08); font-size: 13px; font-weight: 700; margin-bottom: 18px; }
.pulse { width: 8px; height: 8px; border-radius: 50%; background: currentColor; animation: pulse 1.4s ease-in-out infinite; }
h1 { margin: 0; font-size: clamp(34px, 7vw, 58px); line-height: 0.95; letter-spacing: -0.055em; font-weight: 500; }
p { margin: 20px 0 0; color: var(--muted); font-size: 17px; line-height: 1.6; }
.rail { margin-top: 34px; height: 1px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.38), transparent); }
.hint { margin-top: 22px; color: #d7d7d7; font-size: 14px; }
@keyframes pulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.8); opacity: 0.35; } }
</style></head><body><main>
<div class="brand"><span class="mark"></span>Nuvio Installer</div>
<div class="status"><span class="pulse"></span>${if (done) "Authorized" else "Waiting for Samsung"}</div>
<h1>${if (done) "Samsung authorization complete" else "Samsung authorization in progress"}</h1>
<p>${if (done) "You can close this window and return to the Nuvio installer. The process will continue automatically." else "Complete the Samsung login in the opened window. The Nuvio installer will receive authorization automatically."}</p>
<div class="rail"></div>
<div class="hint">${if (done) "Certificate generation is continuing in the app." else "Keep this page open until authorization finishes."}</div>
</main></body></html>"""
    }

    private val result = CompletableDeferred<Map<String, String>>()
    private val servers = mutableListOf<ServerSocket>()

    /** Listens on IPv4 and IPv6 loopback (browsers may resolve localhost to either), then opens the login. */
    suspend fun wait(onListening: () -> Unit): Map<String, String> {
        for (address in listOf("127.0.0.1", "::1")) {
            try {
                val server = ServerSocket(4794, 16, InetAddress.getByName(address)).apply { reuseAddress = true }
                servers.add(server)
                Thread({ acceptLoop(server) }, "nuvio-samsung-auth").apply { isDaemon = true }.start()
            } catch (_: Exception) {}
        }
        if (servers.isEmpty()) throw InstallerError("Unable to open the local Samsung server on port 4794: address in use")
        try {
            onListening()
            return withTimeout(5 * 60 * 1000L) { result.await() }
        } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
            throw InstallerError("Samsung login timed out. Try the installation again and complete the login within 5 minutes.")
        } finally {
            Thread { Thread.sleep(1000); close() }.start()
        }
    }

    fun close() = servers.forEach { try { it.close() } catch (_: Exception) {} }

    private fun acceptLoop(server: ServerSocket) {
        while (!server.isClosed) {
            val socket = try { server.accept() } catch (_: Exception) { return }
            Thread({ handle(socket) }, "nuvio-samsung-auth-client").apply { isDaemon = true }.start()
        }
    }

    private fun handle(socket: Socket) = socket.use {
        socket.soTimeout = 15_000
        val input = socket.getInputStream()
        val data = ByteArrayOutputStream()
        val buf = ByteArray(8192)
        var headerEnd = -1
        var length = 0
        while (true) {
            val n = try { input.read(buf) } catch (_: Exception) { -1 }
            if (n < 0) break
            data.write(buf, 0, n)
            val text = data.toString("ISO-8859-1")
            if (headerEnd < 0) {
                headerEnd = text.indexOf("\r\n\r\n")
                if (headerEnd >= 0) length = text.substring(0, headerEnd).firstGroup("""content-length:\s*(\d+)""")?.toIntOrNull() ?: 0
            }
            if (headerEnd >= 0 && data.size() >= headerEnd + 4 + length) break
        }
        if (headerEnd < 0) return@use
        val raw = data.toByteArray()
        val head = String(raw, 0, headerEnd, Charsets.UTF_8)
        val body = String(raw, headerEnd + 4, minOf(length, raw.size - headerEnd - 4), Charsets.UTF_8)
        val first = head.lines2().firstOrNull().orEmpty().split(' ')
        val method = first.getOrElse(0) { "GET" }
        val target = first.getOrElse(1) { "/" }
        val info = extract(target, if (method == "POST") body else "")
        val ok = hasAccessInfo(info)
        val html = page(ok || result.isCompleted).toByteArray()
        val status = if (method == "POST" && !ok) "400 Bad Request" else "200 OK"
        socket.getOutputStream().apply {
            write("HTTP/1.1 $status\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${html.size}\r\nConnection: close\r\n\r\n".toByteArray())
            write(html)
            flush()
        }
        if (ok && info != null) result.complete(info)
    }
}
