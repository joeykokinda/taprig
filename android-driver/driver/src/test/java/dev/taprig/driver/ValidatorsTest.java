package dev.taprig.driver;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class ValidatorsTest {
    @Test
    public void boundsProtocolInputs() {
        assertTrue(Validators.validNonce("a".repeat(32)));
        assertFalse(Validators.validNonce("short"));
        assertTrue(Validators.validId("request-1"));
        assertFalse(Validators.validId("x".repeat(201)));
        assertEquals(30_000, Validators.waitMillis(30_000));
        assertThrows(IllegalArgumentException.class, () -> Validators.waitMillis(30_001));
    }
}
