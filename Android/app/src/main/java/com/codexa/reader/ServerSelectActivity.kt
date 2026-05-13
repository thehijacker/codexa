package com.codexa.reader

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class ServerSelectActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_INITIAL_URL = "initial_url"
        const val RESULT_URL        = "result_url"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_server_select)

        val etUrl      = findViewById<EditText>(R.id.et_url)
        val btnConnect = findViewById<Button>(R.id.btn_connect)
        val btnCancel  = findViewById<Button>(R.id.btn_cancel)
        val tvError    = findViewById<TextView>(R.id.tv_error)

        val cancellable = intent.getBooleanExtra("cancellable", false)
        if (cancellable) {
            btnCancel.visibility = android.view.View.VISIBLE
            btnCancel.setOnClickListener {
                setResult(Activity.RESULT_CANCELED)
                finish()
            }
        }

        // Pre-fill with whatever the caller passed in
        intent.getStringExtra(EXTRA_INITIAL_URL)?.let { etUrl.setText(it) }
        etUrl.setSelection(etUrl.text.length)

        fun tryConnect() {
            val raw = etUrl.text.toString().trim()
            val url = extractOrigin(raw) ?: raw
            if (isValidUrl(url)) {
                tvError.visibility = android.view.View.GONE
                val result = Intent().putExtra(RESULT_URL, url)
                setResult(Activity.RESULT_OK, result)
                finish()
            } else {
                tvError.text = getString(R.string.error_invalid_url)
                tvError.visibility = android.view.View.VISIBLE
            }
        }

        btnConnect.setOnClickListener { tryConnect() }

        // Allow submitting with the keyboard "Go" action
        etUrl.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO) { tryConnect(); true } else false
        }
    }

    // Back key is always disabled — use Connect to confirm or Cancel button to dismiss.
    @Suppress("OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        // intentionally do nothing
    }

    private fun extractOrigin(url: String): String? = try {
        val u = Uri.parse(url)
        val port = if (u.port != -1) ":${u.port}" else ""
        "${u.scheme}://${u.host}$port"
    } catch (e: Exception) { null }

    private fun isValidUrl(url: String) =
        (url.startsWith("http://") || url.startsWith("https://")) && url.length > 10
}
