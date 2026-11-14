import Foundation
import ZIPFoundation
import Security

/// Calls into nuvio-core.js (the desktop signing/certificate code) running in the WebView.
typealias CoreCall = (_ body: String, _ args: [String: Any]) async throws -> Any?

/// runSamsung and helpers from main.js.
struct Samsung {
    let config: InstallerConfig
    let emit: Emit
    let core: CoreCall
    let auth: () async throws -> [String: String]

    static let packageCommandComplete = "spend time|install failed|uninstall failed|download failed|check certificate error|invalid certificate chain"
    static let extensionInfoUrl = "https://download.tizen.org/sdk/tizenstudio/official/extension_info.xml"
    static var caDirectory: URL { Paths.home.appendingPathComponent("share/.samsung-cert", isDirectory: true) }
    static var caMarker: URL { caDirectory.appendingPathComponent(".extension") }
    static let caFiles = ["vd_tizen_dev_author_ca.cer", "vd_tizen_dev_public2.crt", "vd_tizen_dev_partner2.crt"]
    static var certDirectory: URL { Paths.userData.appendingPathComponent("samsung-certificates", isDirectory: true) }

    var configuredIds: [String] {
        candidates([config.tizen.appId, config.tizen.packageId ?? ""] + (config.tizen.appIds ?? []))
    }

    func candidates(_ values: [String?]) -> [String] {
        var seen = Set<String>(), out: [String] = []
        for v in values.compactMap({ $0?.trimmed }) where !v.isEmpty && seen.insert(v).inserted { out.append(v) }
        return out
    }

    // MARK: Transport

    /// connectSamsungTransport: direct connection, then the sdb fallback. sdb speaks the same protocol on
    /// port 26101, so the fallback is a fresh `sdb connect`-style session verified with getduid.
    func connectTransport(_ ip: String) async throws -> SamsungTransport {
        var transport: SamsungTransport?
        do {
            transport = try await SamsungTransport.connect(emit, ip: ip)
            _ = try await transport!.shell(emit, ["0", "getduid"], .init(timeoutMs: 8000, logOutput: false))
            return transport!
        } catch {
            transport?.close()
            emit("info", "Direct connection failed (\(errorMessage(error))). Trying sdb fallback.")
        }
        emit("command", "$ sdb connect \(ip)")
        await sleepMs(1000)
        do {
            transport = try await SamsungTransport.connect(emit, ip: ip)
            _ = try await transport!.shell(emit, ["0", "getduid"], .init(timeoutMs: 10000, logOutput: false))
            emit("info", "Detected SDB target: \(ip):26101")
            return transport!
        } catch {
            transport?.close()
            emit("stderr", errorMessage(error))
        }
        throw InstallerError("Samsung TV was not found in \"sdb devices\" after connecting to \(ip). Check Developer Mode and Host PC IP on the TV.")
    }

    func capabilities(_ t: SamsungTransport) async -> [String: String] {
        guard let out = try? await t.shell(emit, ["0", "capability"], .init(timeoutMs: 10000, logOutput: false)) else { return [:] }
        var caps: [String: String] = [:]
        for line in out.lines {
            guard let i = line.firstIndex(where: { $0 == ":" || $0 == "=" }) else { continue }
            caps[String(line[..<i]).trimmed] = String(line[line.index(after: i)...]).trimmed
        }
        return caps
    }

    // MARK: Output checks

    static func isClosedOutput(_ output: String) -> Bool {
        output.lines.contains { $0.trimmed.lowercased() == "closed" }
    }
    static func isClosedError(_ error: Error) -> Bool {
        let e = error as? InstallerError
        return isClosedOutput(e?.stdout ?? "") || isClosedOutput(e?.stderr ?? "") || errorMessage(error).matches(#"\bclosed\b"#)
    }
    static func combined(_ error: Error) -> String {
        let e = error as? InstallerError
        return "\(e?.stdout ?? "")\n\(e?.stderr ?? "")\n\(errorMessage(error))"
    }
    static func isPlatformIncompatibility(_ error: Error) -> Bool {
        (error as? InstallerError)?.code == "SAMSUNG_UNSUPPORTED_PLATFORM" || isPlatformIncompatibility(combined(error))
    }
    static func isPlatformIncompatibility(_ output: String) -> Bool {
        output.matches(#"install failed\s*\[\s*(?:118019|118\s*,\s*-?19)\s*\]"#)
    }
    static func isCertificateRejection(_ error: Error) -> Bool {
        isPlatformIncompatibility(error) ? false : isCertificateRejection(combined(error))
    }
    static func isCertificateRejection(_ output: String) -> Bool {
        if isPlatformIncompatibility(output) { return false }
        return output.matches(#"install failed\s*\[\s*(?:118012|118(?:\s*,[^\]]*)?)\s*\]"#)
            || output.matches("check certificate error") || output.matches("invalid certificate chain")
            || output.matches("Samsung TV rejected the signed package")
    }

    static func platformIncompatibilityError(_ required: String = "", _ actual: String = "") -> InstallerError {
        let modelRange = required == "5.0" ? " (Samsung TVs from 2019 onward)" : ""
        let requirement = required.isEmpty ? "This package requires a newer Samsung Tizen version. "
            : "This package requires Tizen \(required) or later\(modelRange). "
        let detected = actual.isEmpty ? "" : " The TV reported Tizen \(actual)."
        return InstallerError("This Samsung TV is not compatible with this Nuvio package. \(requirement)The standalone WGT was not installed.\(detected)",
                              code: "SAMSUNG_UNSUPPORTED_PLATFORM")
    }

    static func throwIfFailed(_ output: String, _ context: String) throws {
        let failedLine = output.lines.map(\.trimmed).first {
            $0.matches("install failed|uninstall failed|download failed|check certificate error|invalid certificate chain|error") || $0.lowercased() == "closed"
        }
        guard let failedLine else { return }
        if failedLine.lowercased() == "closed" {
            throw InstallerError("\(context): Samsung TV closed the shell command before installation completed.", stdout: output)
        }
        if isCertificateRejection(output) {
            throw InstallerError("\(context): \(failedLine)\n\nSamsung TV rejected the signed package. " +
                "The installer will retry any previous signing identities saved for this TV DUID. " +
                "The failure can indicate an invalid certificate chain, a DUID mismatch, or a signing profile with insufficient privileges.", stdout: output)
        }
        throw InstallerError("\(context): \(failedLine)", stdout: output)
    }

    // MARK: Shell helpers

    func ensureTempDirectory(_ t: SamsungTransport) async throws -> Bool {
        let note = "Samsung TV closed the generic shell setup command; continuing with direct push and vd_appinstall."
        do {
            let output = try await t.shell(emit, ["0", "mkdir", "-p", "/home/owner/share/tmp/sdk_tools"], .init(noOutputSuccessMs: 1500))
            if Self.isClosedOutput(output) { emit("info", note); return false }
            return true
        } catch {
            if Self.isClosedError(error) { emit("info", note); return false }
            throw error
        }
    }

    func push(_ t: SamsungTransport, _ local: URL, _ remote: String) async throws {
        emit("command", "$ adbhost push \(local.path) \(remote)")
        try await t.push(remote, try Data(contentsOf: local))
    }

    func verifyRemotePackage(_ t: SamsungTransport, _ local: URL, _ remote: String) async throws {
        let expected = (try? FileManager.default.attributesOfItem(atPath: local.path)[.size] as? Int) ?? 0
        let closedNote = "Samsung package upload check was closed by the TV; continuing because the push command completed."
        let output: String
        do {
            output = try await t.shell(emit, ["0", "ls", "-l", remote], .init(timeoutMs: 10000, idleAfterDataMs: 800, noOutputSuccessMs: 2500))
        } catch {
            if Self.isClosedError(error) { emit("info", closedNote); return }
            throw error
        }
        if Self.isClosedOutput(output) { emit("info", closedNote); return }
        let parts = output.trimmed.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" })
        let remoteSize = parts.count > 4 ? Int(parts[4]) ?? 0 : 0
        if remoteSize == 0 {
            emit("info", "Samsung package upload check did not return a remote size; continuing because the push command completed.")
            return
        }
        if remoteSize != expected { throw InstallerError("Samsung package upload failed: remote size \(remoteSize), expected \(expected).") }
        emit("info", "Samsung package uploaded correctly (\(remoteSize) bytes).")
    }

    func readPlatformVersion(_ t: SamsungTransport) async -> String {
        do {
            let out = try await t.shell(emit, ["0", "capability"], .init(timeoutMs: 10000))
            return out.firstGroup(#"(?:^|\n)\s*platform_version\s*[:=]\s*([^\s\r\n]+)"#)?.trimmed ?? ""
        } catch {
            emit("info", "Samsung platform capability check was unavailable; continuing with package validation. \(errorMessage(error))")
            return ""
        }
    }

    func validatePlatformVersion(_ t: SamsungTransport, _ required: String) async throws {
        guard !required.isEmpty else { return }
        let actual = await readPlatformVersion(t)
        if actual.isEmpty {
            emit("info", "Samsung TV did not expose platform_version; the installer will continue without guessing the TV version.")
            return
        }
        if let c = compareTizenVersions(actual, required), c < 0 { throw Self.platformIncompatibilityError(required, actual) }
        emit("info", "Samsung TV reports Tizen \(actual); package requires Tizen \(required) or later.")
    }

    func getDuid(_ t: SamsungTransport) async throws -> String {
        let out = try await t.shell(emit, ["0", "getduid"], .init(timeoutMs: 10000))
        guard let duid = out.lines.map(\.trimmed).first(where: { !$0.isEmpty }) else {
            throw InstallerError("Unable to read the Samsung TV DUID.")
        }
        emit("info", "Detected Samsung DUID: \(duid)")
        return duid
    }

    // MARK: App list

    static func parseAppList(_ output: String) -> [[String: String]] {
        output.components(separatedBy: "---------------------------------------------------------------------------------------------")
            .map { $0.replacingOccurrences(of: "--------------", with: "").replacingOccurrences(of: "-------------", with: "")
                .replacingRegex(#"\s+="#, with: "=").replacingOccurrences(of: "\r", with: "").trimmed }
            .filter { !$0.isEmpty }
            .map { entry in
                var app: [String: String] = [:]
                for line in entry.components(separatedBy: "\n") {
                    guard let i = line.firstIndex(of: "="), i != line.startIndex else { continue }
                    app[String(line[..<i]).trimmed] = String(line[line.index(after: i)...]).trimmed
                }
                return app
            }
            .filter { !$0.isEmpty }
    }

    func findInstalled(_ t: SamsungTransport, _ identifiers: [String]) async throws -> [String: String]? {
        let ids = candidates(identifiers)
        if ids.isEmpty { return nil }
        let out = try await t.shell(emit, ["0", "vd_applist"], .init(timeoutMs: 30000, logOutput: false))
        return Self.parseAppList(out).first { app in
            [app["app_id"], app["app_tizen_id"], app["app_package_id"], app["package_id"]].contains { ids.contains(($0 ?? "").trimmed) }
        }
    }

    func verifyInstalled(_ t: SamsungTransport, _ metadata: [String: String]) async throws {
        let installed: [String: String]?
        do {
            installed = try await findInstalled(t, candidates([metadata["packageId"], metadata["appId"]]))
        } catch {
            emit("info", "Samsung install verification could not read the installed app list: \(errorMessage(error))")
            throw InstallerError("The Samsung install command finished, but the installer could not verify that Nuvio TV is installed on the TV. " +
                "Retry the install, or install the WGT with Tizen Studio/sdb using vd_appinstall.")
        }
        guard let app = installed else {
            throw InstallerError("The Samsung install command finished but Nuvio TV is not installed on the TV. " +
                "The package was uploaded but not registered; retry the install, or install the WGT with Tizen Studio/sdb using vd_appinstall.")
        }
        let installedVersion = (app["app_version"] ?? "").trimmed
        let expected = (metadata["version"] ?? "").trimmed
        if let c = compareTizenVersions(installedVersion, expected), c != 0 {
            throw InstallerError("The Samsung install command finished but the TV still reports Nuvio TV \(installedVersion), expected \(expected). " +
                "The update was not applied; retry the install, or install the WGT with Tizen Studio/sdb using vd_appinstall.")
        }
        let label = [app["app_id"], app["app_tizen_id"], metadata["appId"], metadata["packageId"]].compactMap { $0 }.first { !$0.isEmpty } ?? ""
        emit("info", "Verified Samsung installation on the TV: \(label)\(installedVersion.isEmpty ? "" : " (\(installedVersion))").")
    }

    // MARK: Package inspection (JS core)

    /// Only the text files the validators read cross into the WebView.
    static let inspectedFiles: Set<String> = ["config.xml", "tizen-manifest.xml", "main.js", "index.html",
        "services/tizen/enginefs-service.js", "services/tizen/plugin-service.js"]

    func coreEntries(_ entries: [ZipEntryData]) -> [String: Any] {
        var out: [String: Any] = [:]
        for e in entries {
            var item: [String: Any] = ["dir": e.isDirectory]
            if Self.inspectedFiles.contains(e.name) { item["text"] = String(decoding: e.data, as: UTF8.self) }
            out[e.name] = item
        }
        return out
    }

    func metadata(_ url: URL) async throws -> [String: String] {
        let entries = try Zip.read(Data(contentsOf: url))
        let result = try await core("return await __nuvioCore.metadata(entries)", ["entries": coreEntries(entries)])
        return (result as? [String: Any] ?? [:]).mapValues { "\($0)" }
    }

    /// prepareSamsungPackage: normalize id, check platform and services, pick certificates.
    func prepare(_ t: SamsungTransport, _ packagePath: URL, _ options: [String: Any]) async throws -> (URL, String, [Candidate]) {
        var path = packagePath
        var entries = try Zip.read(Data(contentsOf: path))
        let inspected = try await core("return await __nuvioCore.inspect(entries)", ["entries": coreEntries(entries)]) as? [String: Any] ?? [:]
        for log in inspected["logs"] as? [[String: String]] ?? [] { emit(log["type"] ?? "info", log["text"] ?? "") }
        if let normalized = inspected["normalizedConfig"] as? String {
            entries = entries.map { $0.name == "config.xml" ? ZipEntryData(name: $0.name, isDirectory: false, data: Data(normalized.utf8)) : $0 }
            let dir = Paths.userData.appendingPathComponent("prepared")
            try Paths.ensureDir(dir)
            let base = path.deletingPathExtension().lastPathComponent, ext = path.pathExtension.isEmpty ? "wgt" : path.pathExtension
            path = dir.appendingPathComponent("\(base)-samsung-normalized-\(Int(Date().timeIntervalSince1970 * 1000)).\(ext)")
            try Zip.write(entries.filter { !$0.isDirectory }.map { ($0.name, $0.data) }).write(to: path)
        }
        let metadata = (inspected["metadata"] as? [String: Any] ?? [:]).mapValues { "\($0)" }
        try await validatePlatformVersion(t, metadata["requiredVersion"] ?? "")
        let logs = try await core("return await __nuvioCore.validate(entries)", ["entries": coreEntries(entries)]) as? [[String: String]] ?? []
        for log in logs { emit(log["type"] ?? "info", log["text"] ?? "") }
        let (duid, candidates) = try await certificateCandidates(t, options)
        return (path, duid, candidates)
    }

    // MARK: Certificates

    struct Candidate { var config: [String: Any]; let path: URL?; let priority: Int; let createdAt: Double }

    static func configPath(target: String) -> URL {
        certDirectory.appendingPathComponent("\(target.isEmpty ? "default" : target.replacingRegex("[^a-z0-9_.-]+", with: "_")).json")
    }
    static func configPath(duid: String) -> URL {
        certDirectory.appendingPathComponent("duid-\(sha256Hex(Data(duid.utf8))).json")
    }
    static func fingerprint(_ c: [String: Any]) -> String {
        let a = c["authorCert"] as? String ?? ""
        return a.isEmpty ? "" : sha256Hex(Data(a.utf8))
    }
    static func isUsable(_ c: [String: Any]?, duid: String = "") -> Bool {
        guard let c else { return false }
        let has = { (k: String) in !((c[k] as? String) ?? "").isEmpty }
        return has("authorCert") && has("distributorCert") && has("password") && (duid.isEmpty || (c["duid"] as? String) == duid)
    }
    static func readConfig(_ url: URL) -> [String: Any]? {
        guard let d = try? Data(contentsOf: url) else { return nil }
        return try? JSONSerialization.jsonObject(with: d) as? [String: Any]
    }
    static func writeConfig(_ url: URL, _ c: [String: Any]) throws {
        try Paths.ensureDir(url.deletingLastPathComponent())
        let data = try JSONSerialization.data(withJSONObject: c, options: [.prettyPrinted])
        try data.write(to: url, options: [.atomic, .completeFileProtection])
    }

    func hasValidAuthorChain(_ c: [String: Any]) async -> Bool {
        (try? await core("return __nuvioCore.hasValidSamsungAuthorChain(a, p)",
                         ["a": c["authorCert"] as? String ?? "", "p": c["password"] as? String ?? ""])) as? Bool ?? false
    }

    func readCandidates(duid: String, target: String, invalid: inout [URL]) async -> [Candidate] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: Self.certDirectory.path) else { return [] }
        let canonical = Self.configPath(duid: duid), targetPath = Self.configPath(target: target)
        var list: [Candidate] = []
        for name in names where name.lowercased().hasSuffix(".json") {
            let url = Self.certDirectory.appendingPathComponent(name)
            guard let c = Self.readConfig(url), Self.isUsable(c, duid: duid) else { continue }
            if ((c["profileName"] as? String) ?? "").isEmpty, !(await hasValidAuthorChain(c)) { invalid.append(url); continue }
            list.append(Candidate(config: c, path: url, priority: url == canonical ? 0 : (url == targetPath ? 1 : 2),
                                  createdAt: parseISODate(c["createdAt"] as? String)))
        }
        list.sort { $0.priority != $1.priority ? $0.priority < $1.priority : $0.createdAt > $1.createdAt }
        var seen = Set<String>()
        return list.filter { let f = Self.fingerprint($0.config); return !f.isEmpty && seen.insert(f).inserted }
    }

    func manualCertificate(_ options: [String: Any]) throws -> [String: Any]? {
        guard let manual = options["samsungCert"] as? [String: Any], (manual["auto"] as? Bool) == false else { return nil }
        let profileName = LG.str(manual["profileName"]).trimmed
        // Tizen Studio is a desktop program: on iOS a security profile is used through its own
        // author/distributor .p12 files (tizen-studio-data/keystore), signed with the built-in signer.
        let missing = ["authorPath", "distributorPath", "password"].filter { LG.str(manual[$0]).trimmed.isEmpty }
        if !profileName.isEmpty && !missing.isEmpty {
            throw InstallerError("Tizen Studio security profile \"\(profileName)\": on iPhone/iPad select the profile's Author Certificate (.p12), " +
                "Distributor Certificate (.p12) and Certificate Password (from tizen-studio-data/keystore on your computer) to sign with it.")
        }
        let authorPath = try requireValue(LG.str(manual["authorPath"]), "Samsung author certificate")
        let distributorPath = try requireValue(LG.str(manual["distributorPath"]), "Samsung distributor certificate")
        let password = try requireValue(LG.str(manual["password"]), "Samsung certificate password")
        return ["authorCert": try Data(contentsOf: URL(fileURLWithPath: authorPath)).base64EncodedString(),
                "distributorCert": try Data(contentsOf: URL(fileURLWithPath: distributorPath)).base64EncodedString(),
                "distributorXML": "", "password": password, "profileName": "", "profileLabel": profileName,
                "duid": "", "createdAt": isoNow()]
    }

    func certificateCandidates(_ t: SamsungTransport, _ options: [String: Any]) async throws -> (String, [Candidate]) {
        if let manual = try manualCertificate(options) {
            emit("info", "Using the Samsung certificates selected manually.")
            return ("", [Candidate(config: manual, path: nil, priority: 0, createdAt: Date().timeIntervalSince1970 * 1000)])
        }
        let duid = try await getDuid(t)
        var invalid: [URL] = []
        let list = await readCandidates(duid: duid, target: t.target, invalid: &invalid)
        if !invalid.isEmpty {
            emit("info", "Ignoring \(invalid.count) saved Samsung signing identit\(invalid.count == 1 ? "y" : "ies") with an invalid certificate chain; a new certificate will be created.")
        }
        if !list.isEmpty {
            emit("info", list.count == 1 ? "Using the Samsung certificate already saved for this TV DUID."
                 : "Found \(list.count) saved Samsung signing identities for this TV DUID; previous identities will be available for update recovery.")
            return (duid, list)
        }
        if let existing = Self.readConfig(Self.configPath(target: t.target)), let d = existing["duid"] as? String, !d.isEmpty, d != duid {
            emit("info", "Saved Samsung certificate belongs to a different TV, creating a new one.")
        }
        let created = try await createCertificate(t, duid: duid)
        return (duid, [Candidate(config: created, path: Self.configPath(duid: duid), priority: 0,
                                 createdAt: parseISODate(created["createdAt"] as? String))])
    }

    // ensureSamsungCertificateAuthorities
    func cachedAuthorities() -> Bool {
        Self.caFiles.allSatisfy { FileManager.default.fileExists(atPath: Self.caDirectory.appendingPathComponent($0).path) }
    }

    func extensionRepository() async throws -> String {
        let (data, resp) = try await HTTP.get(Self.extensionInfoUrl, headers: ["User-Agent": "Nuvio-TV-Installer"], timeout: 30)
        guard (200..<300).contains(resp.statusCode) else {
            throw InstallerError("Samsung certificate extension info failed: \(resp.statusCode) \(HTTP.statusText(resp.statusCode))")
        }
        let xml = String(decoding: data, as: UTF8.self)
        // <extension id="..."> carries attributes, so split on the tag pattern.
        let blocks = xml.replacingRegex(#"<extension\b[^>]*>"#, with: "\u{1}").components(separatedBy: "\u{1}")
        for block in blocks.dropFirst() {
            let name = block.firstGroup(#"<name>([\s\S]*?)</name>"#)?.trimmed
            if name == "Samsung Certificate Extension", let repo = block.firstGroup(#"<repository>([\s\S]*?)</repository>"#)?.trimmed, !repo.isEmpty {
                return repo
            }
        }
        throw InstallerError("Samsung certificate extension info did not contain a repository.")
    }

    func ensureAuthorities() async throws {
        let repository: String
        do { repository = try await extensionRepository() } catch {
            if cachedAuthorities() {
                emit("info", "Could not check for a newer Samsung certificate extension; using the cached certificate authorities. \(errorMessage(error))")
                return
            }
            throw error
        }
        let marker = (try? String(contentsOf: Self.caMarker, encoding: .utf8))?.trimmed ?? ""
        if repository == marker && cachedAuthorities() { return }

        emit("info", "The cached Samsung certificate authorities are out of date; refreshing them before signing.")
        let archive = Paths.temp.appendingPathComponent("nuvio-samsung-certificate-extension-\(Int(Date().timeIntervalSince1970 * 1000)).zip")
        defer { try? FileManager.default.removeItem(at: archive) }
        try await HTTP.downloadFile(emit, repository, to: archive, progressLabel: "Downloading Samsung certificate authorities")
        let outer = try Zip.read(Data(contentsOf: archive))
        guard let addon = outer.first(where: { $0.name.hasSuffix(".zip") }) else {
            throw InstallerError("The Samsung certificate extension did not contain an add-on package.")
        }
        guard let jar = try Zip.read(addon.data).first(where: { $0.name.hasSuffix(".jar") }) else {
            throw InstallerError("The Samsung certificate extension did not contain a certificate manager.")
        }
        let certs = try Zip.read(jar.data).filter { $0.name.matches(#"\.(crt|cer)$"#) }
        if certs.isEmpty { throw InstallerError("The Samsung certificate extension did not contain certificate authorities.") }
        try Paths.ensureDir(Self.caDirectory)
        try? FileManager.default.removeItem(at: Self.caMarker)
        for name in (try? FileManager.default.contentsOfDirectory(atPath: Self.caDirectory.path)) ?? [] where name.matches(#"\.(crt|cer)$"#) {
            try? FileManager.default.removeItem(at: Self.caDirectory.appendingPathComponent(name))
        }
        for c in certs { try c.data.write(to: Self.caDirectory.appendingPathComponent((c.name as NSString).lastPathComponent)) }
        try repository.write(to: Self.caMarker, atomically: true, encoding: .utf8)
    }

    func createCertificate(_ t: SamsungTransport, duid: String) async throws -> [String: Any] {
        let accessInfo = try await auth()
        let accessToken = accessInfo["access_token"] ?? accessInfo["accessToken"] ?? ""
        let userId = accessInfo["userId"] ?? accessInfo["user_id"] ?? ""
        if accessToken.isEmpty || userId.isEmpty {
            throw InstallerError("Samsung did not return valid authorization data. Try signing in again.")
        }
        var bytes = [UInt8](repeating: 0, count: 18)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let password = Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let email = accessInfo["inputEmailID"].flatMap { $0.isEmpty ? nil : $0 } ?? accessInfo["email"].flatMap { $0.isEmpty ? nil : $0 } ?? userId
        let authorInfo: [String: Any] = ["name": "Nuvio", "email": email, "password": password, "privilegeLevel": "Partner"]

        try await ensureAuthorities()
        emit("info", "Creating the Samsung certificate for this TV. This may take 30-60 seconds.")
        let requests = try await core("return __nuvioCore.createRequests(info, duids)", ["info": authorInfo, "duids": [duid]]) as? [String: Any] ?? [:]
        let authorCsr = (requests["author"] as? [String: Any])?["csr"] as? String ?? ""
        let distributorCsr = (requests["distributor"] as? [String: Any])?["csr"] as? String ?? ""

        func post(_ path: String, _ extra: [(String, String)], _ csr: String, _ filename: String, _ label: String) async throws -> String {
            let (data, resp) = try await HTTP.multipart("https://svdca.samsungqbe.com/apis/v3/\(path)",
                fields: [("access_token", accessToken), ("user_id", userId), ("platform", "VD")] + extra,
                file: ("csr", filename, Data(csr.utf8)))
            let text = String(decoding: data, as: UTF8.self)
            guard (200..<300).contains(resp.statusCode) else { throw InstallerError("Failed to fetch \(label) certificate\n\(text)") }
            return text
        }
        let distributorFields = [("privilege_level", "Partner"), ("developer_type", "Individual")]
        let authorVD = try await post("authors", [], authorCsr, "author.csr", "author")
        let distributorXML = try await post("distributors", distributorFields, distributorCsr, "distributor.csr", "distributor")
        let distributorVD = try await post("distributors", distributorFields, distributorCsr, "distributor.csr", "distributor")

        var caTexts: [String: String] = [:]
        for f in Self.caFiles { caTexts[f] = (try? String(contentsOf: Self.caDirectory.appendingPathComponent(f), encoding: .utf8)) ?? "" }
        let built = try await core("return __nuvioCore.buildPkcs12(req, a, d, info, ca)",
                                   ["req": requests, "a": authorVD, "d": distributorVD, "info": authorInfo, "ca": caTexts]) as? [String: Any] ?? [:]
        let authorCert = built["authorCert"] as? String ?? "", distributorCert = built["distributorCert"] as? String ?? ""
        if authorCert.isEmpty || distributorCert.isEmpty { throw InstallerError("Samsung did not return a valid certificate.") }

        let certificateConfig: [String: Any] = [
            "authorCert": authorCert, "distributorCert": distributorCert,
            "distributorXML": distributorXML.isEmpty ? "" : Data(distributorXML.utf8).base64EncodedString(),
            "password": password, "duid": duid, "createdAt": isoNow()
        ]
        if !(await hasValidAuthorChain(certificateConfig)) {
            throw InstallerError("Samsung issued an author certificate that does not match the downloaded certificate authorities. " +
                "To avoid producing a WGT the TV would reject, the certificate was not saved; retry the install.")
        }
        try Self.writeConfig(Self.configPath(duid: duid), certificateConfig)
        try Self.writeConfig(Self.configPath(target: t.target), certificateConfig)

        if !distributorXML.isEmpty {
            let profile = Self.certDirectory.appendingPathComponent("\(t.target.replacingRegex("[^a-z0-9_.-]+", with: "_"))-device-profile.xml")
            try distributorXML.write(to: profile, atomically: true, encoding: .utf8)
            do {
                _ = try await ensureTempDirectory(t)
                try await push(t, profile, "/home/owner/share/tmp/sdk_tools/device-profile.xml")
            } catch {
                emit("info", "Skipping Samsung device profile upload because the TV rejected the helper path: \(errorMessage(error))")
            }
        }
        emit("success", "Samsung certificate created and saved for this TV.")
        return certificateConfig
    }

    func markSuccessful(_ t: SamsungTransport, duid: String, _ c: [String: Any], _ metadata: [String: String]) {
        guard !duid.isEmpty, Self.isUsable(c, duid: duid) else { return }
        var persisted = c
        persisted["duid"] = duid
        persisted["lastSuccessfulInstallAt"] = isoNow()
        persisted["lastSuccessfulPackageId"] = metadata["packageId"] ?? ""
        do {
            try Self.writeConfig(Self.configPath(duid: duid), persisted)
            try Self.writeConfig(Self.configPath(target: t.target), persisted)
            emit("success", "Saved the working Samsung signing identity for future updates on this TV DUID.")
        } catch {
            emit("error", "The app was installed, but the working Samsung certificate could not be saved for the next update: \(errorMessage(error))")
        }
    }

    func describe(_ c: Candidate, _ index: Int, _ total: Int) -> String {
        if let p = c.config["profileName"] as? String, !p.isEmpty { return "Tizen Studio profile \"\(p)\"" }
        if let p = c.config["profileLabel"] as? String, !p.isEmpty { return "Tizen Studio profile \"\(p)\" certificates" }
        let f = String(Self.fingerprint(c.config).prefix(12))
        return "saved identity \(index + 1)/\(total)\(f.isEmpty ? "" : " (\(f))")"
    }

    // MARK: Signing

    func resign(_ packagePath: URL, _ c: [String: Any]) async throws -> URL {
        if let p = c["profileName"] as? String, !p.isEmpty {
            // signTizenPackageWithStudioProfile needs the Tizen Studio CLI, which does not exist on iOS.
            throw InstallerError("Tizen Studio CLI was not found. Install Tizen Studio or leave the profile name empty to use the built-in signer.")
        }
        emit("info", "Automatically signing the WGT with the saved Samsung certificate.")
        let entries = try Zip.read(Data(contentsOf: packagePath))
        let unsigned = entries.filter { !$0.isDirectory && $0.name != "author-signature.xml" && $0.name != "signature1.xml" }
        let files = unsigned.map { ["name": $0.name, "digest": sha512Base64($0.data)] }
        let signed = try await core("return await __nuvioCore.sign(files, a, d, p)", [
            "files": files, "a": c["authorCert"] as? String ?? "", "d": c["distributorCert"] as? String ?? "", "p": c["password"] as? String ?? ""
        ]) as? [[String: Any]] ?? []
        var byName: [String: Data] = [:]
        unsigned.forEach { byName[$0.name] = $0.data }
        let output = try signed.map { item -> (String, Data) in
            let name = item["name"] as? String ?? ""
            if let xml = item["xml"] as? String { return (name, Data(xml.utf8)) }
            guard let data = byName[name] else { throw InstallerError("Signed package is missing \(name).") }
            return (name, data)
        }
        let dir = Paths.userData.appendingPathComponent("resigned")
        try Paths.ensureDir(dir)
        let base = packagePath.deletingPathExtension().lastPathComponent, ext = packagePath.pathExtension.isEmpty ? "wgt" : packagePath.pathExtension
        let target = dir.appendingPathComponent("\(base)-samsung-signed-\(Int(Date().timeIntervalSince1970 * 1000)).\(ext)")
        try Zip.write(output).write(to: target)
        emit("info", "Automatically signed WGT: \(target.path)")
        return target
    }

    // MARK: Install / launch / uninstall

    func installPackage(_ t: SamsungTransport, _ packagePath: URL) async throws -> [String: String] {
        let metadata = try await metadata(packagePath)
        let installIds = candidates([metadata["packageId"], metadata["appId"]])
        if installIds.isEmpty { throw InstallerError("Unable to read the application id or package id from the Tizen package.") }
        let remote = "/home/owner/share/tmp/sdk_tools/nuvio-package.\(metadata["extension"] ?? "wgt")"
        emit("info", "Detected package id: \(metadata["packageId"] ?? "")")
        if let appId = metadata["appId"], !appId.isEmpty { emit("info", "Detected application id: \(appId)") }

        if try await ensureTempDirectory(t) {
            var cleanup = ""
            do { cleanup = try await t.shell(emit, ["0", "rm", "-f", remote], .init(noOutputSuccessMs: 1500)) }
            catch { cleanup = Self.isClosedError(error) ? "closed" : "" }
            if Self.isClosedOutput(cleanup) {
                emit("info", "Samsung TV closed the cleanup shell command; continuing because push can overwrite the package.")
            }
        }
        try await push(t, packagePath, remote)
        try await verifyRemotePackage(t, packagePath, remote)

        return try await appInstall(t, metadata, installIds, remote)
    }

    /// vd_appinstall with the package id, then the app id, verifying the TV app list afterwards.
    func appInstall(_ t: SamsungTransport, _ metadata: [String: String], _ installIds: [String], _ remote: String) async throws -> [String: String] {
        var lastError: Error?, certificateError: Error?
        for installId in installIds {
            do {
                let out = try await t.shell(emit, ["0", "vd_appinstall", installId, remote],
                                            .init(timeoutMs: 180000, completeWhen: Self.packageCommandComplete))
                try Self.throwIfFailed(out, "vd_appinstall failed with \(installId)")
                try await verifyInstalled(t, metadata)
                return metadata
            } catch {
                if Self.isPlatformIncompatibility(error) { throw Self.platformIncompatibilityError(metadata["requiredVersion"] ?? "") }
                if Self.isCertificateRejection(error) {
                    certificateError = certificateError ?? error
                    emit("info", "Samsung rejected \(installId); trying the next Samsung identifier before reporting a certificate error.")
                    continue
                }
                lastError = error
                emit("error", "vd_appinstall with \(installId) failed: \(errorMessage(error))")
                emit("info", "Trying the next Samsung identifier if available.")
            }
        }
        throw certificateError ?? lastError ?? InstallerError("vd_appinstall failed.")
    }

    func launch(_ t: SamsungTransport) async throws {
        let app = try await findInstalled(t, configuredIds)
        let launchId = app?["app_id"] ?? app?["app_tizen_id"] ?? configuredIds.first
        guard let launchId, !launchId.isEmpty else {
            throw InstallerError("Samsung app was not found. Install Nuvio or check appId in installer.config.json.")
        }
        let out = try await t.shell(emit, ["0", "was_execute", launchId])
        try Self.throwIfFailed(out, "Samsung app launch failed")
    }

    /// What `sdb install` does on a TV: push the package with the checked sync protocol into the
    /// TV's sdk_toolpath, then vd_appinstall.
    func sdbInstall(_ t: SamsungTransport, _ packagePath: URL) async throws -> [String: String] {
        let metadata = try await metadata(packagePath)
        let installIds = candidates([metadata["packageId"], metadata["appId"]])
        if installIds.isEmpty { throw InstallerError("Unable to read the application id or package id from the Tizen package.") }
        emit("command", "$ sdb -s \(t.target):26101 install \(packagePath.path)")
        let caps = await capabilities(t)
        let defaultDir = (caps["platform_version"] ?? "").hasPrefix("2.") ? "/opt/usr/apps/tmp" : "/home/owner/share/tmp/sdk_tools"
        var dir = caps["sdk_toolpath"].flatMap { $0.isEmpty ? nil : $0 } ?? defaultDir
        while dir.hasSuffix("/") { dir.removeLast() }
        let remote = "\(dir)/nuvio-package.\(metadata["extension"] ?? "wgt")"
        let data = try Data(contentsOf: packagePath)
        try await t.pushChecked(remote, data)
        emit("stdout", "pushed \(packagePath.lastPathComponent) 100% (\(data.count) bytes)")
        try await verifyRemotePackage(t, packagePath, remote)
        return try await appInstall(t, metadata, installIds, remote)
    }

    /// What `sdb uninstall` does on a TV: vd_appuninstall. The TV may answer nothing even when it
    /// refuses, so the result is decided by the app list afterwards.
    func uninstall(_ t: SamsungTransport) async throws {
        guard let app = try await findInstalled(t, configuredIds) else {
            throw InstallerError("Nuvio TV is not installed on this TV.")
        }
        let ids = candidates([app["app_package_id"], app["package_id"], app["app_package_name"], app["app_id"], app["app_tizen_id"]] + configuredIds)
        var lastOutput = ""
        for id in ids {
            emit("command", "$ sdb -s \(t.target):26101 uninstall \(id)")
            do {
                lastOutput = try await t.shell(emit, ["0", "vd_appuninstall", id],
                    .init(timeoutMs: 120000, completeWhen: "spend time|uninstall completed|uninstall failed|can not uninstall"))
            } catch {
                lastOutput = errorMessage(error)
            }
            if try await findInstalled(t, configuredIds) == nil {
                emit("info", "Verified: Nuvio TV is no longer installed on the TV.")
                return
            }
            emit("info", "Nuvio TV is still installed after uninstalling \(id); trying the next Samsung identifier if available.")
        }
        let line = lastOutput.lines.map(\.trimmed).last(where: { !$0.isEmpty }) ?? ""
        throw InstallerError("The TV did not remove Nuvio TV\(line.isEmpty ? " (no answer from vd_appuninstall)" : ": \(line)"). " +
            "Remove it from the TV instead: Apps, Settings, Nuvio, Delete.")
    }

    /// startSamsungLogCapture: debug launch, then the CDP target on the TV.
    func startLogs(_ ip: String) async throws -> [String: Any] {
        let t = try await connectTransport(ip)
        defer { t.close() }
        let app = try await findInstalled(t, configuredIds)
        guard let appId = candidates([app?["app_tizen_id"], app?["app_id"]] + configuredIds).first(where: { $0.contains(".") }) else {
            throw InstallerError("Samsung app was not found. Install Nuvio first.")
        }
        let isTizen3 = compareTizenVersions(await readPlatformVersion(t), "4.0") == -1
        let out = try await t.shell(emit, ["0", "debug", appId] + (isTizen3 ? ["0"] : []),
                                    .init(timeoutMs: 30000, completeWhen: #"debug[\s\S]*:\s*\d{2,5}"#))
        let port = out.matches("debug") ? Int(out.firstGroup(#":\s*(\d{2,5})"#) ?? "") ?? 0 : 0
        if port == 0 {
            throw InstallerError("Samsung TV did not open a debug port. Check that Host PC IP on the TV matches this computer. Output: \(out.trimmed.isEmpty ? "(empty)" : out.trimmed)")
        }
        emit("info", "Nuvio started in debug mode on port \(port).")
        var lastError: Error?
        for _ in 0..<10 {
            do {
                let (data, _) = try await HTTP.get("http://\(ip):\(port)/json", timeout: 3)
                let targets = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] ?? []
                let ws = targets.first { $0["webSocketDebuggerUrl"] != nil }?["webSocketDebuggerUrl"] as? String ?? ""
                guard let path = URL(string: ws)?.path, !path.isEmpty else { throw InstallerError("Invalid URL") }
                return ["ok": true, "wsUrl": "ws://\(ip):\(port)\(path)"]
            } catch {
                lastError = error
                await sleepMs(1000)
            }
        }
        throw InstallerError("Unable to reach the app inspector on \(ip):\(port): \(lastError.map(errorMessage) ?? "")")
    }

    func run(action: String, options: [String: Any]) async throws {
        let ip = try requireValue(LG.str(options["ip"]), "IP Samsung TV")
        let t = try await connectTransport(ip)
        defer { t.close() }

        if action == "uninstall" { try await uninstall(t); return }
        if action == "launch" { try await launch(t); return }
        if action == "update" {
            let app = try await findInstalled(t, configuredIds)
            if try await Releases.isAlreadyUpToDate(config, emit, installed: (app?["app_version"] ?? "").trimmed, releaseId: LG.str(options["releaseId"])) { return }
        }

        let packagePathOption = LG.str(options["packagePath"])
        let packagePath = packagePathOption.isEmpty
            ? try await Releases.resolveAsset(config, emit, platform: "tizen", releaseId: LG.str(options["releaseId"]))
            : URL(fileURLWithPath: packagePathOption)
        let (preparedPath, duid, list) = try await prepare(t, packagePath, options)
        var directInstallError: Error?
        var lastInstallPath: URL?
        var activeConfig: [String: Any]?

        for (index, candidate) in list.enumerated() {
            let description = describe(candidate, index, list.count)
            emit("info", "Signing Samsung package with \(description).")
            let installPath: URL
            do {
                installPath = try await resign(preparedPath, candidate.config)
            } catch {
                if index + 1 < list.count {
                    emit("info", "Could not use \(description); trying the next saved identity. \(errorMessage(error))")
                    continue
                }
                throw error
            }
            lastInstallPath = installPath
            activeConfig = candidate.config
            do {
                let installed = try await installPackage(t, installPath)
                markSuccessful(t, duid: duid, candidate.config, installed)
                directInstallError = nil
                break
            } catch {
                directInstallError = error
                if Self.isCertificateRejection(error) && index + 1 < list.count {
                    emit("info", "Samsung rejected \(description); retrying with the previous signing identity saved for this TV DUID.")
                    continue
                }
                break
            }
        }

        if let error = directInstallError {
            if Self.isPlatformIncompatibility(error) { throw error }
            if Self.isCertificateRejection(error) {
                throw InstallerError("\(errorMessage(error))\n\nTried \(list.count) saved signing \(list.count == 1 ? "identity" : "identities") for this TV. " +
                    "The TV did not accept any available signing identity. Keep the working author certificate for future updates and, if this is a new installation, verify the Samsung certificate/profile and TV DUID.")
            }
            emit("error", "Samsung direct package install failed before fallback: \(errorMessage(error))")
            emit("info", "vd_appinstall failed on direct connection, trying fallback with sdb install.")
            t.close()
            guard let installPath = lastInstallPath else { throw error }
            let fallback = try await connectTransport(ip)
            defer { fallback.close() }
            let installed = try await sdbInstall(fallback, installPath)
            markSuccessful(fallback, duid: duid, activeConfig ?? [:], installed)
        }

        emit("info", "If you want to use debug/autolaunch, set Host PC IP to 127.0.0.1 on the TV after installation.")
    }
}
