package com.deskzo.calls

import android.content.Context

/** This phone's Deskzo: where it is and the phone's token. */
internal data class Session(val baseUrl: String, val token: String, val host: String?)

/**
 * What the app keeps on the phone, in its own private storage (never backed up: allowBackup is off).
 *
 *   · The session — the workspace's address and the phone's token, from pairing.
 *   · Call sync: on or off, from when (calls before it are never sent), and how far it has got.
 *
 * Kept here rather than in JavaScript so the background sync, with the app closed, can read it.
 */
internal object Store {
  private const val PREFS = "deskzo_app"

  private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun session(c: Context): Session? {
    val p = prefs(c)
    val base = p.getString("baseUrl", null) ?: return null
    val token = p.getString("token", null) ?: return null
    return Session(base, token, p.getString("host", null))
  }

  fun saveSession(c: Context, s: Session) {
    prefs(c).edit().putString("baseUrl", s.baseUrl).putString("token", s.token).putString("host", s.host).putBoolean("signedOut", false).apply()
  }

  /** Everything — signing out, or Deskzo saying this phone is no longer signed in. */
  fun clear(c: Context) {
    prefs(c).edit().clear().apply()
  }

  fun markSignedOut(c: Context) {
    prefs(c).edit().remove("token").putBoolean("signedOut", true).putBoolean("callSync", false).apply()
  }

  fun signedOut(c: Context): Boolean = prefs(c).getBoolean("signedOut", false)

  fun callSync(c: Context): Boolean = prefs(c).getBoolean("callSync", false) && session(c) != null

  fun setCallSync(c: Context, on: Boolean) {
    val p = prefs(c)
    val edit = p.edit().putBoolean("callSync", on)
    // Calls from before it was first switched on are never sent.
    if (on && p.getLong("syncFrom", 0L) == 0L) edit.putLong("syncFrom", System.currentTimeMillis())
    edit.apply()
  }

  fun syncFrom(c: Context): Long = prefs(c).getLong("syncFrom", 0L)

  /** The start of the latest call sent so far. */
  fun cursor(c: Context): Long = prefs(c).getLong("cursor", 0L)

  fun setCursor(c: Context, at: Long) {
    if (at > cursor(c)) prefs(c).edit().putLong("cursor", at).apply()
  }

  fun lastSyncAt(c: Context): Long = prefs(c).getLong("lastSyncAt", 0L)

  fun setLastSyncAt(c: Context, at: Long) {
    prefs(c).edit().putLong("lastSyncAt", at).apply()
  }
}
