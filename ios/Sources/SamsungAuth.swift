import Foundation
import Network

/// waitForSamsungAccessInfo: local callback server on port 4794 receiving the Samsung OAuth redirect.
final class SamsungAuthServer {
    static let authUrl = "https://account.samsung.com/mobile/account/check.do?serviceID=v285zxnl3h&actionID=StartOAuth2&accessToken=Y&redirect_uri=http://localhost:4794/signin/callback"

    private let queue = DispatchQueue(label: "space.nuvio.samsung-auth")
    private var listener: NWListener?
    private var settled = false
    private var continuation: CheckedContinuation<[String: String], Error>?

    func wait(onListening: @escaping () -> Void) async throws -> [String: String] {
        try await withCheckedThrowingContinuation { cont in
            queue.async {
                self.continuation = cont
                do {
                    let params = NWParameters.tcp
                    params.allowLocalEndpointReuse = true
                    params.requiredInterfaceType = .loopback
                    let listener = try NWListener(using: params, on: 4794)
                    self.listener = listener
                    listener.newConnectionHandler = { [weak self] conn in self?.handle(conn) }
                    listener.stateUpdateHandler = { [weak self] state in
                        switch state {
                        case .ready: DispatchQueue.main.async(execute: onListening)
                        case .failed(let error): self?.fail(InstallerError("Unable to open the local Samsung server on port 4794: \(errorMessage(error))"))
                        default: break
                        }
                    }
                    listener.start(queue: self.queue)
                    self.queue.asyncAfter(deadline: .now() + 300) {
                        self.fail(InstallerError("Samsung login timed out. Try the installation again and complete the login within 5 minutes."))
                    }
                } catch {
                    self.fail(InstallerError("Unable to open the local Samsung server on port 4794: \(errorMessage(error))"))
                }
            }
        }
    }

    func cancel() { queue.async { self.fail(InstallerError("Samsung login was cancelled.")) } }

    private func fail(_ error: Error) {
        guard !settled else { return }
        settled = true
        listener?.cancel()
        continuation?.resume(throwing: error)
    }

    private func succeed(_ info: [String: String]) {
        guard !settled else { return }
        settled = true
        queue.asyncAfter(deadline: .now() + 1) { self.listener?.cancel() }
        continuation?.resume(returning: info)
    }

    private func handle(_ conn: NWConnection) {
        conn.start(queue: queue)
        var buffer = Data()
        func read() {
            conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, error in
                guard let self else { return }
                if let data { buffer.append(data) }
                if let request = Self.parse(buffer) {
                    self.respond(conn, request)
                } else if done || error != nil {
                    conn.cancel()
                } else {
                    read()
                }
            }
        }
        read()
    }

    /// Returns (method, target, body) once the full request (headers + content-length body) arrived.
    private static func parse(_ data: Data) -> (String, String, String)? {
        guard let range = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let head = String(decoding: data[..<range.lowerBound], as: UTF8.self)
        let length = head.firstGroup(#"content-length:\s*(\d+)"#).flatMap(Int.init) ?? 0
        let bodyData = data[range.upperBound...]
        guard bodyData.count >= length else { return nil }
        let first = head.components(separatedBy: "\r\n").first?.components(separatedBy: " ") ?? []
        return (first.first ?? "GET", first.count > 1 ? first[1] : "/", String(decoding: bodyData.prefix(length), as: UTF8.self))
    }

    private func respond(_ conn: NWConnection, _ request: (String, String, String)) {
        let (method, target, body) = request
        let info = Self.extract(target: target, body: method == "POST" ? body : "")
        let ok = Self.hasAccessInfo(info)
        let status = method == "POST" && !ok ? "400 Bad Request" : "200 OK"
        let html = Self.page(done: ok || settled)
        let response = "HTTP/1.1 \(status)\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(html.utf8.count)\r\nConnection: close\r\n\r\n\(html)"
        conn.send(content: Data(response.utf8), completion: .contentProcessed { _ in conn.cancel() })
        if ok, let info { succeed(info) }
    }

    static func hasAccessInfo(_ info: [String: String]?) -> Bool {
        !(info?["access_token"] ?? info?["accessToken"] ?? "").isEmpty
    }

    static func query(_ s: String) -> [String: String] {
        var out: [String: String] = [:]
        for pair in s.split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1).map {
                String($0).replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? String($0)
            }
            if let k = kv.first, !k.isEmpty, out[k] == nil { out[k] = kv.count > 1 ? kv[1] : "" }
        }
        return out
    }

    /// parseSamsungAccessInfo: JSON object or query string.
    static func parseAccessInfo(_ raw: String?) -> [String: String]? {
        guard let value = raw?.trimmed, !value.isEmpty else { return nil }
        if let data = value.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return obj.mapValues { "\($0)" }
        }
        let parsed = query(value)
        return parsed.isEmpty ? nil : parsed
    }

    static func extract(target: String, body: String) -> [String: String]? {
        let q = query(target.components(separatedBy: "?").dropFirst().joined(separator: "?"))
        if let info = parseAccessInfo(q["code"] ?? q["accessInfo"]) { return info }
        if !(q["access_token"] ?? q["accessToken"] ?? "").isEmpty { return q }
        let form = query(body)
        return parseAccessInfo(form["code"] ?? form["accessInfo"]) ?? form
    }

    static func page(done: Bool) -> String {
        """
        <!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Nuvio Samsung Login</title>
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
        <div class="status"><span class="pulse"></span>\(done ? "Authorized" : "Waiting for Samsung")</div>
        <h1>\(done ? "Samsung authorization complete" : "Samsung authorization in progress")</h1>
        <p>\(done ? "You can close this window and return to the Nuvio installer. The process will continue automatically." : "Complete the Samsung login in the opened window. The Nuvio installer will receive authorization automatically.")</p>
        <div class="rail"></div>
        <div class="hint">\(done ? "Certificate generation is continuing in the app." : "Keep this page open until authorization finishes.")</div>
        </main></body></html>
        """
    }
}
