package com.deskzo.calls

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.TelephonyManager

/**
 * The phone ringing, answered, put down — from the system, with the app closed too (AndroidManifest.xml).
 *
 * Ringing, with the number (Android hands it over only with the call log permission): caller ID, if it is a
 * customer. Put down: call sync, a few seconds on, once the call log has the call.
 */
class CallStateReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != TelephonyManager.ACTION_PHONE_STATE_CHANGED) return
    if (!Store.callSync(context)) return
    when (intent.getStringExtra(TelephonyManager.EXTRA_STATE)) {
      TelephonyManager.EXTRA_STATE_RINGING -> {
        @Suppress("DEPRECATION")
        val number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER) ?: return
        if (number.count { it.isDigit() } < 6) return
        // The lookup is a network call: done off the main thread, within the time a receiver is given.
        val pending = goAsync()
        Thread {
          try {
            CallSync.lookup(context, number)?.let { (who, text) -> Alerts.caller(context, who, text) }
          } finally {
            pending.finish()
          }
        }.start()
      }
      TelephonyManager.EXTRA_STATE_IDLE -> {
        Alerts.clearCaller(context)
        CallSyncWorker.enqueueSoon(context)
      }
    }
  }
}
