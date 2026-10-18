package com.deskzo.calls

import android.content.Context
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import org.json.JSONArray
import org.json.JSONObject

/**
 * Sending the phone's calls to Deskzo (POST /api/app/calls/sync) — after every call, every quarter of an
 * hour, and whenever the app is opened.
 *
 * Every call since sync was switched on is sent, and Deskzo decides: a call to a number on a customer the
 * person can see is logged, everything else is answered no_match and goes no further. A little of what was
 * sent before goes again each time (a call-log entry can land late); Deskzo answers those "duplicate".
 */
internal object CallSync {
  private val lock = Any()
  private const val OVERLAP_MS = 15 * 60_000L
  private const val BATCH = 200

  data class Result(val sent: Int, val logged: Int)

  private fun iso(at: Long): String =
    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(at))

  /** Throws `ApiError` (a 401 has already signed the phone out here) or an IOException for no network. */
  fun run(c: Context): Result = synchronized(lock) {
    val session = Store.session(c) ?: return Result(0, 0)
    if (!Store.callSync(c)) return Result(0, 0)
    val from = maxOf(Store.syncFrom(c), Store.cursor(c) - OVERLAP_MS)
    val calls = CallLogReader.since(c, from)
    var logged = 0
    val now = System.currentTimeMillis()
    try {
      for (batch in calls.chunked(BATCH)) {
        val body = JSONObject().put(
          "calls",
          JSONArray(batch.map { JSONObject().put("key", it.key).put("number", it.number).put("direction", it.direction).put("started_at", iso(it.startedAt)).put("duration", it.duration) }),
        )
        val results = Api.request(session, "POST", "/api/app/calls/sync", body).optJSONArray("data") ?: JSONArray()
        val byKey = batch.associateBy { it.key }
        // A word for the last few calls just logged — not for a backlog sent all at once.
        var told = 0
        for (i in results.length() - 1 downTo 0) {
          val r = results.optJSONObject(i) ?: continue
          if (r.optString("status") != "logged") continue
          logged += 1
          val call = byKey[r.optString("key")] ?: continue
          if (told >= 3 || now - call.startedAt > 2 * 3_600_000L) continue
          val who = r.optString("contact").ifBlank { "the customer" }
          val company = r.optString("company")
          // A call they made that nobody answered waits in the app's list without a word of its own.
          if (call.direction == "in" && call.duration == 0) Alerts.missed(c, who, company)
          else if (call.duration > 0) Alerts.afterCall(c, r.optString("call_id"), who, company)
          else continue
          told += 1
        }
        Store.setCursor(c, batch.maxOf { it.startedAt })
      }
      Store.setLastSyncAt(c, now)
      Result(calls.size, logged)
    } catch (e: ApiError) {
      if (e.status == 401) Store.markSignedOut(c)
      throw e
    }
  }

  /** Who a ringing number is, for caller ID — quickly, or not at all. */
  fun lookup(c: Context, number: String): Pair<String, String>? {
    val session = Store.session(c) ?: return null
    val data = runCatching { Api.request(session, "GET", "/api/app/calls/lookup?number=${URLEncoder.encode(number, "UTF-8")}", timeoutMs = 6_000).optJSONObject("data") }.getOrNull() ?: return null
    val contact = data.optJSONObject("contact")?.optString("name") ?: return null
    val company = data.optJSONObject("company")?.optString("name") ?: ""
    val lines = ArrayList<String>()
    lines.add(company)
    data.optJSONArray("leads")?.optJSONObject(0)?.let { lead -> lines.add("${lead.optString("title")} · ${lead.optString("stage")}") }
    if (!data.isNull("callback_due")) lines.add("A callback is owed")
    data.optJSONObject("last_call")?.let { last -> lines.add("Last call: ${last.optString("outcome").lowercase().replace('_', ' ')}, by ${last.optString("by")}") }
    return contact to lines.filter { it.isNotBlank() }.joinToString("\n")
  }
}
