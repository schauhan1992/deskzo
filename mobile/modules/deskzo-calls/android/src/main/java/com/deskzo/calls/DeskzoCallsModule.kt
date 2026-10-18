package com.deskzo.calls

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.WindowManager
import android.webkit.CookieManager
import androidx.annotation.RequiresApi
import android.webkit.WebStorage
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.IOException

/**
 * The Deskzo app's calling, for its JavaScript (src/lib/native.ts): the session the background sync uses,
 * call sync on and off, a sync now, and the battery setting that decides whether Android lets it run.
 *
 * And the workspace's screen rules (src/lib/app/dlp.ts on the server): a screenshot taken in the app is reported
 * to its JavaScript (Android 14 and later tell an app; nothing older does without reading the photo library,
 * which the app never asks for), and screenshots are blocked on its screens when asked.
 */
class DeskzoCallsModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("The app isn't running.")

  private var screenshotsBlocked = false
  private var watched: Activity? = null
  /** An Activity.ScreenCaptureCallback, on Android 14 and later. */
  private var captureCallback: Any? = null

  override fun definition() = ModuleDefinition {
    Name("DeskzoCalls")

    Events("onScreenshot")

    Function("screenshotsDetectable") { Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE }

    /** Blocks screenshots (and screen recording) on the app's screens, or lets them be — and starts listening. */
    Function("setScreenshotsBlocked") { blocked: Boolean ->
      screenshotsBlocked = blocked
      appContext.currentActivity?.let { activity ->
        activity.runOnUiThread {
          applyScreenRules(activity)
          watch(activity)
        }
      }
    }

    // Also sent as the module starts, on the JavaScript thread: windows are only touched on the main one.
    OnActivityEntersForeground {
      try {
        appContext.currentActivity?.let { activity ->
          activity.runOnUiThread {
            applyScreenRules(activity)
            watch(activity)
          }
        }
      } catch (e: Throwable) {
        android.util.Log.e("DeskzoCalls", "foreground", e)
      }
    }

    OnActivityEntersBackground {
      try {
        unwatch()
      } catch (e: Throwable) {
        android.util.Log.e("DeskzoCalls", "background", e)
      }
    }

    Function("getSession") {
      val s = Store.session(context) ?: return@Function null
      mapOf("baseUrl" to s.baseUrl, "token" to s.token, "host" to s.host)
    }

    Function("signedOut") { Store.signedOut(context) }

    Function("setSession") { baseUrl: String, token: String, host: String? ->
      Store.saveSession(context, Session(baseUrl, token, host))
    }

    Function("clearSession") {
      CallSyncWorker.cancelAll(context)
      Alerts.clearAll(context)
      Store.clear(context)
      // The in-app pages' sign-in and device cookie, and what they stored — nothing of Deskzo stays on the phone.
      Handler(Looper.getMainLooper()).post {
        CookieManager.getInstance().removeAllCookies(null)
        WebStorage.getInstance().deleteAllData()
      }
    }

    Function("getCallSync") {
      mapOf("on" to Store.callSync(context), "from" to Store.syncFrom(context).toDouble(), "lastSyncAt" to Store.lastSyncAt(context).toDouble())
    }

    Function("setCallSync") { on: Boolean ->
      Store.setCallSync(context, on)
      if (on) {
        CallSyncWorker.schedulePeriodic(context)
        CallSyncWorker.enqueueSoon(context)
      } else {
        CallSyncWorker.cancelAll(context)
      }
    }

    AsyncFunction("syncNow") {
      try {
        val r = CallSync.run(context)
        mapOf("sent" to r.sent, "logged" to r.logged, "error" to null)
      } catch (e: ApiError) {
        mapOf("sent" to 0, "logged" to 0, "error" to (e.code ?: "http_${e.status}"))
      } catch (e: IOException) {
        mapOf("sent" to 0, "logged" to 0, "error" to "offline")
      }
    }

    Function("ignoresBatteryOptimizations") {
      val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      power.isIgnoringBatteryOptimizations(context.packageName)
    }

    Function("openBatterySettings") {
      val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }
  }

  private fun applyScreenRules(activity: Activity) {
    if (screenshotsBlocked) activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
  }

  private fun watch(activity: Activity) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE || watched === activity) return
    unwatch()
    register(activity)
  }

  @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
  private fun register(activity: Activity) {
    val callback = Activity.ScreenCaptureCallback { sendEvent("onScreenshot", mapOf<String, Any?>()) }
    activity.registerScreenCaptureCallback(activity.mainExecutor, callback)
    captureCallback = callback
    watched = activity
  }

  private fun unwatch() {
    val activity = watched ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) unregister(activity)
    watched = null
    captureCallback = null
  }

  @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
  private fun unregister(activity: Activity) {
    val callback = captureCallback as? Activity.ScreenCaptureCallback ?: return
    try {
      activity.unregisterScreenCaptureCallback(callback)
    } catch (_: IllegalStateException) {
      // Already gone with the activity.
    }
  }
}
