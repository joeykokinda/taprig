# Deterministic scripts

Scripts turn a repeated, known phone workflow into versioned deterministic
actions. They do not call a model while their checkpoints continue to pass.

```console
taprig script create examples/open-settings-section.script.json
taprig script list
taprig script inspect open-settings-section
taprig script run open-settings-section <device-id> section=System expected-heading=Languages
```

Each script declares an ID, immutable positive version, origin, string
parameters, typed action steps, and optional post-action checkpoints. Saved
versions are private `0600` JSON files; saving the same ID/version twice is
rejected instead of silently overwriting evidence.

A step always starts from a fresh observation generation. TapRig executes one
typed batch and requires the executor to mark it verified. A checkpoint can
then require the expected foreground package, semantic selector, or both from a
new observation. Missing parameters, unknown parameters, stale actions,
unverified results, and checkpoint drift stop the script.

The result is either:

- `completed`, with the verified step count; or
- `recovery-needed`, with the failed step and reason.

The second result is the stable boundary for the agent worker: it receives the
script ID/version, parameters, last verified checkpoint, fresh phone state, and
failure evidence. It must recover or ask rather than blindly replaying the
failed action.
