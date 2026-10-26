package gr.thalpos.sleep

import org.junit.Assert.*
import org.junit.Test

class SyncConfigurationTest {
    private val valid = SyncConfiguration("https://my-pc.example/wearable", "a".repeat(43),"Bedroom","com.xiaomi.wearable")
    @Test fun acceptsPrivateHttpsConfiguration() { assertTrue(valid.valid()) }
    @Test fun rejectsInsecureOrAmbiguousDestinations() {
        listOf("http://my-pc.example", "https://user:pass@my-pc.example", "https://my-pc.example?token=x",
            "https://my-pc.example#fragment", "file:///tmp/sleep", "https:///missing-host").forEach {
            assertFalse(it,valid.copy(endpoint=it).valid())
        }
    }
    @Test fun requiresExplicitSourceAndPairing() {
        assertFalse(valid.copy(source="").valid())
        assertFalse(valid.copy(secret="short").valid())
        assertFalse(valid.copy(room=" ").valid())
    }
    @Test fun onlyTransientHttpFailuresAreRetried() {
        listOf(408,429,500,503).forEach { assertTrue(SyncHttpException(it).retryable()) }
        listOf(301,401,403,413,422).forEach { assertFalse(SyncHttpException(it).retryable()) }
    }
}
