package com.codexa.reader

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    /** Set to true by the JS bridge when the reader activates volume-key navigation. */
    @Volatile
    private var volumeKeyModeEnabled = false

    // Track back-press timing: second back press within 2 s opens server select
    private var lastBackPressTime = 0L

    // Launcher for ServerSelectActivity — handles both first-run and change-server flows
    private val serverSelectLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val url = result.data?.getStringExtra(ServerSelectActivity.RESULT_URL) ?: return@registerForActivityResult
            saveUrl(url)
            webView.loadUrl(url)
        } else if (getSavedUrl() == null) {
            // First run and user somehow cancelled — show it again (non-cancellable)
            openServerSelect(cancellable = false)
        }
    }

    // -------------------------------------------------------------------------
    // JS bridge — exposed to JavaScript as window.AndroidCodexa
    // -------------------------------------------------------------------------
    inner class JsBridge {

        /** Called by the web reader to enable or disable volume-key page navigation. */
        @JavascriptInterface
        fun setVolumeKeyMode(enabled: Boolean) {
            volumeKeyModeEnabled = enabled
        }

        /** Returns the app version string so the web side can gate features. */
        @JavascriptInterface
        fun getAppVersion(): String = BuildConfig.VERSION_NAME

        /** Can be called from web JS to open the change-server screen. */
        @JavascriptInterface
        fun changeServer() {
            runOnUiThread { openServerSelect(cancellable = true) }
        }

        /** Called by the reader JS to enter/exit fullscreen immersive mode (hide nav bar). */
        @JavascriptInterface
        fun setReaderMode(active: Boolean) {
            runOnUiThread { setImmersiveMode(active) }
        }
    }

    // -------------------------------------------------------------------------
    // Activity lifecycle
    // -------------------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Stay edge-to-edge for the entire lifetime of the activity.
        // We never re-enable fitSystemWindows because toggling it causes
        // a layout jump (blank gap below the status bar) when leaving the reader.
        WindowCompat.setDecorFitsSystemWindows(window, false)

        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        setContentView(R.layout.activity_main)
        webView = findViewById(R.id.webView)

        configureWebView()

        val savedUrl = getSavedUrl()
        if (savedUrl != null) {
            webView.loadUrl(savedUrl)
        } else {
            openServerSelect(cancellable = false)
        }
    }

    // Physical back key behaviour:
    //   - Blocked entirely when the reader is open (use the in-reader UI to exit)
    //   - Double-press anywhere else: first press shows hint toast,
    //     second press within 2 s opens server select screen.
    //   WebView history is intentionally never navigated via the hardware back key.
    @Suppress("OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        val currentUrl = webView.url ?: ""
        if (currentUrl.contains("/readerv4.html", ignoreCase = true)) {
            return
        }
        val now = System.currentTimeMillis()
        if (now - lastBackPressTime < 2000) {
            openServerSelect(cancellable = true)
        } else {
            lastBackPressTime = now
            Toast.makeText(this, getString(R.string.back_press_hint), Toast.LENGTH_SHORT).show()
        }
    }

    // -------------------------------------------------------------------------
    // Volume key interception
    // -------------------------------------------------------------------------

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (!volumeKeyModeEnabled) return super.dispatchKeyEvent(event)

        val action = event.action
        val code = event.keyCode

        if (code == KeyEvent.KEYCODE_VOLUME_DOWN || code == KeyEvent.KEYCODE_VOLUME_UP) {
            if (action == KeyEvent.ACTION_UP) {
                val direction = if (code == KeyEvent.KEYCODE_VOLUME_DOWN) "down" else "up"
                webView.evaluateJavascript(
                    "if(typeof window.__codexaVolumeKey==='function') window.__codexaVolumeKey('$direction');",
                    null
                )
            }
            return true
        }

        return super.dispatchKeyEvent(event)
    }

    // -------------------------------------------------------------------------
    // WebView configuration
    // -------------------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = "$userAgentString CodexaApp/1.0"
        }

        webView.addJavascriptInterface(JsBridge(), "AndroidCodexa")
        webView.webChromeClient = WebChromeClient()

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean {
                val url = request.url.toString()
                if (url.startsWith("mailto:") || url.startsWith("tel:")) {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    return true
                }
                return false
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                volumeKeyModeEnabled = false
                // Exit immersive mode when navigating away from reader
                val isReader = url.contains("/readerv4.html", ignoreCase = true)
                runOnUiThread { setImmersiveMode(isReader) }
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                // Re-apply immersive if still on reader page (handles reload)
                val isReader = url.contains("/readerv4.html", ignoreCase = true)
                runOnUiThread { setImmersiveMode(isReader) }
            }
        }
    }

    // -------------------------------------------------------------------------
    // Immersive mode (hide system navigation bar in reader)
    // -------------------------------------------------------------------------

    private fun setImmersiveMode(enable: Boolean) {
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        if (enable) {
            controller.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.navigationBars())
        } else {
            controller.show(WindowInsetsCompat.Type.navigationBars())
        }
    }

    // -------------------------------------------------------------------------
    // Server URL management
    // -------------------------------------------------------------------------

    private fun openServerSelect(cancellable: Boolean) {
        val intent = Intent(this, ServerSelectActivity::class.java).apply {
            putExtra(ServerSelectActivity.EXTRA_INITIAL_URL, getSavedUrl() ?: "")
            putExtra("cancellable", cancellable)
        }
        serverSelectLauncher.launch(intent)
    }

    private fun getSavedUrl(): String? =
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(PREF_URL, null)

    private fun saveUrl(url: String) =
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(PREF_URL, url)
            .apply()

    companion object {
        private const val PREFS_NAME = "codexa_prefs"
        private const val PREF_URL   = "server_url"
    }
}
