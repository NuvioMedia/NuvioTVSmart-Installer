import Foundation
import Network

/// Port of the adbhost client used by the desktop installer for the direct Samsung connection (TCP 26101).
final class AdbClient {
    enum Cmd: UInt32 {
        case SYNC = 0x434e5953, OPEN = 0x4e45504f, CNXN = 0x4e584e43, AUTH = 0x48545541, OKAY = 0x59414b4f, CLSE = 0x45534c43, WRTE = 0x45545257
    }

    final class Stream {
        let localId: UInt32
        var remoteId: Int64 = -1
        var onData: ((Data) -> Void)?
        var onEnd: (() -> Void)?
        var onOkay: (() -> Void)?
        var buffered = Data()
        var ended = false
        init(localId: UInt32) { self.localId = localId }
    }

    let queue = DispatchQueue(label: "space.nuvio.adb")
    private let connection: NWConnection
    private var tcpConnected = false
    private var handshakeDone = false
    private var pendingWrites: [Data] = []
    private var pendingOpens: [() -> Void] = []
    private var nextStreamId: UInt32 = 12345
    private var streams: [UInt32: Stream] = [:]
    private var inbox = Data()
    /// Max payload announced by the TV in its CNXN reply.
    var peerMaxData = 4096

    var onConnect: (() -> Void)?
    var onError: ((Error) -> Void)?
    var onClose: (() -> Void)?

    init(host: String, port: UInt16) {
        connection = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.tcpConnected = true
                self.writePacket(.CNXN, 0x01000000, 4096, Self.cString("host::"))
                self.pendingWrites.forEach { self.send($0) }
                self.pendingWrites.removeAll()
                self.onConnect?()
                self.receive()
            case .waiting(let error), .failed(let error):
                self.onError?(error)
            case .cancelled:
                self.onClose?()
            default: break
            }
        }
        connection.start(queue: queue)
    }

    func destroy() { connection.cancel() }

    static func cString(_ s: String) -> Data { Data(s.utf8) + Data([0]) }

    private func send(_ data: Data) { connection.send(content: data, completion: .contentProcessed { _ in }) }

    /// _writePacket: header (command, arg1, arg2, length, byte-sum, magic) + payload.
    func writePacket(_ cmd: Cmd, _ arg1: UInt32, _ arg2: UInt32, _ data: Data? = nil) {
        var packet = Data(capacity: 24 + (data?.count ?? 0))
        let sum = data?.reduce(UInt32(0)) { $0 &+ UInt32($1) } ?? 0
        for v in [cmd.rawValue, arg1, arg2, UInt32(data?.count ?? 0), sum, 0xFFFFFFFF - cmd.rawValue] {
            withUnsafeBytes(of: v.littleEndian) { packet.append(contentsOf: $0) }
        }
        if let data { packet.append(data) }
        if tcpConnected { send(packet) } else { pendingWrites.append(packet) }
    }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data { self.inbox.append(data); self.drain() }
            if let error { self.onError?(error); return }
            if isComplete { self.onClose?(); return }
            self.receive()
        }
    }

    private func u32(_ d: Data, _ o: Int) -> UInt32 {
        d.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(fromByteOffset: o, as: UInt32.self)) }
    }

    private func drain() {
        while inbox.count >= 24 {
            let header = Data(inbox.prefix(24))
            let length = Int(u32(header, 12))
            guard inbox.count >= 24 + length else { return }
            let payload = Data(inbox.subdata(in: inbox.startIndex + 24..<inbox.startIndex + 24 + length))
            inbox = Data(inbox.dropFirst(24 + length))
            onPacket(command: u32(header, 0), arg1: u32(header, 4), arg2: u32(header, 8), data: payload)
        }
    }

    private func onPacket(command: UInt32, arg1: UInt32, arg2: UInt32, data: Data) {
        switch Cmd(rawValue: command) {
        case .WRTE:
            guard let stream = streams[arg2] else { return }
            if let onData = stream.onData { onData(data) } else { stream.buffered.append(data) }
            writePacket(.OKAY, stream.localId, UInt32(truncatingIfNeeded: stream.remoteId))
        case .OKAY:
            if let stream = streams[arg2] {
                if stream.remoteId == -1 { stream.remoteId = Int64(arg1) }
                stream.onOkay?()
            }
        case .CNXN:
            handshakeDone = true
            if arg2 > 0 { peerMaxData = Int(arg2) }
            pendingOpens.forEach { $0() }
            pendingOpens.removeAll()
        case .CLSE:
            if let stream = streams.removeValue(forKey: arg2) {
                stream.ended = true
                stream.onEnd?()
            }
        default: break
        }
    }

    /// createStream: OPEN once the CNXN reply arrived.
    func createStream(_ path: String) -> Stream {
        let stream = Stream(localId: nextStreamId)
        nextStreamId += 1
        streams[stream.localId] = stream
        let open = { self.writePacket(.OPEN, stream.localId, 0, Self.cString(path)) }
        if handshakeDone { open() } else { pendingOpens.append(open) }
        return stream
    }

    func forget(_ stream: Stream) { streams.removeValue(forKey: stream.localId) }
}

/// Transport for Samsung shell commands (main.js connectSamsungAdb / adbCreateStream / pushFileAdb).
final class SamsungTransport {
    let client: AdbClient
    let target: String
    let type = "adb"

    private init(client: AdbClient, target: String) { self.client = client; self.target = target }

    static func connect(_ emit: Emit, ip: String) async throws -> SamsungTransport {
        emit("info", "Direct connection to Samsung TV \(ip):26101.")
        let client = AdbClient(host: ip, port: 26101)
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            var settled = false
            let finish: (Error?) -> Void = { error in
                if settled { return }
                settled = true
                if let error { client.destroy(); cont.resume(throwing: error) } else { cont.resume() }
            }
            client.queue.asyncAfter(deadline: .now() + 6) { finish(InstallerError("Timed out while opening direct Samsung connection.")) }
            client.onConnect = { client.queue.asyncAfter(deadline: .now() + 0.8) { finish(nil) } }
            client.onError = { error in
                if case .posix(let code) = error as? NWError, code == .ECONNREFUSED {
                    finish(InstallerError("Samsung TV refused the direct connection. Check that Developer Mode is enabled and the TV IP is correct."))
                } else if case .posix(let code) = error as? NWError, code == .ECONNRESET {
                    finish(InstallerError("Samsung TV reset the direct connection. Check that Host PC IP matches this Mac and restart the TV by holding Power until the Samsung logo appears."))
                } else {
                    finish(InstallerError(errorMessage(error)))
                }
            }
            client.onClose = { finish(InstallerError("Direct Samsung connection was closed.")) }
            client.start()
        }
        emit("success", "Direct Samsung connection is active.")
        return SamsungTransport(client: client, target: ip)
    }

    func close() { client.destroy() }

    struct ShellOptions {
        var timeoutMs = 120000
        var idleAfterDataMs = 500
        var noOutputSuccessMs = 0
        var completeWhen: String? = nil
        var logOutput = true
    }

    /// adbCreateStream semantics: resolves on end/close, idle after data, completeWhen match or no-output timer.
    func stream(_ command: String, _ o: ShellOptions) async throws -> String {
        let client = self.client
        return try await withCheckedThrowingContinuation { cont in
            client.queue.async {
                let stream = client.createStream(command)
                var output = Data()
                var settled = false
                var idle: DispatchWorkItem?
                var noOutput: DispatchWorkItem?
                func finish(_ error: Error?) {
                    if settled { return }
                    settled = true
                    idle?.cancel(); noOutput?.cancel()
                    client.forget(stream)
                    if let error { cont.resume(throwing: error) } else { cont.resume(returning: String(decoding: output, as: UTF8.self)) }
                }
                client.queue.asyncAfter(deadline: .now() + .milliseconds(o.timeoutMs)) {
                    finish(InstallerError("Timed out waiting for Samsung shell command: \(command)"))
                }
                if o.noOutputSuccessMs > 0 {
                    let w = DispatchWorkItem { finish(nil) }
                    noOutput = w
                    client.queue.asyncAfter(deadline: .now() + .milliseconds(o.noOutputSuccessMs), execute: w)
                }
                stream.onData = { chunk in
                    output.append(chunk)
                    noOutput?.cancel(); idle?.cancel()
                    let text = String(decoding: output, as: UTF8.self)
                    if let pattern = o.completeWhen, text.matches(pattern) { finish(nil); return }
                    if o.completeWhen == nil && o.idleAfterDataMs > 0 {
                        let w = DispatchWorkItem { finish(nil) }
                        idle = w
                        client.queue.asyncAfter(deadline: .now() + .milliseconds(o.idleAfterDataMs), execute: w)
                    }
                }
                stream.onEnd = { finish(nil) }
            }
        }
    }

    /// captureSamsungShell for the adb transport.
    func shell(_ emit: Emit, _ args: [String], _ o: ShellOptions = ShellOptions()) async throws -> String {
        let command = "shell:\(args.joined(separator: " "))"
        emit("command", "$ adbhost \(command)")
        let stdout = try await stream(command, o)
        if !stdout.isEmpty && o.logOutput { emit("stdout", stdout) }
        return stdout
    }

    /// What `sdb push` does: the same sync: protocol, but each packet waits for the TV's OKAY
    /// (flow control) and the TV's final OKAY/FAIL reply to DONE is checked.
    func pushChecked(_ remotePath: String, _ data: Data, mode: UInt32 = 33261) async throws {
        let client = self.client
        let stream: AdbClient.Stream = await withCheckedContinuation { cont in
            client.queue.async { cont.resume(returning: client.createStream("sync:")) }
        }
        final class State { var reply = Data(); var ended = false }
        let state = State() // only touched on client.queue

        // Sends one WRTE and resumes when the TV acknowledges it (or the OPEN when payload is nil).
        func step(_ payload: Data?, timeout: Int = 30) async throws {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                client.queue.async {
                    var settled = false
                    func finish(_ error: Error?) {
                        if settled { return }
                        settled = true
                        stream.onOkay = nil
                        if let error { cont.resume(throwing: error) } else { cont.resume() }
                    }
                    stream.onData = { state.reply.append($0) }
                    stream.onEnd = { state.ended = true; finish(InstallerError("Samsung TV closed the sync connection during push \(remotePath).")) }
                    if state.ended { finish(InstallerError("Samsung TV closed the sync connection during push \(remotePath).")); return }
                    client.queue.asyncAfter(deadline: .now() + .seconds(timeout)) { finish(InstallerError("Timeout push \(remotePath)")) }
                    if let payload {
                        stream.onOkay = { finish(nil) }
                        client.writePacket(.WRTE, stream.localId, UInt32(truncatingIfNeeded: stream.remoteId), payload)
                    } else if stream.remoteId != -1 {
                        finish(nil)
                    } else {
                        stream.onOkay = { finish(nil) }
                    }
                }
            }
        }
        func header(_ tag: String, _ value: UInt32) -> Data {
            var d = Data(tag.utf8)
            withUnsafeBytes(of: value.littleEndian) { d.append(contentsOf: $0) }
            return d
        }

        try await step(nil) // OPEN accepted
        let spec = Data("\(remotePath),\(mode)".utf8)
        try await step(header("SEND", UInt32(spec.count)) + spec)
        let chunk = max(512, min(client.peerMaxData, 64 * 1024) - 8)
        var offset = 0
        while offset < data.count {
            let piece = data.subdata(in: offset..<min(offset + chunk, data.count))
            try await step(header("DATA", UInt32(piece.count)) + piece)
            offset += piece.count
        }
        try await step(header("DONE", UInt32(Date().timeIntervalSince1970)))

        // Wait for the 8-byte OKAY / FAIL+message answer to DONE.
        var reply = Data()
        for _ in 0..<300 {
            let (r, ended): (Data, Bool) = await withCheckedContinuation { c in client.queue.async { c.resume(returning: (state.reply, state.ended)) } }
            reply = r
            if r.count >= 8 || ended { break }
            await sleepMs(100)
        }
        let status = String(decoding: reply.prefix(4), as: UTF8.self)
        if status == "FAIL" {
            let message = String(decoding: reply.dropFirst(8), as: UTF8.self)
            throw InstallerError("sdb push failed: \(message.isEmpty ? "the TV rejected \(remotePath)" : message)")
        }
        if status != "OKAY" { throw InstallerError("sdb push failed: the TV did not confirm \(remotePath).") }
        _ = try? await step(header("QUIT", 0), timeout: 3)
        client.queue.async { client.forget(stream) }
    }

    /// pushFileAdb: sync: STAT + SEND + DATA chunks of 1420 bytes + DONE + QUIT.
    func push(_ remotePath: String, _ data: Data) async throws {
        let client = self.client
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            client.queue.async {
                let shell = client.createStream("sync:")
                var settled = false
                var timer: DispatchSourceTimer?
                func finish(_ error: Error?) {
                    if settled { return }
                    settled = true
                    timer?.cancel()
                    if let error { cont.resume(throwing: error) } else { cont.resume() }
                }
                client.queue.asyncAfter(deadline: .now() + 30) { finish(InstallerError("Timeout push \(remotePath)")) }
                func le(_ tag: String, _ value: UInt32) -> Data {
                    var d = Data(tag.utf8)
                    withUnsafeBytes(of: value.littleEndian) { d.append(contentsOf: $0) }
                    return d
                }
                let t = DispatchSource.makeTimerSource(queue: client.queue)
                timer = t
                t.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
                t.setEventHandler {
                    guard shell.remoteId != -1 else { return }
                    let l = shell.localId, r = UInt32(truncatingIfNeeded: shell.remoteId)
                    let path = Data(remotePath.utf8)
                    client.writePacket(.WRTE, l, r, le("STAT", UInt32(path.count)))
                    client.writePacket(.WRTE, l, r, path)
                    var send = Data()
                    withUnsafeBytes(of: UInt32(0x444E4553).littleEndian) { send.append(contentsOf: $0) }
                    withUnsafeBytes(of: UInt32(path.count + 6).littleEndian) { send.append(contentsOf: $0) }
                    client.writePacket(.WRTE, l, r, send)
                    client.writePacket(.WRTE, l, r, Data("\(remotePath),33261".utf8))
                    var offset = 0
                    while offset < data.count {
                        let chunk = data.subdata(in: offset..<min(offset + 1420, data.count))
                        client.writePacket(.WRTE, l, r, le("DATA", UInt32(chunk.count)) + chunk)
                        offset += 1420
                    }
                    client.writePacket(.WRTE, l, r, le("DONE", UInt32(Date().timeIntervalSince1970)))
                    client.writePacket(.WRTE, l, r, le("QUIT", 0))
                    finish(nil)
                }
                t.resume()
            }
        }
    }
}
