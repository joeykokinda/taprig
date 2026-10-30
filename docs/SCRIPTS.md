# Deterministic scripts

Scripts turn a repeated, known phone workflow into versioned deterministic
actions. They do not call a model while their checkpoints continue to pass.

```console
taprig script create examples/open-settings-section.script.json
taprig script list
taprig script inspect open-settings-section
taprig script run open-settings-section <device-id> section=System expected-heading=Languages
taprig script promote <completed-run-id> my-script "My script"
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

When a configured worker is available, `recovery-needed` creates a durable
recovery run pinned to the same phone. Parameter values are not copied into its
task or normal events. The worker observes fresh state and must recover or ask
rather than blindly replaying the failed action.

A completed model run retains its verified typed actions in a private completion
checkpoint. Promotion is explicit: `script promote` converts those actions into
the next immutable `learned` script version. It never silently turns every run
into automation; the user chooses the stable workflow name and ID.
