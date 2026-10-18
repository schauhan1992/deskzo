package com.deskzo.calls

import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

/** Deskzo said no: its HTTP status and error code. 401 means this phone is no longer signed in. */
internal class ApiError(val status: Int, val code: String?) : Exception("Deskzo answered $status${if (code != null) " ($code)" else ""}")

/** Deskzo's /api/app, from the background — GET and POST, JSON both ways (src/lib/app/handler.ts on the server). */
internal object Api {
  fun request(s: Session, method: String, path: String, body: JSONObject? = null, timeoutMs: Int = 15_000): JSONObject {
    val conn = (URL(s.baseUrl + path).openConnection() as HttpURLConnection).apply {
      requestMethod = method
      connectTimeout = timeoutMs.coerceAtMost(10_000)
      readTimeout = timeoutMs
      setRequestProperty("Authorization", "Bearer ${s.token}")
      setRequestProperty("Accept", "application/json")
      // A development build on the emulator reaches this computer's Deskzo at 10.0.2.2, naming the workspace.
      s.host?.let { setRequestProperty("Host", it) }
      if (body != null) {
        doOutput = true
        setRequestProperty("Content-Type", "application/json")
      }
    }
    try {
      body?.let { b -> conn.outputStream.use { it.write(b.toString().toByteArray(Charsets.UTF_8)) } }
      val status = conn.responseCode
      val stream = if (status < 400) conn.inputStream else conn.errorStream
      val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
      val json = if (text.isNotBlank()) runCatching { JSONObject(text) }.getOrDefault(JSONObject()) else JSONObject()
      if (status >= 400) throw ApiError(status, json.optJSONObject("error")?.optString("code"))
      return json
    } finally {
      conn.disconnect()
    }
  }
}
