# Run artifacts and export

TapRig can retain terminal phone screenshots as private run evidence. Screen
pixels are off by default because a phone can display credentials or other
sensitive information. Opt in per run:

```console
taprig run --retain-screenshots "Open Settings"
taprig settings screenshots on
```

After an opted-in run completes or fails, the worker attempts one screenshot
for every participating phone. Capture failure never changes the run outcome;
a successful capture is written mode `0600`, registered in SQLite, and emits
`artifact.created`.

Artifact files live below the TapRig application-data directory. API and UI
responses expose metadata and authenticated content URLs, never host paths.

```console
taprig artifacts <run-id>
taprig attach <run-id>
taprig export <run-id> [output.json]
```

The export is a self-contained `taprig-run-export/v1` JSON document containing
run state, ordered events, questions, approvals, telemetry, completion evidence,
artifact metadata, and base64 artifact payloads. TapRig refuses to overwrite an
existing export, creates it mode `0600`, and caps raw artifact payloads at 100
MiB per export.

Sensitive question answers remain absent because they are never persisted.
Agent evidence is already redacted before storage. Screenshots can still contain
private on-screen information, so exports must be handled as sensitive files.

Retained artifacts currently persist until the local TapRig data is removed. Configurable
age/size retention and per-run sensitive-surface capture policy remain open in
the Settings workspace; this milestone does not claim those controls. The
durable owner default and per-run override are available now.
