package gr.thalpos.sleep

import android.app.Activity
import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class PrivacyActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val text = TextView(this).apply {
            textSize = 17f
            setPadding(28, 40, 28, 40)
            text = """
                Thalpos Sleep — προσωπικό πρωτότυπο

                Ζητά άδεια ανάγνωσης ύπνου και, μόνο αν ενεργοποιήσεις τον αυτόματο συγχρονισμό, άδεια ανάγνωσης στο παρασκήνιο. Δεν γράφει ή διαγράφει δεδομένα στο Health Connect και δεν επικοινωνεί απευθείας με το ρολόι.

                Διαβάζει τις τελευταίες επτά ημέρες από την πηγή που επιλέγεις. Με χειροκίνητη αποστολή ή αφού ενεργοποιήσεις ρητά τον αυτόματο συγχρονισμό, μεταφέρει μέσω HTTPS στον αποθηκευμένο δικό σου προορισμό Thalpos: αναγνωριστικά εγγραφών, προέλευση, ώρες συνεδρίας, χρόνο ενημέρωσης και στάδια ύπνου. Δεν στέλνει όνομα, email, παλμούς ή τοποθεσία.

                Η αποστολή πρόσφατων εγγραφών ενημερώνει διορθωμένες καταγραφές και αφαιρεί εγγραφές που έχουν διαγραφεί από την ίδια πηγή μέσα στο παράθυρο συγχρονισμού. Η επιλογή άδειας πηγής μπορεί συνεπώς να διαγράψει παλαιές εισαγωγές της στο αντίστοιχο διάστημα.

                Ο προαιρετικός αυτόματος συγχρονισμός προγραμματίζεται περίπου ανά 30 λεπτά μέσω Android WorkManager και μπορεί να καθυστερεί λόγω μπαταρίας ή δικτύου. Στέλνει μόνο δεδομένα που έχει ήδη γράψει το Mi Fitness στο Health Connect. Δεν εξαναγκάζει συγχρονισμό του ρολογιού. Διακόπτεται από το αντίστοιχο κουμπί ή με ανάκληση της άδειας. Μετά από αναγκαστική διακοπή της εφαρμογής χρειάζεται να την ανοίξεις ξανά.

                Δεν υπάρχουν analytics ή διαφημίσεις. Τα δεδομένα ύπνου μένουν προσωρινά στη μνήμη της εφαρμογής. Το κλειδί σύνδεσης αποθηκεύεται κρυπτογραφημένο με Android Keystore. Τα αντίγραφα ασφαλείας της εφαρμογής είναι απενεργοποιημένα.

                Στον υπολογιστή σου οι εισαγωγές αποθηκεύονται τοπικά για έως 90 ημέρες και αφαιρούνται στην επόμενη επιτυχή εισαγωγή μετά τη λήξη. Μπορείς να τις διαγράψεις από τη σελίδα Sleep. Τα ανεξάρτητα αντίγραφα ασφαλείας του υπολογιστή χρειάζονται ξεχωριστή διαχείριση.

                Μπορείς να ανακαλέσεις την άδεια από το Health Connect και να αφαιρέσεις το αποθηκευμένο κλειδί από την εφαρμογή. Η ανάκληση σταματά νέες αναγνώσεις, δεν διαγράφει προηγούμενες εισαγωγές στον υπολογιστή.

                Τα στάδια είναι εκτιμήσεις του wearable. Δεν αποτελεί ιατροτεχνολογικό προϊόν ή εργαλείο διάγνωσης.
            """.trimIndent()
        }
        val scroll = ScrollView(this).apply { addView(text) }
        ViewCompat.setOnApplyWindowInsetsListener(scroll) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        setContentView(scroll)
    }
}
