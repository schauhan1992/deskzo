package com.deskzo.calls

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.webkit.CookieManager
import android.webkit.WebStorage
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.IOException

/**
 * The Deskzo app's calling, for its JavaScript (src/lib/native.ts): the session the background sync uses,
 * call sync on and off, a sync now, and the battery setting that decides whether Android lets it run.
 */
class DeskzoCallsModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("The app isn't running.")

  override fun definition() = ModuleDefinition {
    Name("DeskzoCalls")

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
}
