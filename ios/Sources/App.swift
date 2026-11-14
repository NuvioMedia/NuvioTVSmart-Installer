import SwiftUI
import UIKit
import WebKit
import SafariServices
import UniformTypeIdentifiers

@main
struct NuvioTVInstallerApp: App {
    var body: some Scene {
        WindowGroup {
            InstallerView().ignoresSafeArea().background(Color(red: 13 / 255, green: 13 / 255, blue: 13 / 255))
                .preferredColorScheme(.dark)
        }
    }
}

struct InstallerView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> InstallerViewController { InstallerViewController() }
    func updateUIViewController(_ vc: InstallerViewController, context: Context) {}
}

/// Hosts the desktop renderer (index.html/styles.css/renderer.js) and implements the preload.js API natively.
final class InstallerViewController: UIViewController, WKScriptMessageHandlerWithReply, UIDocumentPickerDelegate {
    private var webView: WKWebView!
    private let config: InstallerConfig
    private var pickerContinuation: CheckedContinuation<[URL]?, Never>?
    private var authServer: SamsungAuthServer?
    private weak var safari: SFSafariViewController?

    init() {
        let url = Bundle.main.url(forResource: "installer.config", withExtension: "json", subdirectory: "web")!
        config = try! JSONDecoder().decode(InstallerConfig.self, from: Data(contentsOf: url))
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 13 / 255, green: 13 / 255, blue: 13 / 255, alpha: 1)
        let web = Bundle.main.url(forResource: "web", withExtension: nil)!
        let controller = WKUserContentController()
        for (file, time) in [("ios-bridge.js", WKUserScriptInjectionTime.atDocumentStart), ("nuvio-core.js", .atDocumentStart)] {
            let source = try! String(contentsOf: web.appendingPathComponent(file), encoding: .utf8)
            controller.addUserScript(WKUserScript(source: source, injectionTime: time, forMainFrameOnly: true))
        }
        let css = try! String(contentsOf: web.appendingPathComponent("ios.css"), encoding: .utf8)
        let cssJson = String(data: try! JSONSerialization.data(withJSONObject: [css]), encoding: .utf8)!
        controller.addUserScript(WKUserScript(source: "(function(){var s=document.createElement('style');s.textContent=\(cssJson)[0];document.head.appendChild(s);})();",
                                              injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        controller.addScriptMessageHandler(self, contentWorld: .page, name: "installer")
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        webView = WKWebView(frame: view.bounds, configuration: configuration)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.isOpaque = false
        webView.backgroundColor = view.backgroundColor
        webView.scrollView.backgroundColor = view.backgroundColor
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.scrollView.isScrollEnabled = false // the page is a fixed viewport like the desktop window; panels scroll inside
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        view.addSubview(webView)
        #if DEBUG
        // Simulator test hook: `simctl launch <udid> <bundle> -nuvioTestScript /path/script.js`
        if let i = CommandLine.arguments.firstIndex(of: "-nuvioTestScript"), i + 1 < CommandLine.arguments.count,
           let script = try? String(contentsOfFile: CommandLine.arguments[i + 1], encoding: .utf8) {
            controller.addUserScript(WKUserScript(source: "window.addEventListener('load', () => setTimeout(async () => { \(script) }, 500));",
                                                  injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        #endif
        let index = web.appendingPathComponent("app/src/renderer/index.html")
        webView.loadFileURL(index, allowingReadAccessTo: web)
    }

    // MARK: Logs and core

    private func emit(_ type: String, _ text: String) {
        Task { @MainActor in
            let payload = try! JSONSerialization.data(withJSONObject: ["type": type, "text": text])
            _ = try? await webView.evaluateJavaScript("window.__nuvioEmitLog(\(String(decoding: payload, as: UTF8.self)))")
        }
    }

    @MainActor
    private func core(_ body: String, _ args: [String: Any]) async throws -> Any? {
        try await webView.callAsyncJavaScript(body, arguments: args, in: nil, contentWorld: .page)
    }

    private var samsung: Samsung {
        Samsung(config: config, emit: { [weak self] in self?.emit($0, $1) },
                core: { [weak self] body, args in try await self?.core(body, args) },
                auth: { [weak self] in try await self?.samsungLogin() ?? [:] })
    }

    // MARK: preload.js API

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let method = body["method"] as? String else {
            replyHandler(nil, "Invalid call"); return
        }
        let args = body["args"] as? [Any] ?? []
        Task { @MainActor in
            do { replyHandler(try await self.handle(method, args), nil) }
            catch { replyHandler(nil, errorMessage(error)) }
        }
    }

    @MainActor
    private func handle(_ method: String, _ args: [Any]) async throws -> Any? {
        let emit: Emit = { [weak self] in self?.emit($0, $1) }
        switch method {
        case "run":
            let request = args.first as? [String: Any] ?? [:]
            let platform = request["platform"] as? String ?? "", action = request["action"] as? String ?? ""
            let options = request["options"] as? [String: Any] ?? [:]
            emit("info", "Starting \(action) on \(platform).")
            UIApplication.shared.isIdleTimerDisabled = true
            defer { UIApplication.shared.isIdleTimerDisabled = false }
            do {
                if platform == "lg" {
                    try await LG.run(config, emit, action: action, options: options)
                } else if platform == "samsung" {
                    try await samsung.run(action: action, options: options)
                } else {
                    throw InstallerError("Unsupported platform: \(platform)")
                }
                emit("success", "Operation completed.")
                return ["ok": true]
            } catch {
                emit("error", errorMessage(error))
                return ["ok": false, "error": errorMessage(error)]
            }
        case "getConfig":
            return ["repo": config.githubRepo, "webosAppId": config.webos.appId, "tizenAppId": config.tizen.appId,
                    "platform": "ios", "localIps": localIPv4Addresses()]
        case "getRecentReleases":
            return try await Releases.recent(config, platform: args.first as? String ?? "")
        case "getLgDevices":
            return LG.listRegistered()
        case "deleteLgDevice":
            let name = try requireValue(args.first as? String, "LG device name")
            guard await confirm(title: "Delete LG Device", message: "Delete the saved LG device \"\(name)\"?",
                                detail: "This removes the device profile from the webOS CLI. You will need the TV IP and Developer Mode passphrase to add it again.",
                                action: "Delete Device") else { return ["ok": false, "cancelled": true] }
            try LG.delete(emit, name)
            return ["ok": true]
        case "startSamsungLogs":
            do {
                return try await samsung.startLogs(try requireValue(args.first as? String, "IP Samsung TV"))
            } catch {
                emit("error", errorMessage(error))
                return ["ok": false, "error": errorMessage(error)]
            }
        case "saveText":
            return await saveText(args.first as? String ?? "", args.count > 1 ? args[1] as? String ?? "nuvio-log.txt" : "nuvio-log.txt")
        case "copyText":
            UIPasteboard.general.string = args.first as? String ?? ""
            return true
        case "selectFile":
            return await selectFile()
        default:
            throw InstallerError("Unknown method \(method)")
        }
    }

    // MARK: Native dialogs

    private var presenter: UIViewController {
        var top: UIViewController = self
        while let next = top.presentedViewController { top = next }
        return top
    }

    @MainActor
    private func confirm(title: String, message: String, detail: String, action: String) async -> Bool {
        await withCheckedContinuation { cont in
            let alert = UIAlertController(title: title, message: "\(message)\n\n\(detail)", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in cont.resume(returning: false) })
            alert.addAction(UIAlertAction(title: action, style: .destructive) { _ in cont.resume(returning: true) })
            presenter.present(alert, animated: true)
        }
    }

    @MainActor
    private func pick(_ picker: UIDocumentPickerViewController) async -> [URL]? {
        await withCheckedContinuation { cont in
            pickerContinuation = cont
            picker.delegate = self
            presenter.present(picker, animated: true)
        }
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        pickerContinuation?.resume(returning: urls); pickerContinuation = nil
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pickerContinuation?.resume(returning: nil); pickerContinuation = nil
    }

    /// Files are copied into the app so the returned path stays readable, like a desktop path.
    @MainActor
    private func selectFile() async -> String? {
        let types = ["wgt", "ipk", "p12", "pfx"].compactMap { UTType(filenameExtension: $0) } + [.data, .item]
        guard let url = await pick(UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true))?.first else { return nil }
        let dir = Paths.userData.appendingPathComponent("imports/\(UUID().uuidString)", isDirectory: true)
        let target = dir.appendingPathComponent(url.lastPathComponent)
        do {
            try Paths.ensureDir(dir)
            try FileManager.default.copyItem(at: url, to: target)
            return target.path
        } catch {
            emit("error", "Unable to read the selected file: \(errorMessage(error))")
            return nil
        }
    }

    @MainActor
    private func saveText(_ text: String, _ name: String) async -> String? {
        let tmp = Paths.temp.appendingPathComponent(name)
        do { try text.write(to: tmp, atomically: true, encoding: .utf8) } catch { return nil }
        guard let saved = await pick(UIDocumentPickerViewController(forExporting: [tmp], asCopy: true))?.first else { return nil }
        return saved.path
    }

    // MARK: Samsung login (shell.openExternal + local server)

    @MainActor
    private func samsungLogin() async throws -> [String: String] {
        let server = SamsungAuthServer()
        authServer = server
        defer {
            authServer = nil
            safari?.dismiss(animated: true)
        }
        return try await server.wait { [weak self] in
            guard let self else { return }
            self.emit("info", "Opening Samsung login. Complete sign-in in the browser, then return to the installer.")
            let vc = SFSafariViewController(url: URL(string: SamsungAuthServer.authUrl)!)
            vc.preferredControlTintColor = .white
            vc.preferredBarTintColor = .black
            vc.delegate = self
            self.safari = vc
            self.presenter.present(vc, animated: true)
        }
    }
}

extension InstallerViewController: SFSafariViewControllerDelegate {
    func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
        // Closing the browser before authorization ends the wait, like closing the desktop flow would time out.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.authServer?.cancel() }
    }
}
