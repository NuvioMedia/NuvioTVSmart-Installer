package space.nuvio.webtvinstaller

import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.ConnectException
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Port of the adbhost client used by the desktop installer for the direct Samsung connection (TCP 26101). */
class AdbClient(private val host: String, private val port: Int) {
    companion object {
        private fun cmd(s: String) = ByteBuffer.wrap(s.toByteArray()).order(ByteOrder.LITTLE_ENDIAN).int
        val SYNC = cmd("SYNC"); val OPEN = cmd("OPEN"); val CNXN = cmd("CNXN"); val OKAY = cmd("OKAY")
        val CLSE = cmd("CLSE"); val WRTE = cmd("WRTE")
        fun cString(s: String) = s.toByteArray() + byteArrayOf(0)
    }

    class Stream(val localId: Int) {
        var remoteId: Long = -1
        var onData: ((ByteArray) -> Unit)? = null
        var onEnd: (() -> Unit)? = null
        var onOkay: (() -> Unit)? = null
        val buffered = ByteArrayOutputStream()
        var ended = false
    }

    /** Serial executor: every piece of client state is touched only here (like a DispatchQueue). */
    val queue = Executors.newSingleThreadScheduledExecutor { Thread(it, "nuvio-adb").apply { isDaemon = true } }
    private var socket: Socket? = null
    private var tcpConnected = false
    private var handshakeDone = false
    private val pendingWrites = mutableListOf<ByteArray>()
    private val pendingOpens = mutableListOf<() -> Unit>()
    private var nextStreamId = 12345
    private val streams = HashMap<Int, Stream>()
    var peerMaxData = 4096

    var onConnect: (() -> Unit)? = null
    var onError: ((Throwable) -> Unit)? = null
    var onClose: (() -> Unit)? = null

    // After destroy() the executor shuts down; late callbacks from the socket thread are dropped.
    fun post(block: () -> Unit) {
        try { queue.execute(block) } catch (_: java.util.concurrent.RejectedExecutionException) {}
    }
    fun after(ms: Long, block: () -> Unit): ScheduledFuture<*>? =
        try { queue.schedule(block, ms, TimeUnit.MILLISECONDS) } catch (_: java.util.concurrent.RejectedExecutionException) { null }

    fun start() {
        Thread({
            val s = Socket()
            try {
                s.tcpNoDelay = true
                s.connect(InetSocketAddress(host, port), 6000)
            } catch (e: Exception) {
                post { onError?.invoke(e) }
                return@Thread
            }
            post {
                if (destroyed) { try { s.close() } catch (_: Exception) {}; return@post }
                socket = s
                tcpConnected = true
                writePacket(CNXN, 0x01000000, 4096, cString("host::"))
                pendingWrites.forEach { send(it) }
                pendingWrites.clear()
                onConnect?.invoke()
            }
            readLoop(s.getInputStream())
        }, "nuvio-adb-connect").apply { isDaemon = true }.start()
    }

    private fun readLoop(input: InputStream) {
        try {
            val header = ByteArray(24)
            while (true) {
                if (!readFully(input, header)) break
                val b = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN)
                val command = b.getInt(0); val arg1 = b.getInt(4); val arg2 = b.getInt(8); val length = b.getInt(12)
                val payload = ByteArray(length)
                if (length > 0 && !readFully(input, payload)) break
                post { onPacket(command, arg1, arg2, payload) }
            }
            post { onClose?.invoke() }
        } catch (e: Exception) {
            post { onError?.invoke(e) }
        }
    }

    private fun readFully(input: InputStream, target: ByteArray): Boolean {
        var off = 0
        while (off < target.size) {
            val n = input.read(target, off, target.size - off)
            if (n < 0) return false
            off += n
        }
        return true
    }

    @Volatile private var destroyed = false

    fun destroy() {
        if (destroyed) return
        destroyed = true
        try { socket?.close() } catch (_: Exception) {}
        try { queue.schedule({ queue.shutdownNow() }, 2, TimeUnit.SECONDS) } catch (_: Exception) {}
    }

    private fun send(packet: ByteArray) {
        try { socket?.getOutputStream()?.apply { write(packet); flush() } } catch (_: Exception) {}
    }

    /** _writePacket: header (command, arg1, arg2, length, byte-sum, magic) + payload. Call on queue. */
    fun writePacket(command: Int, arg1: Int, arg2: Int, data: ByteArray? = null) {
        val size = data?.size ?: 0
        val buffer = ByteBuffer.allocate(24 + size).order(ByteOrder.LITTLE_ENDIAN)
        var sum = 0
        data?.forEach { sum += (it.toInt() and 0xFF) }
        buffer.putInt(command).putInt(arg1).putInt(arg2).putInt(size).putInt(sum).putInt(command.inv())
        if (data != null) buffer.put(data)
        val packet = buffer.array()
        if (tcpConnected) send(packet) else pendingWrites.add(packet)
    }

    private fun onPacket(command: Int, arg1: Int, arg2: Int, data: ByteArray) {
        when (command) {
            WRTE -> {
                val stream = streams[arg2] ?: return
                stream.onData?.invoke(data) ?: stream.buffered.write(data)
                writePacket(OKAY, stream.localId, stream.remoteId.toInt())
            }
            OKAY -> streams[arg2]?.let { stream ->
                if (stream.remoteId == -1L) stream.remoteId = arg1.toLong() and 0xFFFFFFFFL
                stream.onOkay?.invoke()
            }
            CNXN -> {
                handshakeDone = true
                if (arg2 > 0) peerMaxData = arg2
                pendingOpens.forEach { it() }
                pendingOpens.clear()
            }
            CLSE -> streams.remove(arg2)?.let { stream ->
                stream.ended = true
                stream.onEnd?.invoke()
            }
        }
    }

    /** createStream: OPEN once the CNXN reply arrived. Call on queue. */
    fun createStream(path: String): Stream {
        val stream = Stream(nextStreamId++)
        streams[stream.localId] = stream
        val open = { writePacket(OPEN, stream.localId, 0, cString(path)) }
        if (handshakeDone) open() else pendingOpens.add(open)
        return stream
    }

    fun forget(stream: Stream) { streams.remove(stream.localId) }

    fun every(ms: Long, block: () -> Unit): ScheduledFuture<*>? =
        try { queue.scheduleWithFixedDelay(block, ms, ms, TimeUnit.MILLISECONDS) } catch (_: java.util.concurrent.RejectedExecutionException) { null }
}

/** Transport for Samsung shell commands (main.js connectSamsungAdb / adbCreateStream / pushFileAdb). */
class SamsungTransport private constructor(val client: AdbClient, val target: String) {

    data class ShellOptions(
        val timeoutMs: Long = 120_000,
        val idleAfterDataMs: Long = 500,
        val noOutputSuccessMs: Long = 0,
        val completeWhen: String? = null,
        val logOutput: Boolean = true
    )

    companion object {
        suspend fun connect(emit: Emit, ip: String): SamsungTransport {
            emit("info", "Direct connection to Samsung TV $ip:26101.")
            val client = AdbClient(ip, 26101)
            suspendCancellableCoroutine { cont ->
                var settled = false
                fun finish(error: Throwable?) {
                    if (settled) return
                    settled = true
                    if (error != null) { client.destroy(); cont.resumeWithException(error) } else cont.resume(Unit)
                }
                client.after(6000) { finish(InstallerError("Timed out while opening direct Samsung connection.")) }
                client.onConnect = { client.after(800) { finish(null) } }
                client.onError = { error ->
                    finish(when {
                        error is ConnectException || errorMessage(error).matchesI("ECONNREFUSED|refused") ->
                            InstallerError("Samsung TV refused the direct connection. Check that Developer Mode is enabled and the TV IP is correct.")
                        error is SocketException && errorMessage(error).matchesI("reset") ->
                            InstallerError("Samsung TV reset the direct connection. Check that Host PC IP matches this device and restart the TV by holding Power until the Samsung logo appears.")
                        else -> InstallerError(errorMessage(error))
                    })
                }
                client.onClose = { finish(InstallerError("Direct Samsung connection was closed.")) }
                client.start()
            }
            emit("success", "Direct Samsung connection is active.")
            return SamsungTransport(client, ip)
        }
    }

    fun close() = client.destroy()

    /** adbCreateStream semantics: resolves on end/close, idle after data, completeWhen match or no-output timer. */
    suspend fun stream(command: String, o: ShellOptions): String = suspendCancellableCoroutine { cont ->
        client.post {
            val stream = client.createStream(command)
            val output = ByteArrayOutputStream()
            var settled = false
            var idle: ScheduledFuture<*>? = null
            var noOutput: ScheduledFuture<*>? = null
            fun finish(error: Throwable?) {
                if (settled) return
                settled = true
                idle?.cancel(false); noOutput?.cancel(false)
                client.forget(stream)
                if (error != null) cont.resumeWithException(error) else cont.resume(output.toString(Charsets.UTF_8.name()))
            }
            client.after(o.timeoutMs) { finish(InstallerError("Timed out waiting for Samsung shell command: $command")) }
            if (o.noOutputSuccessMs > 0) noOutput = client.after(o.noOutputSuccessMs) { finish(null) }
            stream.onData = { chunk ->
                output.write(chunk)
                noOutput?.cancel(false); idle?.cancel(false)
                val text = output.toString(Charsets.UTF_8.name())
                if (o.completeWhen != null && text.matchesI(o.completeWhen)) {
                    finish(null)
                } else if (o.completeWhen == null && o.idleAfterDataMs > 0) {
                    idle = client.after(o.idleAfterDataMs) { finish(null) }
                }
            }
            stream.onEnd = { finish(null) }
        }
    }

    /** captureSamsungShell for the adb transport. */
    suspend fun shell(emit: Emit, args: List<String>, o: ShellOptions = ShellOptions()): String {
        val command = "shell:${args.joinToString(" ")}"
        emit("command", "$ adbhost $command")
        val stdout = stream(command, o)
        if (stdout.isNotEmpty() && o.logOutput) emit("stdout", stdout)
        return stdout
    }

    private fun header(tag: String, value: Int): ByteArray =
        tag.toByteArray() + ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(value).array()

    /** pushFileAdb: sync: STAT + SEND + DATA chunks of 1420 bytes + DONE + QUIT, without waiting for OKAYs. */
    suspend fun push(remotePath: String, data: ByteArray): Unit = suspendCancellableCoroutine { cont ->
        client.post {
            val shell = client.createStream("sync:")
            var settled = false
            var timer: ScheduledFuture<*>? = null
            fun finish(error: Throwable?) {
                if (settled) return
                settled = true
                timer?.cancel(false)
                if (error != null) cont.resumeWithException(error) else cont.resume(Unit)
            }
            client.after(30_000) { finish(InstallerError("Timeout push $remotePath")) }
            timer = client.every(100) {
                if (settled || shell.remoteId == -1L) return@every
                val l = shell.localId
                val r = shell.remoteId.toInt()
                val path = remotePath.toByteArray()
                client.writePacket(AdbClient.WRTE, l, r, header("STAT", path.size))
                client.writePacket(AdbClient.WRTE, l, r, path)
                client.writePacket(AdbClient.WRTE, l, r, ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN).putInt(0x444E4553).putInt(path.size + 6).array())
                client.writePacket(AdbClient.WRTE, l, r, "$remotePath,33261".toByteArray())
                var offset = 0
                while (offset < data.size) {
                    val chunk = data.copyOfRange(offset, minOf(offset + 1420, data.size))
                    client.writePacket(AdbClient.WRTE, l, r, header("DATA", chunk.size) + chunk)
                    offset += 1420
                }
                client.writePacket(AdbClient.WRTE, l, r, header("DONE", (System.currentTimeMillis() / 1000).toInt()))
                client.writePacket(AdbClient.WRTE, l, r, header("QUIT", 0))
                finish(null)
            }
        }
    }

    /**
     * What `sdb push` does: the same sync: protocol, but each packet waits for the TV's OKAY
     * (flow control) and the TV's final OKAY/FAIL reply to DONE is checked.
     */
    suspend fun pushChecked(remotePath: String, data: ByteArray, mode: Int = 33261) {
        val stream = suspendCancellableCoroutine<AdbClient.Stream> { cont -> client.post { cont.resume(client.createStream("sync:")) } }
        val reply = ByteArrayOutputStream()
        val closedMessage = "Samsung TV closed the sync connection during push $remotePath."

        suspend fun step(payload: ByteArray?, timeoutMs: Long = 30_000): Unit = suspendCancellableCoroutine { cont ->
            client.post {
                var settled = false
                fun finish(error: Throwable?) {
                    if (settled) return
                    settled = true
                    stream.onOkay = null
                    if (error != null) cont.resumeWithException(error) else cont.resume(Unit)
                }
                stream.onData = { reply.write(it) }
                stream.onEnd = { finish(InstallerError(closedMessage)) }
                if (stream.ended) { finish(InstallerError(closedMessage)); return@post }
                client.after(timeoutMs) { finish(InstallerError("Timeout push $remotePath")) }
                when {
                    payload != null -> {
                        stream.onOkay = { finish(null) }
                        client.writePacket(AdbClient.WRTE, stream.localId, stream.remoteId.toInt(), payload)
                    }
                    stream.remoteId != -1L -> finish(null)
                    else -> stream.onOkay = { finish(null) }
                }
            }
        }

        step(null) // OPEN accepted
        val spec = "$remotePath,$mode".toByteArray()
        step(header("SEND", spec.size) + spec)
        val chunk = maxOf(512, minOf(client.peerMaxData, 64 * 1024) - 8)
        var offset = 0
        while (offset < data.size) {
            val piece = data.copyOfRange(offset, minOf(offset + chunk, data.size))
            step(header("DATA", piece.size) + piece)
            offset += piece.size
        }
        step(header("DONE", (System.currentTimeMillis() / 1000).toInt()))

        // Wait for the 8-byte OKAY / FAIL+message answer to DONE.
        var answer = ByteArray(0)
        for (attempt in 0 until 300) {
            answer = suspendCancellableCoroutine { cont -> client.post { cont.resume(reply.toByteArray()) } }
            val ended = suspendCancellableCoroutine<Boolean> { cont -> client.post { cont.resume(stream.ended) } }
            if (answer.size >= 8 || ended) break
            delay(100)
        }
        val status = String(answer.copyOfRange(0, minOf(4, answer.size)))
        if (status == "FAIL") {
            val message = String(answer.copyOfRange(minOf(8, answer.size), answer.size))
            throw InstallerError("sdb push failed: ${message.ifEmpty { "the TV rejected $remotePath" }}")
        }
        if (status != "OKAY") throw InstallerError("sdb push failed: the TV did not confirm $remotePath.")
        try { step(header("QUIT", 0), 3000) } catch (_: Exception) {}
        client.post { client.forget(stream) }
    }
}
