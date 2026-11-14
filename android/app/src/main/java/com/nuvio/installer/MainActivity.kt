package com.nuvio.installer

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewAssetLoader
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/** Hosts the desktop renderer (index.html/styles.css/renderer.js) and implements the preload.js API natively. */
class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private lateinit var config: InstallerConfig
    private val coreSeq = AtomicInteger()
    private val coreCalls = ConcurrentHashMap<Int, CompletableDeferred<Any?>>()
    private var pickResult: CompletableDeferred<Uri?>? = null
    private var saveResult: CompletableDeferred<Uri?>? = null

    private val openDocument = registerForActivityResult(ActivityResultContracts.OpenDocument()) { pickResult?.complete(it) }
    private val createDocument = registerForActivityResult(ActivityResultContracts.CreateDocument("text/plain")) { saveResult?.complete(it) }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Paths.init(filesDir, cacheDir)
        config = InstallerConfig(JSONObject(assets.open("web/installer.config.json").bufferedReader().readText()))
        WindowCompat.setDecorFitsSystemWindows(window, false)
        if (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) WebView.setWebContentsDebuggingEnabled(true)

        val root = FrameLayout(this).apply { setBackgroundColor(0xFF0D0D0D.toInt()) }
        webView = WebView(this).apply {
            setBackgroundColor(0xFF0D0D0D.toInt())
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.textZoom = 100
            // The Samsung "Logs" button opens ws://<TV> from the app page, like the desktop renderer.
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            addJavascriptInterface(Bridge(), "NuvioAndroid")
        }
        root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        val assetsHandler = WebViewAssetLoader.AssetsPathHandler(this)
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/") { path ->
                if (path == "web/app/src/renderer/index.html") indexHtml() else assetsHandler.handle(path)
            }
            .build()
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // Links leave the app, like shell.openExternal on desktop.
                if (request.url.host == "appassets.androidplatform.net") return false
                startActivity(Intent(Intent.ACTION_VIEW, request.url))
                return true
            }
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript("(()=>{const b=document.getElementById('nav-back');if(b&&!b.classList.contains('hidden')){b.click();return true}return false})()") {
                    if (it != "true") finish()
                }
            }
        })
        webView.loadUrl("https://appassets.androidplatform.net/assets/web/app/src/renderer/index.html")
    }

    /** index.html verbatim, plus the native bridge, the shared core and the phone layout. */
    private fun indexHtml(): WebResourceResponse {
        val html = assets.open("web/app/src/renderer/index.html").bufferedReader().readText()
            .replace("</head>", "  <link rel=\"stylesheet\" href=\"/assets/web/mobile.css\" />\n</head>")
            .replace("<script src=\"renderer.js\"></script>",
                "<script src=\"/assets/web/android-bridge.js\"></script>\n  <script src=\"/assets/web/nuvio-core.js\"></script>\n  <script src=\"renderer.js\"></script>")
        return WebResourceResponse("text/html", "utf-8", ByteArrayInputStream(html.toByteArray()))
    }

    // MARK: Logs and core

    private fun emit(type: String, text: String) {
        val payload = JSONObject(mapOf("type" to type, "text" to text)).toString()
        runOnUiThread { webView.evaluateJavascript("window.__nuvioEmitLog($payload)", null) }
    }

    private suspend fun core(body: String, args: Map<String, Any?>): Any? {
        val id = coreSeq.incrementAndGet()
        val deferred = CompletableDeferred<Any?>()
        coreCalls[id] = deferred
        val script = "window.__nuvioCoreCall($id, ${toJson(body)}, ${toJson(args)})"
        withContext(Dispatchers.Main) { webView.evaluateJavascript(script, null) }
        return deferred.await()
    }

    private val samsung get() = Samsung(config, ::emit, ::core) { samsungLogin() }

    inner class Bridge {
        @JavascriptInterface
        fun postMessage(json: String) {
            val message = JSONObject(json)
            val id = message.getInt("id")
            val method = message.getString("method")
            val args = fromJson(message.optJSONArray("args")).asList()
            lifecycleScope.launch(Dispatchers.IO) {
                val (ok, value) = try {
                    true to handle(method, args)
                } catch (error: Exception) {
                    false to errorMessage(error)
                }
                val script = "window.__nuvioResolve($id, $ok, ${toJson(toJson(value))})"
                withContext(Dispatchers.Main) { webView.evaluateJavascript(script, null) }
            }
        }

        @JavascriptInterface
        fun coreResult(id: Int, ok: Boolean, json: String) {
            val deferred = coreCalls.remove(id) ?: return
            val value = try { parseJson(json) } catch (_: Exception) { null }
            if (ok) deferred.complete(value) else deferred.completeExceptionally(InstallerError(value.str()))
        }
    }

    // MARK: preload.js API

    private suspend fun handle(method: String, args: List<Any?>): Any? = when (method) {
        "run" -> {
            val request = args.firstOrNull().asMap()
            val platform = request["platform"].str()
            val action = request["action"].str()
            val options = request["options"].asMap()
            emit("info", "Starting $action on $platform.")
            withContext(Dispatchers.Main) { window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
            try {
                when (platform) {
                    "lg" -> LG.run(config, ::emit, action, options)
                    "samsung" -> samsung.run(action, options)
                    else -> throw InstallerError("Unsupported platform: $platform")
                }
                emit("success", "Operation completed.")
                mapOf("ok" to true)
            } catch (error: Exception) {
                emit("error", errorMessage(error))
                mapOf("ok" to false, "error" to errorMessage(error))
            } finally {
                withContext(Dispatchers.Main) { window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
            }
        }
        "getConfig" -> mapOf("repo" to config.githubRepo, "webosAppId" to config.webos.appId, "tizenAppId" to config.tizen.appId,
            "platform" to "android", "localIps" to localIPv4Addresses())
        "getRecentReleases" -> Releases.recent(config, args.firstOrNull().str())
        "getLgDevices" -> LG.listRegistered()
        "deleteLgDevice" -> {
            val name = requireValue(args.firstOrNull().str(), "LG device name")
            if (!confirm("Delete LG Device", "Delete the saved LG device \"$name\"?",
                    "This removes the device profile from the webOS CLI. You will need the TV IP and Developer Mode passphrase to add it again.", "Delete Device")) {
                mapOf("ok" to false, "cancelled" to true)
            } else {
                LG.delete(::emit, name)
                mapOf("ok" to true)
            }
        }
        "startSamsungLogs" -> try {
            samsung.startLogs(requireValue(args.firstOrNull().str(), "IP Samsung TV"))
        } catch (error: Exception) {
            emit("error", errorMessage(error))
            mapOf("ok" to false, "error" to errorMessage(error))
        }
        "saveText" -> saveText(args.getOrNull(0).str(), args.getOrNull(1).str().ifEmpty { "nuvio-log.txt" })
        "copyText" -> withContext(Dispatchers.Main) {
            (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Nuvio TV Installer log", args.firstOrNull().str()))
            true
        }
        "selectFile" -> selectFile()
        else -> throw InstallerError("Unknown method $method")
    }

    // MARK: Native dialogs

    private suspend fun confirm(title: String, message: String, detail: String, action: String): Boolean = withContext(Dispatchers.Main) {
        val result = CompletableDeferred<Boolean>()
        AlertDialog.Builder(this@MainActivity, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle(title)
            .setMessage("$message\n\n$detail")
            .setNegativeButton("Cancel") { _, _ -> result.complete(false) }
            .setPositiveButton(action) { _, _ -> result.complete(true) }
            .setOnCancelListener { result.complete(false) }
            .show()
        result.await()
    }

    /** Files are copied into the app so the returned path stays readable, like a desktop path. */
    private suspend fun selectFile(): String? {
        val uri = withContext(Dispatchers.Main) {
            pickResult = CompletableDeferred()
            openDocument.launch(arrayOf("*/*"))
            pickResult!!.await()
        } ?: return null
        return try {
            val name = displayName(uri) ?: "selected-file"
            val target = File(File(Paths.userData, "imports/${UUID.randomUUID()}"), name)
            target.parentFile?.mkdirs()
            contentResolver.openInputStream(uri)!!.use { input -> target.outputStream().use { input.copyTo(it) } }
            target.path
        } catch (error: Exception) {
            emit("error", "Unable to read the selected file: ${errorMessage(error)}")
            null
        }
    }

    private suspend fun saveText(text: String, name: String): String? {
        val uri = withContext(Dispatchers.Main) {
            saveResult = CompletableDeferred()
            createDocument.launch(name)
            saveResult!!.await()
        } ?: return null
        return try {
            contentResolver.openOutputStream(uri)!!.use { it.write(text.toByteArray()) }
            displayName(uri) ?: uri.toString()
        } catch (_: Exception) {
            null
        }
    }

    private fun displayName(uri: Uri): String? = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
        if (it.moveToFirst()) it.getString(0) else null
    }

    // MARK: Samsung login (shell.openExternal + local server)

    private suspend fun samsungLogin(): Map<String, String> {
        val server = SamsungAuthServer()
        val info = server.wait {
            emit("info", "Opening Samsung login. Complete sign-in in the browser, then return to the installer.")
            runOnUiThread {
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(SamsungAuthServer.AUTH_URL)))
                } catch (_: android.content.ActivityNotFoundException) {
                    emit("error", "No browser is installed. Open this address on this device to sign in: ${SamsungAuthServer.AUTH_URL}")
                }
            }
        }
        // Back to the installer once the browser handed over the authorization.
        withContext(Dispatchers.Main) {
            startActivity(Intent(this@MainActivity, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
        }
        return info
    }
}
