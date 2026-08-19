package com.zhish.dshmobile

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.ConsoleMessage
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import java.util.concurrent.atomic.AtomicBoolean

/** The only post-pairing surface: a native View hierarchy hosting the audited PWA. */
class RemoteActivity : ComponentActivity() {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val closing = AtomicBoolean(false)
    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private lateinit var progress: ProgressBar
    private lateinit var errorPanel: LinearLayout
    private lateinit var errorMessage: TextView
    private var firstFrameVisible = false
    private var session: PairedSession? = null
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null

    private val imagePicker = registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        fileChooserCallback?.onReceiveValue(uris.toTypedArray())
        fileChooserCallback = null
    }

    private val loadTimeout = Runnable {
        if (!firstFrameVisible && !closing.get()) showError("页面首帧渲染超时。请确认电脑在线，并点击重试。")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        configureScreenSecurity()
        session = MobileAppSession.current()
        if (session == null) {
            setResult(Activity.RESULT_CANCELED)
            finish()
            return
        }

        buildViewHierarchy()
        configureWebView()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Android's back gesture leaves the remote app without revoking
                // its encrypted device session. Only the explicit in-page
                // "断开此设备" action is allowed to clear pairing state.
                moveTaskToBack(true)
            }
        })
        installSessionCookieAndLoad()
    }

    override fun onDestroy() {
        mainHandler.removeCallbacks(loadTimeout)
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = null
        if (::webView.isInitialized) {
            webView.stopLoading()
            webView.webChromeClient = null
            webView.webViewClient = WebViewClient()
            (webView.parent as? FrameLayout)?.removeView(webView)
            webView.destroy()
        }
        super.onDestroy()
    }

    private fun configureScreenSecurity() {
        val debug = applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        if (debug) window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        else window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
    }

    private fun buildViewHierarchy() {
        root = FrameLayout(this).apply { setBackgroundColor(Color.rgb(245, 246, 248)) }
        webView = WebView(this)
        root.addView(webView, FrameLayout.LayoutParams(-1, -1))

        progress = ProgressBar(this).apply { isIndeterminate = true }
        root.addView(progress, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))

        errorPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(48, 32, 48, 32)
            setBackgroundColor(Color.rgb(245, 246, 248))
            visibility = View.GONE
        }
        errorMessage = TextView(this).apply {
            setTextColor(Color.rgb(23, 26, 33))
            textSize = 16f
            gravity = Gravity.CENTER
        }
        errorPanel.addView(errorMessage, LinearLayout.LayoutParams(-1, -2))
        errorPanel.addView(Button(this).apply {
            text = "重试"
            setOnClickListener { retry() }
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 24 })
        root.addView(errorPanel, FrameLayout.LayoutParams(-1, -1))
        setContentView(root)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) WebView.setWebContentsDebuggingEnabled(true)
        webView.setBackgroundColor(Color.rgb(245, 246, 248))
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        webView.setKeepScreenOn(false)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = true
            setGeolocationEnabled(false)
            userAgentString = "$userAgentString DSHMobileAndroid/1.1"
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams,
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = filePathCallback
                imagePicker.launch("image/*")
                return true
            }

            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                android.util.Log.d("DSHMobileWeb", "${message.message()} @${message.sourceId()}:${message.lineNumber()}")
                return true
            }
        }
        webView.webViewClient = RestrictedWebViewClient()
    }

    private fun installSessionCookieAndLoad() {
        val current = requireNotNull(session)
        val cookies = CookieManager.getInstance()
        cookies.setAcceptCookie(true)
        val cookieUrl = current.server.toString().removeSuffix("/") + "/mobile-api/"
        val cookie = "${current.cookie}; Path=/mobile-api; Secure; HttpOnly; SameSite=Strict"
        cookies.setCookie(cookieUrl, cookie) { accepted ->
            runOnUiThread {
                if (closing.get()) return@runOnUiThread
                if (!accepted) {
                    showError("无法建立本机配对会话，请重新扫码。")
                    return@runOnUiThread
                }
                cookies.flush()
                firstFrameVisible = false
                progress.visibility = View.VISIBLE
                errorPanel.visibility = View.GONE
                mainHandler.removeCallbacks(loadTimeout)
                mainHandler.postDelayed(loadTimeout, 15_000)
                webView.loadUrl(current.server.toString().removeSuffix("/") + "/mobile/")
            }
        }
    }

    private fun markFirstFrameVisible(view: WebView) {
        if (view !== webView || firstFrameVisible || closing.get()) return
        firstFrameVisible = true
        mainHandler.removeCallbacks(loadTimeout)
        progress.visibility = View.GONE
        webView.requestLayout()
        webView.invalidate()
    }

    private fun retry() {
        if (closing.get()) return
        firstFrameVisible = false
        errorPanel.visibility = View.GONE
        progress.visibility = View.VISIBLE
        mainHandler.removeCallbacks(loadTimeout)
        mainHandler.postDelayed(loadTimeout, 15_000)
        webView.reload()
    }

    private fun showError(message: String) {
        if (closing.get()) return
        mainHandler.removeCallbacks(loadTimeout)
        progress.visibility = View.GONE
        errorMessage.text = message
        errorPanel.visibility = View.VISIBLE
    }

    private fun disconnectAndFinish() {
        if (!closing.compareAndSet(false, true)) return
        val detached = MobileAppSession.detach()
        detached?.let { current ->
            clearWebViewCookie(current)
            Thread({ MobileAppSession.revoke(current) }, "dsh-mobile-revoke").start()
        }
        setResult(Activity.RESULT_OK)
        finish()
    }

    private fun clearWebViewCookie(current: PairedSession) {
        val cookieUrl = current.server.toString().removeSuffix("/") + "/mobile-api/"
        CookieManager.getInstance().setCookie(
            cookieUrl,
            "dsh_mobile_session=; Max-Age=0; Path=/mobile-api; Secure; HttpOnly; SameSite=Strict",
        ) { CookieManager.getInstance().flush() }
    }

    private inner class RestrictedWebViewClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            if (url.scheme.equals("dshmobile", ignoreCase = true) && url.host.equals("disconnect", ignoreCase = true)) {
                disconnectAndFinish()
                return true
            }
            val allowed = isAllowed(url)
            if (!allowed && request.hasGesture() && (url.scheme.equals("https", ignoreCase = true) || url.scheme.equals("http", ignoreCase = true))) {
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, url)) }
                return true
            }
            if (!allowed && request.isForMainFrame) showError("该链接不属于受限的 DSH Mobile 页面，已阻止打开。")
            return !allowed
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
            if (url != null && isAllowed(Uri.parse(url)) && !firstFrameVisible) progress.visibility = View.VISIBLE
        }

        override fun onPageCommitVisible(view: WebView, url: String?) {
            super.onPageCommitVisible(view, url)
            if (url != null && isAllowed(Uri.parse(url))) markFirstFrameVisible(view)
        }

        override fun onPageFinished(view: WebView, url: String?) {
            super.onPageFinished(view, url)
            if (url != null && isAllowed(Uri.parse(url))) {
                view.postVisualStateCallback(System.nanoTime(), object : WebView.VisualStateCallback() {
                    override fun onComplete(requestId: Long) = markFirstFrameVisible(view)
                })
            }
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) showError("无法连接电脑上的 Harness。请确认手机与电脑在同一网络，并保持 TLS 代理运行。")
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (request.isForMainFrame && response.statusCode >= 400) showError("Harness 返回 HTTP ${response.statusCode}，请重试或重新扫码。")
        }

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: android.net.http.SslError) {
            handler.cancel()
            showError("TLS 证书校验失败。请检查电脑 IP 与本机证书，不要改用 HTTP。")
        }

        override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
            showError("WebView 渲染进程已退出，请点击重试。")
            return true
        }

        private fun isAllowed(url: Uri): Boolean {
            val origin = session?.server ?: return false
            if (url.scheme != "https" || url.host != origin.host || effectivePort(url) != effectivePort(origin)) return false
            val path = url.path.orEmpty()
            return path == "/mobile" || path.startsWith("/mobile/") || path.startsWith("/mobile-api/")
        }

        private fun effectivePort(uri: Uri): Int = if (uri.port == -1) 443 else uri.port
        private fun effectivePort(uri: java.net.URI): Int = if (uri.port == -1) 443 else uri.port
    }
}
