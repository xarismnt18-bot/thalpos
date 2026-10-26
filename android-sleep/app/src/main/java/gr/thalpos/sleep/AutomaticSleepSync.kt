package gr.thalpos.sleep

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.work.*
import kotlinx.coroutines.CancellationException
import java.io.IOException
import java.util.concurrent.TimeUnit

object AutomaticSleepSync {
    const val BACKGROUND_PERMISSION = "android.permission.health.READ_HEALTH_DATA_IN_BACKGROUND"
    private const val PERIODIC = "thalpos-sleep-periodic"
    private const val IMMEDIATE = "thalpos-sleep-immediate"
    fun supported(context: Context): Boolean = runCatching {
        HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE &&
            HealthConnectClient.getOrCreate(context).features.getFeatureStatus(
                HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND
            ) == HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
    }.getOrDefault(false)

    suspend fun permitted(context: Context): Boolean {
        if (!supported(context)) return false
        val granted = HealthConnectClient.getOrCreate(context).permissionController.getGrantedPermissions()
        return BACKGROUND_PERMISSION in granted && HealthPermission.getReadPermission(SleepSessionRecord::class) in granted
    }

    fun schedule(context: Context) {
        val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        val periodic = PeriodicWorkRequestBuilder<SleepSyncWorker>(30, TimeUnit.MINUTES)
            .setConstraints(constraints).setInitialDelay(30, TimeUnit.MINUTES)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES).build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, periodic)
        val immediate = OneTimeWorkRequestBuilder<SleepSyncWorker>().setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES).build()
        WorkManager.getInstance(context).enqueueUniqueWork(IMMEDIATE, ExistingWorkPolicy.KEEP, immediate)
    }

    fun stop(context: Context) {
        context.getSharedPreferences("settings",Context.MODE_PRIVATE).edit().putBoolean("auto_enabled",false).apply()
        WorkManager.getInstance(context).cancelUniqueWork(PERIODIC)
        WorkManager.getInstance(context).cancelUniqueWork(IMMEDIATE)
    }
}

class SleepSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context,params) {
    override suspend fun doWork(): Result {
        val prefs = applicationContext.getSharedPreferences("settings",Context.MODE_PRIVATE)
        if (!prefs.getBoolean("auto_enabled",false)) return Result.success()
        fun note(message: String) { prefs.edit().putString("auto_status",message).putLong("auto_attempt",System.currentTimeMillis()).apply() }
        return try {
            if (!AutomaticSleepSync.permitted(applicationContext)) {
                note("Αναμονή άδειας Health Connect για ύπνο και ανάγνωση στο παρασκήνιο.")
                return Result.success()
            }
            val configuration = SyncConfiguration(prefs.getString("url","") ?: "", SecretStore(applicationContext).read(),
                prefs.getString("room","") ?: "", prefs.getString("source","") ?: "")
            if (!configuration.valid()) {
                note("Χρειάζεται έγκυρη αποθηκευμένη σύνδεση. Κάνε μία χειροκίνητη αποστολή.")
                return Result.success()
            }
            val result = SleepSync(applicationContext).send(configuration)
            if (result == null) note("Δεν υπάρχουν ακόμη δεδομένα της επιλεγμένης πηγής. Θα ξαναδοκιμάσω.")
            else {
                note("Αυτόματος συγχρονισμός: ${result.first} εγγραφές.")
                prefs.edit().putLong("auto_success",System.currentTimeMillis()).apply()
            }
            Result.success()
        } catch (e: CancellationException) { throw e }
        catch (_: SecurityException) { note("Η άδεια ύπνου ή παρασκηνίου ανακλήθηκε. Ενεργοποίησέ την ξανά."); Result.success() }
        catch (e: SyncHttpException) {
            note(if(e.status==401) "Το κλειδί σύνδεσης δεν έγινε δεκτό. Έλεγξε τη σύνδεση." else "Η γέφυρα απάντησε HTTP ${e.status}.")
            if(e.retryable() && runAttemptCount<4) Result.retry() else Result.success()
        } catch (_: IOException) {
            note("Δεν είναι προσβάσιμο το Thalpos. Έλεγξε υπολογιστή και Tailscale. Θα ξαναδοκιμάσω.")
            if(runAttemptCount<4) Result.retry() else Result.success()
        } catch (_: Exception) {
            note("Δεν ολοκληρώθηκε ο συγχρονισμός. Έλεγξε τα δεδομένα με χειροκίνητη αποστολή.")
            Result.success()
        }
    }
}
