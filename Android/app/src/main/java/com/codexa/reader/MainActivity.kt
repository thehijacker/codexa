package com.codexa.reader

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
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
import androidx.core.view.ViewCompat
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

        /** Lock or unlock the screen orientation to portrait. */
        @JavascriptInterface
        fun setPortraitLock(lock: Boolean) {
            runOnUiThread {
                requestedOrientation = if (lock)
                    ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                else
                    ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            }
        }

        /** Returns true when the user enabled e-ink mode in the server-select screen. */
        @JavascriptInterface
        fun isEinkMode(): Boolean =
            getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getBoolean("eink_mode", false)

        /** Returns true when the Android system is in night/dark mode. */
        @JavascriptInterface
        fun isNightMode(): Boolean {
            val uiMode = resources.configuration.uiMode and
                    android.content.res.Configuration.UI_MODE_NIGHT_MASK
            return uiMode == android.content.res.Configuration.UI_MODE_NIGHT_YES
        }

        /** Persists e-ink mode so the login-page toggle stays in sync with server-select. */
        @JavascriptInterface
        fun setEinkMode(enabled: Boolean) {
            getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit().putBoolean("eink_mode", enabled).apply()
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

    override fun onResume() {
        super.onResume()
        registerNetworkCallback()
        // Trigger sync in case device was offline while sleeping and is now connected
        if (isOnReader()) triggerNetworkRestoreSync()
    }

    override fun onPause() {
        super.onPause()
        unregisterNetworkCallback()
    }

    // -------------------------------------------------------------------------
    // Network callback — triggers KOSync when connectivity is restored
    // -------------------------------------------------------------------------

    private var connectivityManager: ConnectivityManager? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    private fun registerNetworkCallback() {
        connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        networkCallback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                // Small delay to let the network fully settle before making API calls
                webView.postDelayed({ if (isOnReader()) triggerNetworkRestoreSync() }, 2000)
            }
        }
        connectivityManager?.registerNetworkCallback(request, networkCallback!!)
    }

    private fun unregisterNetworkCallback() {
        networkCallback?.let { connectivityManager?.unregisterNetworkCallback(it) }
        networkCallback = null
    }

    private fun isOnReader(): Boolean =
        webView.url?.contains("/readerv4.html", ignoreCase = true) == true

    private fun triggerNetworkRestoreSync() {
        runOnUiThread {
            webView.evaluateJavascript(
                "if(typeof window.__codexaNetworkRestore==='function') window.__codexaNetworkRestore();",
                null
            )
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
                val isReader = url.contains("/readerv4.html", ignoreCase = true)
                runOnUiThread {
                    setImmersiveMode(isReader)
                    // Inject status bar height as --sat so older Chrome WebViews
                    // (< 87, where env(safe-area-inset-top) returns 0) still get
                    // the correct top padding. getRootWindowInsets does NOT replace
                    // WebView's internal inset listener, so env() keeps working on
                    // modern Chrome where it is already supported.
                    if (!isReader) {
                        val rootInsets = ViewCompat.getRootWindowInsets(view)
                        if (rootInsets != null) {
                            val density = resources.displayMetrics.density
                            val combined = WindowInsetsCompat.Type.statusBars() or
                                    WindowInsetsCompat.Type.displayCutout()
                            val topPx = rootInsets.getInsets(combined).top
                            if (topPx > 0) {
                                val cssVal = String.format(java.util.Locale.ROOT, "%.2f", topPx / density)
                                view.evaluateJavascript(
                                    "document.documentElement.style.setProperty('--sat','${cssVal}px');",
                                    null
                                )
                            }
                            val nav = rootInsets.getInsets(WindowInsetsCompat.Type.navigationBars())
                            if (nav.bottom > 0) {
                                val v = String.format(java.util.Locale.ROOT, "%.2f", nav.bottom / density)
                                view.evaluateJavascript(
                                    "document.documentElement.style.setProperty('--sab','${v}px');", null)
                            }
                            if (nav.left > 0) {
                                val v = String.format(java.util.Locale.ROOT, "%.2f", nav.left / density)
                                view.evaluateJavascript(
                                    "document.documentElement.style.setProperty('--sal','${v}px');", null)
                            }
                            if (nav.right > 0) {
                                val v = String.format(java.util.Locale.ROOT, "%.2f", nav.right / density)
                                view.evaluateJavascript(
                                    "document.documentElement.style.setProperty('--sar','${v}px');", null)
                            }
                        }
                    }
                }
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
            controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
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
