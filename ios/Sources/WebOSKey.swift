import Foundation
import CommonCrypto
import CryptoKit

/// Turns the encrypted PKCS#1 PEM served by the TV on :9991/webos_rsa into an
/// unencrypted OpenSSH private key string (the format Citadel can parse).
enum WebOSKey {
    struct Failure: LocalizedError {
        let errorDescription: String?
        init(_ m: String) { errorDescription = m }
    }

    static func download(host: String) async throws -> String {
        let url = URL(string: "http://\(host):9991/webos_rsa")!
        var req = URLRequest(url: url)
        req.timeoutInterval = 10
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200, let pem = String(data: data, encoding: .utf8) else {
            throw Failure("Failed to get the SSH private key from \(host):9991. Check that Developer Mode is enabled and Key Server is ON.")
        }
        return pem
    }

    static func openSSH(fromPEM pem: String, passphrase: String) throws -> String {
        let der = try decryptPEM(pem, passphrase: passphrase)
        let ints = try parsePKCS1(der) // version, n, e, d, p, q, dp, dq, iqmp
        guard ints.count >= 9 else { throw Failure("Invalid RSA private key.") }
        let (n, e, d, p, q, iqmp) = (ints[1], ints[2], ints[3], ints[4], ints[5], ints[8])

        var pub = Data()
        pub.sshString("ssh-rsa"); pub.sshMPInt(e); pub.sshMPInt(n)

        var priv = Data()
        let check = UInt32.random(in: 0...UInt32.max)
        priv.u32(check); priv.u32(check)
        priv.sshString("ssh-rsa")
        for x in [n, e, d, iqmp, p, q] { priv.sshMPInt(x) }
        priv.sshString("webos")
        var pad: UInt8 = 1
        while priv.count % 8 != 0 { priv.append(pad); pad += 1 }

        var out = Data("openssh-key-v1\0".utf8)
        out.sshString("none"); out.sshString("none"); out.sshString("")
        out.u32(1)
        out.sshBytes(pub)
        out.sshBytes(priv)

        let b64 = out.base64EncodedString(options: [.lineLength64Characters, .endLineWithLineFeed])
        return "-----BEGIN OPENSSH PRIVATE KEY-----\n\(b64)\n-----END OPENSSH PRIVATE KEY-----\n"
    }

    static func decryptPEM(_ pem: String, passphrase: String) throws -> Data {
        let lines = pem.replacingOccurrences(of: "\r", with: "").split(separator: "\n").map(String.init)
        let body = lines.filter { !$0.hasPrefix("-----") && !$0.contains(":") }.joined()
        guard let raw = Data(base64Encoded: body) else { throw Failure("Unreadable private key.") }
        guard let dek = lines.first(where: { $0.hasPrefix("DEK-Info:") }) else { return raw } // already plain

        let parts = dek.dropFirst("DEK-Info:".count).trimmingCharacters(in: .whitespaces).split(separator: ",")
        guard parts.count == 2, let iv = Data(hex: String(parts[1])) else { throw Failure("Invalid private key encryption header.") }
        let cipher = parts[0].uppercased()
        let (alg, keyLen, block): (CCAlgorithm, Int, Int)
        switch cipher {
        case "AES-128-CBC": (alg, keyLen, block) = (CCAlgorithm(kCCAlgorithmAES), 16, 16)
        case "AES-192-CBC": (alg, keyLen, block) = (CCAlgorithm(kCCAlgorithmAES), 24, 16)
        case "AES-256-CBC": (alg, keyLen, block) = (CCAlgorithm(kCCAlgorithmAES), 32, 16)
        case "DES-EDE3-CBC": (alg, keyLen, block) = (CCAlgorithm(kCCAlgorithm3DES), 24, 8)
        default: throw Failure("Unsupported private key cipher: \(cipher)")
        }
        guard iv.count == block else { throw Failure("Invalid private key IV.") }

        // OpenSSL EVP_BytesToKey(MD5, salt = first 8 bytes of IV, 1 round)
        let pass = Data(passphrase.utf8), salt = iv.prefix(8)
        var key = Data(), prev = Data()
        while key.count < keyLen {
            prev = Data(Insecure.MD5.hash(data: prev + pass + salt))
            key += prev
        }
        key = key.prefix(keyLen)

        var out = Data(count: raw.count + block)
        var moved = 0
        let outCount = out.count
        let status = out.withUnsafeMutableBytes { o in
            raw.withUnsafeBytes { r in key.withUnsafeBytes { k in iv.withUnsafeBytes { v in
                CCCrypt(CCOperation(kCCDecrypt), alg, CCOptions(kCCOptionPKCS7Padding),
                        k.baseAddress, keyLen, v.baseAddress, r.baseAddress, raw.count,
                        o.baseAddress, outCount, &moved)
            } } }
        }
        guard status == kCCSuccess else { throw Failure("Wrong Developer Mode passphrase for the saved SSH key.") }
        return out.prefix(moved)
    }

    /// Minimal DER reader: SEQUENCE { INTEGER... } -> unsigned big-endian integers.
    static func parsePKCS1(_ der: Data) throws -> [Data] {
        let b = [UInt8](der)
        var i = 0
        func len() throws -> Int {
            guard i < b.count else { throw Failure("Wrong Developer Mode passphrase for the saved SSH key.") }
            let first = Int(b[i]); i += 1
            if first < 0x80 { return first }
            let n = first & 0x7f
            guard n <= 4, i + n <= b.count else { throw Failure("Wrong Developer Mode passphrase for the saved SSH key.") }
            var v = 0
            for _ in 0..<n { v = (v << 8) | Int(b[i]); i += 1 }
            return v
        }
        guard b.first == 0x30 else { throw Failure("Wrong Developer Mode passphrase for the saved SSH key.") }
        i = 1; _ = try len()
        var ints: [Data] = []
        while i < b.count, b[i] == 0x02 {
            i += 1
            let l = try len()
            guard i + l <= b.count else { throw Failure("Invalid private key.") }
            var v = Array(b[i..<i + l]); i += l
            while v.count > 1, v[0] == 0 { v.removeFirst() }
            ints.append(Data(v))
        }
        return ints
    }
}

extension Data {
    init?(hex: String) {
        var d = Data(); var s = Substring(hex)
        while s.count >= 2 { guard let b = UInt8(s.prefix(2), radix: 16) else { return nil }; d.append(b); s = s.dropFirst(2) }
        guard s.isEmpty else { return nil }
        self = d
    }
    mutating func u32(_ v: UInt32) { Swift.withUnsafeBytes(of: v.bigEndian) { append(contentsOf: $0) } }
    mutating func sshBytes(_ d: Data) { u32(UInt32(d.count)); append(d) }
    mutating func sshString(_ s: String) { sshBytes(Data(s.utf8)) }
    mutating func sshMPInt(_ unsigned: Data) {
        sshBytes(unsigned.first.map { $0 & 0x80 != 0 } == true ? Data([0]) + unsigned : unsigned)
    }
}
