import Foundation
import CryptoKit
import ZIPFoundation

/// Mirrors Node errors from the desktop installer (message plus optional code/stdout/stderr).
struct InstallerError: LocalizedError {
    var message: String
    var code: String?
    var stdout = ""
    var stderr = ""
    init(_ message: String, code: String? = nil, stdout: String = "", stderr: String = "") {
        self.message = message; self.code = code; self.stdout = stdout; self.stderr = stderr
    }
    var errorDescription: String? { message }
}

func errorMessage(_ error: Error) -> String {
    (error as? LocalizedError)?.errorDescription ?? String(describing: error)
}

typealias Emit = (_ type: String, _ text: String) -> Void

struct InstallerConfig: Decodable {
    struct Platform: Decodable { let appId: String; let assetPattern: String; let packageId: String?; let appIds: [String]? }
    let githubRepo: String
    let webos: Platform
    let tizen: Platform
}

enum Paths {
    /// Equivalent of Electron app.getPath("userData").
    static let userData: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let url = base.appendingPathComponent("Nuvio TV Installer", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()
    /// Equivalent of os.homedir() for ~/share/.samsung-cert, ~/.webos and ~/.ssh.
    static let home: URL = userData.appendingPathComponent("home", isDirectory: true)
    static let temp = FileManager.default.temporaryDirectory

    static func ensureDir(_ url: URL) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }
}

func requireValue(_ value: String?, _ label: String) throws -> String {
    let normalized = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if normalized.isEmpty { throw InstallerError("\(label) is required.") }
    return normalized
}

func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func sha512Base64(_ data: Data) -> String {
    Data(SHA512.hash(data: data)).base64EncodedString()
}

func isoNow() -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: Date())
}

func parseISODate(_ value: String?) -> Double {
    guard let value, !value.isEmpty else { return 0 }
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: value) ?? ISO8601DateFormatter().date(from: value) { return d.timeIntervalSince1970 * 1000 }
    return 0
}

func sleepMs(_ ms: Int) async { try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000) }

extension String {
    func matches(_ pattern: String, options: NSRegularExpression.Options = [.caseInsensitive]) -> Bool {
        (try? NSRegularExpression(pattern: pattern, options: options))?
            .firstMatch(in: self, range: NSRange(startIndex..., in: self)) != nil
    }
    func firstGroup(_ pattern: String, options: NSRegularExpression.Options = [.caseInsensitive]) -> String? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: options),
              let m = re.firstMatch(in: self, range: NSRange(startIndex..., in: self)), m.numberOfRanges > 1,
              let r = Range(m.range(at: 1), in: self) else { return nil }
        return String(self[r])
    }
    func replacingRegex(_ pattern: String, with template: String) -> String {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return self }
        return re.stringByReplacingMatches(in: self, range: NSRange(startIndex..., in: self), withTemplate: template)
    }
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
    var lines: [String] { components(separatedBy: "\n").map { $0.hasSuffix("\r") ? String($0.dropLast()) : $0 } }
}

// MARK: - Versions (compareTizenVersions)

func parseTizenVersion(_ value: String) -> [Int] {
    guard let re = try? NSRegularExpression(pattern: #"\b(\d+)(?:\.(\d+))?(?:\.(\d+))?\b"#),
          let m = re.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) else { return [] }
    return (1...3).map { i in
        guard let r = Range(m.range(at: i), in: value) else { return 0 }
        return Int(value[r]) ?? 0
    }
}

func compareTizenVersions(_ left: String, _ right: String) -> Int? {
    let l = parseTizenVersion(left), r = parseTizenVersion(right)
    if l.isEmpty || r.isEmpty { return nil }
    for i in 0..<3 where l[i] != r[i] { return l[i] > r[i] ? 1 : -1 }
    return 0
}

// MARK: - HTTP

enum HTTP {
    static func get(_ url: String, headers: [String: String] = [:], timeout: TimeInterval = 60) async throws -> (Data, HTTPURLResponse) {
        guard let u = URL(string: url) else { throw InstallerError("Invalid URL: \(url)") }
        var req = URLRequest(url: u, timeoutInterval: timeout)
        headers.forEach { req.setValue($1, forHTTPHeaderField: $0) }
        let (data, resp) = try await URLSession.shared.data(for: req)
        return (data, resp as! HTTPURLResponse)
    }

    static func statusText(_ code: Int) -> String { HTTPURLResponse.localizedString(forStatusCode: code).capitalized }

    static func fetchJson(_ url: String) async throws -> Any {
        let (data, resp) = try await get(url, headers: ["Accept": "application/vnd.github+json", "User-Agent": "Nuvio-TV-Installer"])
        guard (200..<300).contains(resp.statusCode) else {
            throw InstallerError("GitHub request failed: \(resp.statusCode) \(statusText(resp.statusCode))")
        }
        return try JSONSerialization.jsonObject(with: data)
    }

    static func downloadFile(_ emit: Emit, _ url: String, to target: URL, progressLabel: String? = nil) async throws {
        emit("info", "Download \(url)")
        guard let u = URL(string: url) else { throw InstallerError("Invalid URL: \(url)") }
        var req = URLRequest(url: u)
        req.setValue("Nuvio-TV-Installer", forHTTPHeaderField: "User-Agent")
        let (bytes, resp) = try await URLSession.shared.bytes(for: req)
        let http = resp as! HTTPURLResponse
        guard (200..<300).contains(http.statusCode) else {
            throw InstallerError("Download failed: \(http.statusCode) \(statusText(http.statusCode))")
        }
        try Paths.ensureDir(target.deletingLastPathComponent())
        let total = Int(http.expectedContentLength > 0 ? http.expectedContentLength : 0)
        var data = Data(); data.reserveCapacity(max(total, 0))
        var lastPercent = 0
        var buffer = [UInt8](); buffer.reserveCapacity(65536)
        for try await byte in bytes {
            buffer.append(byte)
            if buffer.count == 65536 {
                data.append(contentsOf: buffer); buffer.removeAll(keepingCapacity: true)
                if let progressLabel, total > 0 {
                    let percent = data.count * 100 / total
                    if percent >= lastPercent + 10 { lastPercent = percent; emit("info", "\(progressLabel): \(percent)%") }
                }
            }
        }
        data.append(contentsOf: buffer)
        try data.write(to: target, options: .atomic)
    }

    static func multipart(_ url: String, fields: [(String, String)], file: (name: String, filename: String, data: Data)) async throws -> (Data, HTTPURLResponse) {
        let boundary = "--------------------------\(Int.random(in: 100000000000...999999999999))"
        var body = Data()
        for (k, v) in fields {
            body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(k)\"\r\n\r\n\(v)\r\n".data(using: .utf8)!)
        }
        body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(file.name)\"; filename=\"\(file.filename)\"\r\nContent-Type: application/octet-stream\r\n\r\n".data(using: .utf8)!)
        body.append(file.data)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        var req = URLRequest(url: URL(string: url)!, timeoutInterval: 120)
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        let (data, resp) = try await URLSession.shared.data(for: req)
        return (data, resp as! HTTPURLResponse)
    }
}

// MARK: - Releases (same logic as main.js)

enum Releases {
    static func assetFor(_ release: [String: Any], pattern: String) -> [String: Any]? {
        guard let assets = release["assets"] as? [[String: Any]] else { return nil }
        return assets.first { (($0["name"] as? String) ?? "").matches(pattern) }
    }

    static func normalizePlatform(_ platform: String) -> String {
        let n = platform.trimmed.lowercased()
        if n == "lg" { return "webos" }
        if n == "samsung" { return "tizen" }
        return n
    }

    static func platformConfig(_ config: InstallerConfig, _ platform: String) -> InstallerConfig.Platform? {
        switch platform { case "webos": return config.webos; case "tizen": return config.tizen; default: return nil }
    }

    static func recent(_ config: InstallerConfig, platform: String, limit: Int = 3) async throws -> [[String: Any]] {
        let releasePlatform = normalizePlatform(platform)
        guard let pc = platformConfig(config, releasePlatform) else { throw InstallerError("Unsupported platform: \(platform)") }
        let releases = (try await HTTP.fetchJson("https://api.github.com/repos/\(config.githubRepo)/releases?per_page=20")) as? [[String: Any]] ?? []
        return releases
            .filter { !(($0["draft"] as? Bool) ?? false) && assetFor($0, pattern: pc.assetPattern) != nil }
            .prefix(limit)
            .map { r in
                let tag = r["tag_name"] as? String ?? ""
                let name = (r["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? tag
                return ["id": r["id"] ?? 0, "tagName": tag, "name": name,
                        "publishedAt": r["published_at"] ?? NSNull(), "prerelease": (r["prerelease"] as? Bool) ?? false]
            }
    }

    static func releaseUrl(_ config: InstallerConfig, _ releaseId: String?) throws -> (String, String) {
        let id = (releaseId ?? "").trimmed
        if !id.isEmpty && !id.matches(#"^\d+$"#) { throw InstallerError("Invalid GitHub release selection.") }
        let url = id.isEmpty
            ? "https://api.github.com/repos/\(config.githubRepo)/releases/latest"
            : "https://api.github.com/repos/\(config.githubRepo)/releases/\(id)"
        return (url, id)
    }

    static func resolveAsset(_ config: InstallerConfig, _ emit: Emit, platform: String, releaseId: String?) async throws -> URL {
        let (url, id) = try releaseUrl(config, releaseId)
        let release = (try await HTTP.fetchJson(url)) as? [String: Any] ?? [:]
        let pc = platformConfig(config, platform)!
        guard let asset = assetFor(release, pattern: pc.assetPattern) else {
            let tag = (release["tag_name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (id.isEmpty ? "latest" : id)
            throw InstallerError("No \(platform) package was found in GitHub release \(tag).")
        }
        let tag = (release["tag_name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (id.isEmpty ? "latest" : id)
        let cacheKey = tag.replacingRegex("[^a-z0-9._-]+", with: "-")
        let target = Paths.userData.appendingPathComponent("packages").appendingPathComponent(cacheKey)
            .appendingPathComponent(asset["name"] as? String ?? "package")
        if FileManager.default.isReadableFile(atPath: target.path) {
            emit("info", "Using already downloaded package: \(target.path)")
        } else {
            try await HTTP.downloadFile(emit, asset["browser_download_url"] as? String ?? "", to: target)
        }
        return target
    }

    static func version(_ config: InstallerConfig, _ releaseId: String?) async throws -> String {
        let (url, _) = try releaseUrl(config, releaseId)
        let release = (try await HTTP.fetchJson(url)) as? [String: Any] ?? [:]
        return (release["tag_name"] as? String ?? "").replacingRegex("^v", with: "")
    }

    /// isAlreadyUpToDate from main.js.
    static func isAlreadyUpToDate(_ config: InstallerConfig, _ emit: Emit, installed: String, releaseId: String?) async throws -> Bool {
        if installed.isEmpty {
            emit("info", "Nuvio TV is not installed on this TV; installing it.")
            return false
        }
        let target = try await version(config, releaseId)
        if let c = compareTizenVersions(installed, target), c >= 0 {
            emit("info", "Nuvio TV \(installed) is already installed (release \(target)); nothing to update.")
            return true
        }
        emit("info", "Updating Nuvio TV from \(installed) to \(target).")
        return false
    }
}

// MARK: - ZIP helpers

struct ZipEntryData {
    let name: String
    let isDirectory: Bool
    let data: Data
}

enum Zip {
    static func read(_ data: Data) throws -> [ZipEntryData] {
        let archive = try Archive(data: data, accessMode: .read)
        var out: [ZipEntryData] = []
        for entry in archive {
            var d = Data()
            if entry.type == .file { _ = try archive.extract(entry, skipCRC32: true) { d.append($0) } }
            out.append(ZipEntryData(name: entry.path, isDirectory: entry.type == .directory, data: d))
        }
        return out
    }

    static func write(_ files: [(String, Data)]) throws -> Data {
        let archive = try Archive(accessMode: .create)
        for (name, data) in files {
            try archive.addEntry(with: name, type: .file, uncompressedSize: Int64(data.count),
                                 compressionMethod: .deflate) { position, size in
                data.subdata(in: Int(position)..<Int(position) + size)
            }
        }
        return archive.data ?? Data()
    }
}

// MARK: - Local IPv4 (os.networkInterfaces)

func localIPv4Addresses() -> [String] {
    var result: [String] = []
    var ifaddr: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return [] }
    defer { freeifaddrs(ifaddr) }
    for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
        let flags = Int32(ptr.pointee.ifa_flags)
        guard let addr = ptr.pointee.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET),
              flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0 else { continue }
        var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        if getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
            let ip = String(cString: host)
            if !ip.hasPrefix("169.254.") { result.append(ip) }
        }
    }
    return result
}
