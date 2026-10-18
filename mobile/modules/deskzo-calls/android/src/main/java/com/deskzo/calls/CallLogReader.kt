package com.deskzo.calls

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CallLog
import androidx.core.content.ContextCompat

/** One call from the phone's call log, as Deskzo is sent it. */
internal data class PhoneCall(val key: String, val number: String, val direction: String, val startedAt: Long, val duration: Int)

/**
 * The phone's call log, read — never written. Calls made and taken, missed and declined; voicemail, blocked
 * calls and calls answered on another device are left out. A number the network withheld has nothing to
 * match and is left out too.
 */
internal object CallLogReader {
  fun since(c: Context, fromMillis: Long, limit: Int = 500): List<PhoneCall> {
    if (ContextCompat.checkSelfPermission(c, Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) return emptyList()
    val projection = arrayOf(CallLog.Calls._ID, CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION)
    val calls = ArrayList<PhoneCall>()
    c.contentResolver.query(CallLog.Calls.CONTENT_URI, projection, "${CallLog.Calls.DATE} >= ?", arrayOf(fromMillis.toString()), "${CallLog.Calls.DATE} ASC")?.use { cursor ->
      val id = cursor.getColumnIndexOrThrow(CallLog.Calls._ID)
      val number = cursor.getColumnIndexOrThrow(CallLog.Calls.NUMBER)
      val type = cursor.getColumnIndexOrThrow(CallLog.Calls.TYPE)
      val date = cursor.getColumnIndexOrThrow(CallLog.Calls.DATE)
      val duration = cursor.getColumnIndexOrThrow(CallLog.Calls.DURATION)
      while (cursor.moveToNext() && calls.size < limit) {
        val digits = (cursor.getString(number) ?: "").trim()
        if (digits.count { it.isDigit() } < 6) continue
        val direction = when (cursor.getInt(type)) {
          CallLog.Calls.OUTGOING_TYPE -> "out"
          CallLog.Calls.INCOMING_TYPE, CallLog.Calls.MISSED_TYPE, CallLog.Calls.REJECTED_TYPE -> "in"
          else -> continue
        }
        val answered = cursor.getInt(type) == CallLog.Calls.INCOMING_TYPE || cursor.getInt(type) == CallLog.Calls.OUTGOING_TYPE
        val started = cursor.getLong(date)
        // The id alone can come back after the log is cleared; with the start time it can't.
        calls.add(PhoneCall("${cursor.getLong(id)}-$started", digits.take(40), direction, started, if (answered) cursor.getInt(duration).coerceAtLeast(0) else 0))
      }
    }
    return calls
  }
}
