package dev.taprig.driver;

final class Validators {
    static final int MAX_LINE_BYTES = 1_048_576;
    static final int MAX_NODES = 5_000;
    static final int MAX_WAIT_MS = 30_000;

    private Validators() {}

    static boolean validNonce(String value) {
        return value != null && value.matches("[A-Za-z0-9_-]{32,128}");
    }

    static boolean validId(String value) {
        return value != null && !value.trim().isEmpty() && value.length() <= 200;
    }

    static int waitMillis(int value) {
        if (value < 0 || value > MAX_WAIT_MS) {
            throw new IllegalArgumentException("timeoutMs must be from 0 to " + MAX_WAIT_MS);
        }
        return value;
    }
}
