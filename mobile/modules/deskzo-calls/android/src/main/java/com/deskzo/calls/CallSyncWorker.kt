package com.deskzo.calls

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Call sync in the background: a few seconds after each call ends, and every 15 minutes in case one was missed. */
class CallSyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result =
    try {
      CallSync.run(applicationContext)
      Result.success()
    } catch (e: ApiError) {
      // Signed out (401) or refused for good: nothing to retry. Busy or down: later.
      if (e.status == 429 || e.status >= 500) Result.retry() else Result.success()
    } catch (e: IOException) {
      Result.retry()
    }

  companion object {
    private const val SOON = "deskzo-call-sync"
    private const val PERIODIC = "deskzo-call-sync-periodic"

    private fun online() = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    /** A call just ended: its log entry lands a moment later. Several in a row are one sync. */
    fun enqueueSoon(c: Context) {
      val work = OneTimeWorkRequest.Builder(CallSyncWorker::class.java).setInitialDelay(4, TimeUnit.SECONDS).setConstraints(online()).build()
      WorkManager.getInstance(c).enqueueUniqueWork(SOON, ExistingWorkPolicy.REPLACE, work)
    }

    fun schedulePeriodic(c: Context) {
      val work = PeriodicWorkRequest.Builder(CallSyncWorker::class.java, 15, TimeUnit.MINUTES).setConstraints(online()).build()
      WorkManager.getInstance(c).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, work)
    }

    fun cancelAll(c: Context) {
      WorkManager.getInstance(c).cancelUniqueWork(SOON)
      WorkManager.getInstance(c).cancelUniqueWork(PERIODIC)
    }
  }
}
