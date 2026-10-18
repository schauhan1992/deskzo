package com.deskzo.calls

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * What the app says on the phone, from the background:
 *
 *   · Caller ID — who is ringing, while it rings, when they are a customer the person can see.
 *   · After a call with a customer — "How did it go?", opening the after-call card; or, for a customer's
 *     call nobody took, that a callback is now on their list.
 */
internal object Alerts {
  private const val CALLER = "caller"
  private const val AFTER_CALL = "after-call"
  private const val CALLER_ID = 4100

  private fun channels(c: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = c.getSystemService(NotificationManager::class.java) ?: return
    manager.createNotificationChannel(NotificationChannel(CALLER, "Who's calling", NotificationManager.IMPORTANCE_HIGH).apply { description = "The customer behind a ringing number." })
    manager.createNotificationChannel(NotificationChannel(AFTER_CALL, "After a call", NotificationManager.IMPORTANCE_DEFAULT).apply { description = "Saying how a call with a customer went." })
  }

  private fun allowed(c: Context): Boolean =
    Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

  /** Opens the app at a deskzo:// address. */
  private fun open(c: Context, link: String, requestCode: Int): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link)).setPackage(c.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    return PendingIntent.getActivity(c, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  private fun post(c: Context, id: Int, build: NotificationCompat.Builder) {
    if (!allowed(c)) return
    channels(c)
    try {
      NotificationManagerCompat.from(c).notify(id, build.build())
    } catch (_: SecurityException) {
      // Notifications turned off after the check — nothing to say.
    }
  }

  fun caller(c: Context, title: String, text: String) {
    post(
      c,
      CALLER_ID,
      NotificationCompat.Builder(c, CALLER)
        .setSmallIcon(android.R.drawable.sym_call_incoming)
        .setContentTitle(title)
        .setContentText(text)
        .setStyle(NotificationCompat.BigTextStyle().bigText(text))
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .setOnlyAlertOnce(true)
        .setTimeoutAfter(120_000)
        .setContentIntent(open(c, "deskzo://", CALLER_ID)),
    )
  }

  fun clearCaller(c: Context) {
    NotificationManagerCompat.from(c).cancel(CALLER_ID)
  }

  fun afterCall(c: Context, callId: String, who: String, company: String) {
    val id = 5000 + (callId.hashCode() and 0xfff)
    post(
      c,
      id,
      NotificationCompat.Builder(c, AFTER_CALL)
        .setSmallIcon(android.R.drawable.sym_action_call)
        .setContentTitle("How did the call with $who go?")
        .setContentText("$company — tap to say, add a note or a callback.")
        .setAutoCancel(true)
        .setContentIntent(open(c, "deskzo://review/$callId", id)),
    )
  }

  fun missed(c: Context, who: String, company: String) {
    val id = 6000 + ("$who|$company".hashCode() and 0xfff)
    post(
      c,
      id,
      NotificationCompat.Builder(c, AFTER_CALL)
        .setSmallIcon(android.R.drawable.sym_call_missed)
        .setContentTitle("Missed call from $who")
        .setContentText("$company — a callback is on your list.")
        .setAutoCancel(true)
        .setContentIntent(open(c, "deskzo://", id)),
    )
  }

  fun clearAll(c: Context) {
    NotificationManagerCompat.from(c).cancelAll()
  }
}
