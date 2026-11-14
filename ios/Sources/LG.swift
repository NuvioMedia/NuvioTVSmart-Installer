import Foundation
import Citadel
import NIOCore
import Crypto

/// runLg / device profile handling from main.js. The webOS CLI (ares-*) is replaced by the same
/// operations done natively: novacom-devices.json profiles, the :9991 key download and SSH + luna-send.
enum LG {
    // MARK: Device store (~/.webos/tv/novacom-devices.json and ~/.ssh)

    static var dataDir: URL { Paths.home.appendingPathComponent(".webos/tv", isDirectory: true) }
    static var sshDir: URL { Paths.home.appendingPathComponent(".ssh", isDirectory: true) }
    static var devicesPath: URL { dataDir.appendingPathComponent("novacom-devices.json") }

    static func readDevices() -> [[String: Any]] {
        guard let data = try? Data(contentsOf: devicesPath),
              let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        return list
    }

    static func writeDevices(_ devices: [[String: Any]]) throws {
        try Paths.ensureDir(dataDir)
        let data = try JSONSerialization.data(withJSONObject: devices, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: devicesPath, options: .atomic)
    }

    static func str(_ v: Any?) -> String { (v as? String) ?? (v.map { "\($0)" } ?? "") }
    static func keyName(_ entry: [String: Any]) -> String { str((entry["privateKey"] as? [String: Any])?["openSsh"]).trimmed }
    static func isDefault(_ entry: [String: Any]) -> Bool { (entry["default"] as? Bool) == true || str(entry["default"]).lowercased() == "true" }
    static func keyReadable(_ name: String) -> Bool { !name.isEmpty && FileManager.default.isReadableFile(atPath: sshDir.appendingPathComponent(name).path) }

    static func listRegistered() -> [[String: Any]] {
        var unique: [String: [String: Any]] = [:]
        for entry in readDevices() {
            let name = str(entry["name"]).trimmed
            guard !name.isEmpty else { continue }
            let device: [String: Any] = [
                "name": name, "host": str(entry["host"]).trimmed, "default": isDefault(entry),
                "keyReady": keyReadable(keyName(entry)), "removable": (entry["indelible"] as? Bool) != true
            ]
            let score = { (d: [String: Any]) in ((d["keyReady"] as? Bool) == true ? 2 : 0) + ((d["default"] as? Bool) == true ? 1 : 0) }
            let key = name.lowercased()
            if score(device) > (unique[key].map(score) ?? -1) { unique[key] = device }
        }
        return unique.values.sorted {
            let l = ($0["default"] as? Bool) == true ? 1 : 0, r = ($1["default"] as? Bool) == true ? 1 : 0
            if l != r { return l > r }
            return str($0["name"]).localizedCompare(str($1["name"])) == .orderedAscending
        }
    }

    static func defaultDeviceName(_ ip: String) -> String {
        let slug = ip.trimmed.replacingRegex("[^a-z0-9]+", with: "-").replacingRegex("^-+|-+$", with: "")
        return "nuvio-lg-\(slug.isEmpty ? "tv" : slug)"
    }

    static func infoArgs(_ host: String) -> [String] {
        ["--info", "username=prisoner", "--info", "host=\(host)", "--info", "port=9922", "--info", "default=true"]
    }

    static func command(_ emit: Emit, _ cmd: String, _ args: [String]) {
        let shown = args.enumerated().map { i, a in i > 0 && args[i - 1] == "--passphrase" ? "********" : a }
        emit("command", "$ \(cmd) \(shown.joined(separator: " "))")
    }

    /// ares-setup-device --add/--modify (makes the profile the default one, like default=true).
    static func setupDevice(_ name: String, host: String) throws {
        var devices = readDevices().map { d -> [String: Any] in var d = d; d["default"] = false; return d }
        if let i = devices.firstIndex(where: { str($0["name"]) == name }) {
            devices[i]["host"] = host; devices[i]["port"] = 9922; devices[i]["username"] = "prisoner"; devices[i]["default"] = true
        } else {
            devices.append(["name": name, "host": host, "port": 9922, "username": "prisoner", "profile": "tv",
                            "type": "starfish", "description": "new device", "default": true, "files": "stream"])
        }
        try writeDevices(devices)
    }

    static func removeDevice(_ name: String) throws {
        let devices = readDevices()
        for d in devices where str(d["name"]) == name {
            let k = keyName(d)
            if !k.isEmpty { try? FileManager.default.removeItem(at: sshDir.appendingPathComponent(k)) }
        }
        try writeDevices(devices.filter { str($0["name"]) != name })
    }

    // MARK: Profile resolution (same as main.js)

    struct ResolvedDevice { let name: String; let host: String; let keyPath: URL; let passphrase: String }

    static func findExistingWithKey(_ deviceName: String, _ host: String, allowDifferentHostForName: Bool) -> ResolvedDevice? {
        let withKeys = readDevices().filter { !keyName($0).isEmpty }
        let hostMatches = host.isEmpty ? withKeys : withKeys.filter { str($0["host"]) == host }
        var device = deviceName.isEmpty ? nil : hostMatches.first { str($0["name"]) == deviceName }
        if device == nil && allowDifferentHostForName && !deviceName.isEmpty { device = withKeys.first { str($0["name"]) == deviceName } }
        if device == nil && deviceName.isEmpty && host.isEmpty { device = hostMatches.first(where: isDefault) }
        if device == nil { device = hostMatches.first }
        guard let d = device else { return nil }
        let keyPath = sshDir.appendingPathComponent(keyName(d))
        guard FileManager.default.isReadableFile(atPath: keyPath.path) else { return nil }
        return ResolvedDevice(name: str(d["name"]), host: str(d["host"]), keyPath: keyPath, passphrase: str(d["passphrase"]))
    }

    static func resolveExisting(_ emit: Emit, _ requestedName: String, _ ip: String) throws -> String {
        let deviceName = requestedName.trimmed, host = ip.trimmed
        guard let existing = findExistingWithKey(deviceName, host, allowDifferentHostForName: !deviceName.isEmpty && !host.isEmpty) else {
            throw InstallerError("No usable SSH key was found for this LG device. Enter the TV IP and current Developer Mode passphrase, then press Install to create or overwrite the saved profile.")
        }
        if deviceName.isEmpty && host.isEmpty {
            let label = existing.host.isEmpty ? existing.name : "\(existing.name) (\(existing.host))"
            emit("info", "Using saved LG webOS device profile: \(label).")
        }
        if !deviceName.isEmpty && !host.isEmpty && existing.name == deviceName && existing.host != host {
            emit("info", "Updating LG device profile \"\(deviceName)\" from \(existing.host.isEmpty ? "unknown host" : existing.host) to \(host).")
            command(emit, "ares-setup-device", ["--modify", deviceName] + infoArgs(host))
            try setupDevice(deviceName, host: host)
            emit("success", "LG device IP updated.")
        }
        return existing.name
    }

    static func configure(_ emit: Emit, ip: String, requestedName: String, passphrase: String) async throws -> String {
        let host = try requireValue(ip, "IP LG TV")
        let deviceName = requestedName.trimmed.isEmpty ? defaultDeviceName(host) : requestedName.trimmed
        emit("info", "Automatically configuring LG webOS device: \(deviceName)")
        let matching = readDevices().filter { str($0["name"]) == deviceName }
        let canReplace = !matching.isEmpty && matching.allSatisfy { ($0["indelible"] as? Bool) != true }
        if canReplace {
            emit("info", "Replacing existing LG device profile \"\(deviceName)\" and its saved authentication.")
            command(emit, "ares-setup-device", ["--remove", deviceName]); try removeDevice(deviceName)
            command(emit, "ares-setup-device", ["--add", deviceName] + infoArgs(host)); try setupDevice(deviceName, host: host)
        } else if !matching.isEmpty {
            emit("info", "Updating protected LG device profile \"\(deviceName)\".")
            command(emit, "ares-setup-device", ["--modify", deviceName] + infoArgs(host)); try setupDevice(deviceName, host: host)
        } else {
            command(emit, "ares-setup-device", ["--add", deviceName] + infoArgs(host)); try setupDevice(deviceName, host: host)
        }

        emit("info", "Downloading and overwriting the SSH key for \"\(deviceName)\".")
        command(emit, "ares-novacom", ["--device", deviceName, "--getkey", "--passphrase", passphrase])
        let pem = try await WebOSKey.download(host: host)
        _ = try WebOSKey.openSSH(fromPEM: pem, passphrase: passphrase) // validates the passphrase like ares does on first use
        try Paths.ensureDir(sshDir)
        let keyFile = "\(deviceName)_webos"
        let keyPath = sshDir.appendingPathComponent(keyFile)
        try pem.write(to: keyPath, atomically: true, encoding: .utf8)
        var devices = readDevices()
        for i in devices.indices where str(devices[i]["name"]) == deviceName {
            devices[i]["privateKey"] = ["openSsh": keyFile]
            devices[i]["passphrase"] = passphrase
        }
        try writeDevices(devices)
        emit("stdout", "SSH Private Key: \(keyPath.path)")
        emit("success", "LG profile and SSH key saved.")
        return deviceName
    }

    static func delete(_ emit: Emit, _ requestedName: String) throws {
        let deviceName = try requireValue(requestedName, "LG device name")
        let matching = readDevices().filter { str($0["name"]) == deviceName }
        if matching.isEmpty { throw InstallerError("LG device profile \"\(deviceName)\" was not found.") }
        if matching.contains(where: { ($0["indelible"] as? Bool) == true }) {
            throw InstallerError("LG device profile \"\(deviceName)\" is protected by the webOS CLI and cannot be deleted.")
        }
        command(emit, "ares-setup-device", ["--remove", deviceName])
        try removeDevice(deviceName)
        emit("success", "LG device profile \"\(deviceName)\" deleted.")
    }

    // MARK: runLg

    static func run(_ config: InstallerConfig, _ emit: Emit, action: String, options: [String: Any]) async throws {
        let ip = str(options["ip"]).trimmed
        let passphrase = str(options["lgPassphrase"]).trimmed
        let deviceName = str(options["deviceName"])
        let device = passphrase.isEmpty
            ? try resolveExisting(emit, deviceName, ip)
            : try await configure(emit, ip: ip, requestedName: deviceName, passphrase: passphrase)
        guard let profile = findExistingWithKey(device, "", allowDifferentHostForName: true) else {
            throw InstallerError("No usable SSH key was found for this LG device. Enter the TV IP and current Developer Mode passphrase, then press Install to create or overwrite the saved profile.")
        }
        let appId = config.webos.appId

        if action == "launch" {
            command(emit, "ares-launch", ["--device", device, appId])
            try await withSession(profile, tool: "ares-launch", emit) { client in
                let out = try await luna(client, "luna://com.webos.applicationManager/launch", #"{"id":"\#(appId)"}"#, single: true)
                guard out.contains("\"returnValue\":true") || out.contains("\"returnValue\": true") else {
                    throw toolFailure(emit, "ares-launch", "[com.webos.applicationManager failure]: luna-send command failed \(lunaReason(out))")
                }
                emit("stdout", "[Info] Set target device : \(device)\nLaunched application \(appId)")
            }
            return
        }

        if action == "uninstall" {
            command(emit, "ares-install", ["--device", device, "--remove", appId])
            try await withSession(profile, tool: "ares-install", emit) { client in
                let state = try await lunaSubscribe(client, "luna://com.webos.appInstallService/dev/remove",
                                                    #"{"id":"\#(appId)","subscribe":true}"#, success: "removed|^SUCCESS")
                if let failure = state { throw toolFailure(emit, "ares-install", "[com.webos.appInstallService failure]: luna-send command failed \(failure)") }
                emit("stdout", "Removing package \(appId)\nSuccess")
            }
            return
        }

        if action == "update" {
            let installed = try await withSession(profile, tool: "ares-install", emit) { client -> String in
                let out = try await luna(client, "luna://com.webos.applicationManager/dev/listApps", "{}", single: true)
                return listedVersion(out, appId)
            }
            if try await Releases.isAlreadyUpToDate(config, emit, installed: installed, releaseId: str(options["releaseId"])) { return }
        }

        let packagePathOption = str(options["packagePath"])
        let packagePath = packagePathOption.isEmpty
            ? try await Releases.resolveAsset(config, emit, platform: "webos", releaseId: str(options["releaseId"]))
            : URL(fileURLWithPath: packagePathOption)
        command(emit, "ares-install", ["--device", device, packagePath.path])
        do {
            try await withSession(profile, tool: "ares-install", emit) { client in
                try await install(client, emit, packagePath)
            }
        } catch let error as InstallerError {
            if passphrase.isEmpty && "\(error.message)\n\(error.stderr)".matches("authentication methods failed|ssh exec failure") {
                throw InstallerError("LG authentication failed for device \"\(device)\". Enter the current Developer Mode passphrase and press Install again to overwrite the saved profile and SSH key.")
            }
            throw error
        }
    }

    // MARK: SSH + luna-send (what ares-install / ares-launch do on the TV)

    static func toolFailure(_ emit: Emit, _ tool: String, _ detail: String) -> InstallerError {
        let stderr = "\(tool) ERR! \(detail)"
        emit("stderr", stderr)
        return InstallerError("\(tool) exited with code 1", code: "1", stderr: stderr)
    }

    static func withSession<T>(_ profile: ResolvedDevice, tool: String, _ emit: Emit, _ body: (SSHClient) async throws -> T) async throws -> T {
        let client: SSHClient
        do {
            let pem = try String(contentsOf: profile.keyPath, encoding: .utf8)
            let key = try Insecure.RSA.PrivateKey(sshRsa: WebOSKey.openSSH(fromPEM: pem, passphrase: profile.passphrase))
            client = try await SSHClient.connect(
                host: profile.host, port: 9922,
                authenticationMethod: .rsa(username: "prisoner", privateKey: key),
                hostKeyValidator: .acceptAnything(), // same as ares: TV host keys are not pinned
                reconnect: .never,
                // webOS dropbear builds use RSA host keys and, on older TVs, DH group14 and AES-CTR.
                algorithms: .all,
                connectTimeout: .seconds(20))
        } catch {
            let text = errorMessage(error)
            let auth = text.matches("auth|passphrase|permission") || String(describing: error).matches("auth")
            throw toolFailure(emit, tool, auth
                ? "[ssh exec failure]: All configured authentication methods failed (\(text))"
                : "[Tips]: Unable to connect to the target device \(profile.host):9922 (\(text))")
        }
        do {
            let result = try await body(client)
            try? await client.close()
            return result
        } catch {
            try? await client.close()
            throw error
        }
    }

    static func sh(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }

    static func luna(_ client: SSHClient, _ uri: String, _ param: String, single: Bool) async throws -> String {
        let buffer = try await client.executeCommand("/usr/bin/luna-send-pub \(single ? "-n 1 " : "")-f \(uri) \(sh(param))")
        return String(buffer: buffer)
    }

    static func lunaReason(_ output: String) -> String {
        output.firstGroup(#""errorText"\s*:\s*"([^"]*)""#) ?? output.firstGroup(#""reason"\s*:\s*"([^"]*)""#) ?? output.trimmed
    }

    /// Subscribes like ares (luna-send -i) and returns nil on success or the failure reason.
    static func lunaSubscribe(_ client: SSHClient, _ uri: String, _ param: String, success: String) async throws -> String? {
        let stream = try await client.executeCommandStream("/usr/bin/luna-send-pub -i \(uri) \(sh(param))")
        var text = ""
        for try await chunk in stream {
            guard case .stdout(let b) = chunk else { continue }
            text += String(buffer: b)
            for state in states(text) {
                if state.matches("FAILED") { return lunaReason(text).isEmpty ? state : lunaReason(text) }
                if state.matches(success) { return nil }
            }
            if text.contains("\"returnValue\":false") || text.contains("\"returnValue\": false") { return lunaReason(text) }
        }
        return "luna-send closed before completion"
    }

    static func states(_ text: String) -> [String] {
        guard let re = try? NSRegularExpression(pattern: #""state"\s*:\s*"([^"]*)""#) else { return [] }
        return re.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { m in
            Range(m.range(at: 1), in: text).map { String(text[$0]) }
        }
    }

    static func listedVersion(_ output: String, _ appId: String) -> String {
        guard let data = output.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let apps = json["apps"] as? [[String: Any]] else { return "" }
        return str(apps.first { str($0["id"]) == appId }?["version"])
    }

    static func install(_ client: SSHClient, _ emit: Emit, _ packagePath: URL) async throws {
        let tempDir = "/media/developer/temp"
        let ipk = try Data(contentsOf: packagePath)
        let remote = "\(tempDir)/\(packagePath.lastPathComponent)"
        _ = try await client.executeCommand("/usr/bin/test -d \(tempDir) || /bin/mkdir -p \(tempDir)")
        emit("stdout", "Installing package \(packagePath.path)")

        let sftp = try await client.openSFTP()
        try await sftp.withFile(filePath: remote, flags: [.write, .create, .truncate]) { file in
            var offset = 0
            while offset < ipk.count {
                let end = min(offset + 32 * 1024, ipk.count)
                try await file.write(ByteBuffer(bytes: ipk[offset..<end]), at: UInt64(offset))
                offset = end
            }
        }
        // The file is already written and closed; some SFTP servers never acknowledge the channel close.
        Task { try? await sftp.close() }

        // Same transfer check as ares-install: md5 of the last 200 bytes.
        let tail = ipk.suffix(200)
        let srcMd5 = Insecure.MD5.hash(data: tail).map { String(format: "%02x", $0) }.joined()
        let dst = String(buffer: try await client.executeCommand("/usr/bin/tail -c 200 \(sh(remote)) | /usr/bin/md5sum"))
        let dstMd5 = dst.trimmed.components(separatedBy: CharacterSet(charactersIn: " -")).first ?? ""
        if !dstMd5.isEmpty && dstMd5 != srcMd5 {
            throw toolFailure(emit, "ares-install", "[Tips]: Failed to transmit package file")
        }

        let param = #"{"id":"com.ares.defaultName","ipkUrl":"\#(remote)","subscribe":true}"#
        let failure = try await lunaSubscribe(client, "luna://com.webos.appInstallService/dev/install", param, success: "installed|^SUCCESS")
        _ = try? await client.executeCommand("/bin/rm -f \(sh(remote))")
        if let failure { throw toolFailure(emit, "ares-install", "[com.webos.appInstallService failure]: luna-send command failed \(failure)") }
        emit("stdout", "Success")
    }
}
