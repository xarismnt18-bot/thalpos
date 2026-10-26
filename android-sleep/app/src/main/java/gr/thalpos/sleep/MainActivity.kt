package gr.thalpos.sleep

import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.view.WindowManager
import android.widget.*
import androidx.activity.ComponentActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.net.URI
import java.time.Instant
import java.time.temporal.ChronoUnit

class MainActivity : ComponentActivity() {
    private lateinit var url: EditText
    private lateinit var token: EditText
    private lateinit var room: EditText
    private lateinit var status: TextView
    private lateinit var source: Spinner
    private lateinit var send: Button
    private lateinit var read: Button
    private lateinit var secrets: SecretStore
    private lateinit var autoStatus: TextView
    private var pendingAuto: SyncConfiguration? = null
    private var sources = emptyList<String>()
    private var busy = false
    private val preferenceListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (::autoStatus.isInitialized && key?.startsWith("auto_") == true) refreshAutoStatus()
    }
    private val permissions = setOf(HealthPermission.getReadPermission(SleepSessionRecord::class))
    private val permissionRequest = registerForActivityResult(PermissionController.createRequestPermissionResultContract()) { granted ->
        val configuration = pendingAuto
        pendingAuto = null
        if (configuration != null) {
            if (granted.containsAll(permissions + AutomaticSleepSync.BACKGROUND_PERMISSION)) activateAuto()
            else status.text = "Δεν ενεργοποιήθηκε ο αυτόματος συγχρονισμός. Η χειροκίνητη αποστολή παραμένει διαθέσιμη."
        } else if (granted.containsAll(permissions)) loadPreview()
        else status.text = "Δεν δόθηκε άδεια ανάγνωσης ύπνου."
    }
    private fun health() = HealthConnectClient.getOrCreate(this)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        secrets = SecretStore(this)
        val prefs = getSharedPreferences("settings", MODE_PRIVATE)
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(28, 48, 28, 32)
        }
        fun label(value: String) { layout.addView(TextView(this).apply { text = value; textSize = 16f; setPadding(0, 16, 0, 8) }) }
        label("Thalpos Sleep 0.2 — αυτόματος συγχρονισμός")
        label("Συγχρόνισε πρώτα το ρολόι με το Mi Fitness. Διάβασε τις καταγραφές, επίλεξε την πηγή Mi Fitness και στείλε τις τελευταίες 7 ημέρες στο δικό σου Thalpos.")
        label("Διεύθυνση HTTPS γέφυρας")
        url = EditText(this).apply { hint = "https://your-pc.your-tailnet.ts.net/wearable"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI; setSingleLine(); setText(prefs.getString("url", "")) }
        layout.addView(url)
        label("Κλειδί σύνδεσης")
        token = EditText(this).apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD; setSingleLine(); setText(secrets.read()) }
        layout.addView(token)
        label("Όνομα δωματίου όπως στο Thalpos")
        room = EditText(this).apply { setSingleLine(); setText(prefs.getString("room", "Bedroom")) }
        layout.addView(room)
        read = Button(this).apply { text = "1  Άδεια και ανάγνωση ύπνου"; setOnClickListener { connect() } }
        layout.addView(read)
        label("Πηγή δεδομένων — έλεγξε ότι είναι το Mi Fitness")
        source = Spinner(this); layout.addView(source)
        send = Button(this).apply { text = "2  Αποστολή στο Thalpos"; isEnabled = false; setOnClickListener { sync() } }
        layout.addView(send)
        status = TextView(this).apply { text = "Χειροκίνητη αποστολή με το κουμπί. Για αποστολή χωρίς να ανοίγεις την εφαρμογή, ενεργοποίησε τον αυτόματο συγχρονισμό παρακάτω."; setPadding(0, 18, 0, 18) }
        layout.addView(status)
        label("Αυτόματη αποστολή στο αποθηκευμένο Thalpos περίπου ανά 30 λεπτά, όταν το Android το επιτρέπει. Απαιτεί δεδομένα από Mi Fitness, άδεια παρασκηνίου, δίκτυο, ενεργό Tailscale και υπολογιστή.")
        layout.addView(Button(this).apply { text = "Ενεργοποίηση αυτόματου συγχρονισμού"; setOnClickListener { enableAuto() } })
        layout.addView(Button(this).apply { text = "Διακοπή αυτόματου συγχρονισμού"; setOnClickListener {
            AutomaticSleepSync.stop(this@MainActivity); refreshAutoStatus()
        } })
        autoStatus = TextView(this).apply { setPadding(0, 16, 0, 16) }
        layout.addView(autoStatus)
        layout.addView(Button(this).apply { text = "Χρήση δεδομένων και απόρρητο"; setOnClickListener { startActivity(Intent(this@MainActivity, PrivacyActivity::class.java)) } })
        layout.addView(Button(this).apply { text = "Ξέχνα τη σύνδεση"; setOnClickListener {
            if (!busy) { AutomaticSleepSync.stop(this@MainActivity); secrets.clear(); prefs.edit().clear().apply(); token.setText(""); url.setText(""); sources = emptyList(); send.isEnabled = false; source.adapter = null; status.text = "Η σύνδεση αφαιρέθηκε. Οι εισαγωγές στον υπολογιστή δεν διαγράφονται."; refreshAutoStatus() }
        } })
        val scroll = ScrollView(this).apply { addView(layout) }
        ViewCompat.setOnApplyWindowInsetsListener(scroll) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        setContentView(scroll)
        refreshAutoStatus()
    }

    override fun onResume() {
        super.onResume()
        if (::autoStatus.isInitialized) refreshAutoStatus()
    }

    override fun onStart() {
        super.onStart()
        getSharedPreferences("settings", MODE_PRIVATE).registerOnSharedPreferenceChangeListener(preferenceListener)
    }

    override fun onStop() {
        getSharedPreferences("settings", MODE_PRIVATE).unregisterOnSharedPreferenceChangeListener(preferenceListener)
        super.onStop()
    }

    private fun refreshAutoStatus() {
        lifecycleScope.launch {
            val prefs = getSharedPreferences("settings", MODE_PRIVATE)
            val enabled = prefs.getBoolean("auto_enabled", false)
            val allowed = runCatching { AutomaticSleepSync.permitted(this@MainActivity) }.getOrDefault(false)
            val last = prefs.getLong("auto_success", 0)
            val lastText = if (last > 0) java.text.DateFormat.getDateTimeInstance().format(java.util.Date(last)) else "Δεν έχει ολοκληρωθεί ακόμη"
            autoStatus.text = "Αυτόματος συγχρονισμός: ${if (!enabled) "ΑΝΕΝΕΡΓΟΣ" else if (allowed) "ΠΡΟΓΡΑΜΜΑΤΙΣΜΕΝΟΣ" else "ΑΝΑΜΟΝΗ ΑΔΕΙΑΣ"}\nΤελευταία αυτόματη επιτυχία: $lastText\n${prefs.getString("auto_status", "") ?: ""}\nΤο Android μπορεί να καθυστερεί την εκτέλεση για εξοικονόμηση μπαταρίας."
        }
    }

    private fun enableAuto() {
        if (busy) return
        if (!AutomaticSleepSync.supported(this)) {
            status.text = "Αυτή η έκδοση Health Connect δεν υποστηρίζει ανάγνωση στο παρασκήνιο. Έλεγξε ενημερώσεις Android/Health Connect. Ο χειροκίνητος συγχρονισμός λειτουργεί κανονικά."
            return
        }
        val prefs = getSharedPreferences("settings", MODE_PRIVATE)
        val configuration = SyncConfiguration(prefs.getString("url", "") ?: "", secrets.read(),
            prefs.getString("room", "") ?: "", prefs.getString("source", "") ?: "")
        if (!configuration.valid()) {
            status.text = "Κάνε πρώτα μία επιτυχή χειροκίνητη αποστολή για να αποθηκευτεί η πηγή και ο προορισμός."
            return
        }
        android.app.AlertDialog.Builder(this)
            .setTitle("Αυτόματη αποστολή ύπνου")
            .setMessage("Θα διαβάζονται οι τελευταίες 7 ημέρες από ${configuration.source} και θα στέλνονται στο ${URI(configuration.endpoint).host}, δωμάτιο ${configuration.room}, περίπου ανά 30 λεπτά. Μπορείς να το διακόψεις οποτεδήποτε. Η λειτουργία δεν αναγκάζει το Mi Fitness να συγχρονίσει το ρολόι.")
            .setNegativeButton("Άκυρο", null)
            .setPositiveButton("Ενεργοποίηση") { _, _ -> lifecycleScope.launch {
                if (AutomaticSleepSync.permitted(this@MainActivity)) activateAuto()
                else {
                    pendingAuto = configuration
                    permissionRequest.launch(permissions + AutomaticSleepSync.BACKGROUND_PERMISSION)
                }
            } }.show()
    }

    private fun activateAuto() {
        lifecycleScope.launch {
            if (!AutomaticSleepSync.permitted(this@MainActivity)) {
                status.text = "Χρειάζεται η άδεια ανάγνωσης στο παρασκήνιο."; refreshAutoStatus(); return@launch
            }
            getSharedPreferences("settings", MODE_PRIVATE).edit().putBoolean("auto_enabled", true).apply()
            AutomaticSleepSync.schedule(this@MainActivity)
            status.text = "Προγραμματίστηκε ο αυτόματος συγχρονισμός. Η πρώτη προσπάθεια θα γίνει μόλις υπάρχει δίκτυο."
            refreshAutoStatus()
        }
    }

    private fun setBusy(value: Boolean) {
        busy = value; read.isEnabled = !value; send.isEnabled = !value && sources.isNotEmpty()
    }
    private fun connect() {
        if (busy) return
        when (HealthConnectClient.getSdkStatus(this)) {
            HealthConnectClient.SDK_UNAVAILABLE -> status.text = "Το Health Connect δεν είναι διαθέσιμο σε αυτή τη συσκευή."
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> {
                status.text = "Χρειάζεται εγκατάσταση ή ενημέρωση Health Connect."
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=com.google.android.apps.healthdata")))
            }
            else -> lifecycleScope.launch {
                try {
                    if (health().permissionController.getGrantedPermissions().containsAll(permissions)) loadPreview()
                    else permissionRequest.launch(permissions)
                } catch (_: Exception) { status.text = "Δεν ήταν δυνατή η πρόσβαση στο Health Connect. Έλεγξε άδεια και ενημερώσεις." }
            }
        }
    }

    private fun loadPreview() {
        lifecycleScope.launch {
            setBusy(true)
            try {
                val end = Instant.now()
                val records = SleepSync(this@MainActivity).readAll(end.minus(7, ChronoUnit.DAYS), end)
                val groups = records.groupBy { it.metadata.dataOrigin.packageName }
                sources = groups.keys.sorted()
                source.adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item,
                    sources.map { "$it (${groups[it]!!.size} εγγραφές)" })
                val savedSource = getSharedPreferences("settings", MODE_PRIVATE).getString("source", "")
                val savedIndex = sources.indexOf(savedSource)
                if (savedIndex >= 0) source.setSelection(savedIndex)
                status.text = if (records.isEmpty()) "Δεν βρέθηκε ύπνος τις τελευταίες 7 ημέρες. Συγχρόνισε Mi Fitness και ξαναδοκίμασε."
                    else "Βρέθηκαν ${records.size} εγγραφές με ${records.sumOf { it.stages.size }} στάδια. Επίλεξε πηγή. Δεν έχουν αποσταλεί ακόμη."
            } catch (_: Exception) {
                sources = emptyList()
                status.text = "Αποτυχία ανάγνωσης. Έλεγξε άδεια ύπνου στο Health Connect και συγχρόνισε ξανά το Mi Fitness."
            } finally { setBusy(false) }
        }
    }

    private fun sync() {
        if (busy || sources.isEmpty()) return
        val selected = sources.getOrNull(source.selectedItemPosition) ?: return
        val endpoint = url.text.toString().trim().trimEnd('/')
        val secret = token.text.toString().trim()
        val roomName = room.text.toString().trim()
        val uri = runCatching { URI(endpoint) }.getOrNull()
        if (uri?.scheme != "https" || uri.host.isNullOrBlank() || uri.userInfo != null || uri.query != null || uri.fragment != null) {
            status.text = "Βάλε έγκυρη διεύθυνση HTTPS, χωρίς κωδικό, query ή fragment."; return
        }
        if (secret.length < 32 || roomName.isBlank() || roomName.length > 80) {
            status.text = "Έλεγξε το κλειδί σύνδεσης και το όνομα δωματίου."; return
        }
        android.app.AlertDialog.Builder(this)
            .setTitle("Αποστολή προσωπικών δεδομένων ύπνου")
            .setMessage("Πηγή: $selected\nΠροορισμός: ${uri.host}\nΔωμάτιο: $roomName\n\nΘα σταλούν όλες οι καταγραφές της πηγής για τις τελευταίες 7 ημέρες. Η αποστολή ενημερώνει και αφαιρεί παλαιές εισαγωγές του ίδιου διαστήματος.")
            .setNegativeButton("Άκυρο", null)
            .setPositiveButton("Αποστολή") { _, _ -> upload(endpoint, secret, roomName, selected) }
            .show()
    }

    private fun upload(endpoint: String, secret: String, roomName: String, selected: String) {
        lifecycleScope.launch {
            setBusy(true)
            try {
                val result = SleepSync(this@MainActivity).send(SyncConfiguration(endpoint, secret, roomName, selected))
                if (result == null) {
                    status.text = "Δεν υπάρχουν ακόμη δεδομένα αυτής της πηγής. Δεν έγινε αποστολή άδειου στιγμιότυπου."
                    return@launch
                }
                secrets.save(secret)
                getSharedPreferences("settings", MODE_PRIVATE).edit().putString("url", endpoint)
                    .putString("room", roomName).putString("source", selected).apply()
                status.text = "Επιτυχία: ${result.first} εγγραφές. Η σελίδα Sleep ανανεώνεται αυτόματα όταν είναι ξεκλείδωτη."
                refreshAutoStatus()
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                val code = (e as? SyncHttpException)?.status
                status.text = "Αποτυχία συγχρονισμού${code?.let { " (HTTP $it)" } ?: ""}. Έλεγξε Tailscale, διεύθυνση, κλειδί και άδεια ύπνου."
            } finally { setBusy(false) }
        }
    }
}
