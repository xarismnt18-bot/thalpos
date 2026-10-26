package gr.thalpos.sleep

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.time.Instant
import java.time.temporal.ChronoUnit
import javax.net.ssl.HttpsURLConnection

data class SyncConfiguration(val endpoint: String, val secret: String, val room: String, val source: String) {
    fun valid(): Boolean {
        val uri = runCatching { URI(endpoint) }.getOrNull()
        return uri?.scheme == "https" && !uri.host.isNullOrBlank() && uri.userInfo == null &&
            uri.query == null && uri.fragment == null && secret.length >= 32 &&
            room.isNotBlank() && room.length <= 80 && source.isNotBlank()
    }
}

class SyncHttpException(val status: Int) : Exception("HTTP $status") {
    fun retryable() = status == 408 || status == 429 || status >= 500
}

/** Same implementation for manual sends and background work; never overlap uploads. */
class SleepSync(private val context: Context) {
    companion object { private val lock = Mutex() }
    private fun health() = HealthConnectClient.getOrCreate(context)

    suspend fun readAll(start: Instant, end: Instant): List<SleepSessionRecord> {
        val permission = HealthPermission.getReadPermission(SleepSessionRecord::class)
        if (permission !in health().permissionController.getGrantedPermissions()) throw SecurityException("Missing sleep permission")
        val records = mutableListOf<SleepSessionRecord>()
        var page: String? = null
        do {
            val response = health().readRecords(ReadRecordsRequest(
                recordType = SleepSessionRecord::class,
                timeRangeFilter = TimeRangeFilter.between(start, end),
                ascendingOrder = true, pageSize = 200, pageToken = page,
            ))
            records.addAll(response.records)
            if (records.size > 2000) error("Too many source records")
            page = response.pageToken
        } while (page != null)
        return records.filter { it.startTime < end && it.endTime > start }
    }

    /** Null means no records; never replace the server with a suspicious empty snapshot. */
    suspend fun send(configuration: SyncConfiguration): Pair<Int, Int>? = lock.withLock {
        require(configuration.valid())
        val end = Instant.now(); val start = end.minus(7, ChronoUnit.DAYS)
        val records = readAll(start, end).filter { it.metadata.dataOrigin.packageName == configuration.source }
        require(records.size <= 200)
        if (records.isEmpty()) return@withLock null
        val payload = JSONObject().put("schema_version", 1).put("source", configuration.source).put("room", configuration.room)
            .put("range_start", start.toString()).put("range_end", end.toString())
        val sessions = JSONArray()
        records.forEach { record ->
            val stages = JSONArray()
            record.stages.forEach { stage -> stages.put(JSONObject().put("start", stage.startTime.toString())
                .put("end", stage.endTime.toString()).put("stage", stageName(stage.stage))) }
            sessions.put(JSONObject().put("record_id", record.metadata.id).put("modified", record.metadata.lastModifiedTime.toString())
                .put("start", record.startTime.toString()).put("end", record.endTime.toString()).put("stages", stages))
        }
        payload.put("sessions", sessions)
        val bytes = payload.toString().toByteArray(Charsets.UTF_8)
        require(bytes.size <= 2_000_000)
        val reply = withContext(Dispatchers.IO) {
            val connection = URI("${configuration.endpoint}/sync").toURL().openConnection() as HttpsURLConnection
            try {
                connection.requestMethod = "POST"; connection.instanceFollowRedirects = false
                connection.connectTimeout = 15000; connection.readTimeout = 30000; connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setRequestProperty("Authorization", "Bearer ${configuration.secret}")
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
                val code = connection.responseCode
                if (code != 200) throw SyncHttpException(code)
                connection.inputStream.bufferedReader().use { it.readText() }
            } finally { connection.disconnect() }
        }
        val result = JSONObject(reply)
        result.getInt("received") to result.getInt("removed")
    }

    private fun stageName(stage: Int): String = when (stage) {
        SleepSessionRecord.STAGE_TYPE_AWAKE -> "awake"
        SleepSessionRecord.STAGE_TYPE_SLEEPING -> "sleeping"
        SleepSessionRecord.STAGE_TYPE_OUT_OF_BED -> "out_of_bed"
        SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED -> "awake_in_bed"
        SleepSessionRecord.STAGE_TYPE_LIGHT -> "light"
        SleepSessionRecord.STAGE_TYPE_DEEP -> "deep"
        SleepSessionRecord.STAGE_TYPE_REM -> "rem"
        else -> "unknown"
    }
}
