package com.codexa.reader

import org.json.JSONObject

/**
 * Parses the user-entered "custom HTTP headers" text (Settings → Server select →
 * Advanced) into a header map, and serializes it for injection into WebView JS.
 *
 * Format: one "Header-Name: value" per line (like curl -H flags) — the same format
 * used by this app's server-side custom-headers config, for a consistent mental model.
 * Blank lines and lines starting with '#' are skipped (comments allowed). Lines with
 * no ':' are silently skipped — this is a convenience field, not a config language,
 * so we tolerate malformed input rather than surfacing a validation error.
 */
object HeaderUtils {

    fun parse(text: String): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        for (raw in text.split(Regex("\r?\n"))) {
            val line = raw.trim()
            if (line.isEmpty() || line.startsWith("#")) continue
            val i = line.indexOf(':')
            if (i <= 0) continue
            val name = line.substring(0, i).trim()
            val value = line.substring(i + 1).trim()
            if (name.isEmpty()) continue
            out[name] = value
        }
        return out
    }

    /**
     * Renders headers as a JSON object literal for embedding directly into an
     * injected JS snippet. Safe by construction — JSONObject.toString() always
     * produces self-contained, valid JSON (and therefore valid JS), so this can't
     * be used to break out of the wrapping script.
     */
    fun toJsonLiteral(headers: Map<String, String>): String {
        val obj = JSONObject()
        for ((k, v) in headers) obj.put(k, v)
        return obj.toString()
    }
}
