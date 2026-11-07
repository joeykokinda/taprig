package dev.taprig.driver.stub;

// Android refuses to instrument a target without code; this class only gives the inert stub a dex.
final class Stub {
    private Stub() {}
}
