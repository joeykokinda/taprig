# Owner settings

TapRig keeps non-secret owner defaults in a private, atomically replaced
`settings.json` beside its SQLite database. The daemon, CLI, and control room use
the same live settings service.

```console
taprig settings
taprig settings approval explicit
taprig settings approval autonomous
taprig settings screenshots on
taprig settings screenshots off
```

`explicit` permits an approval pause only when the task itself requests
confirmation. `autonomous` instructs the phone model never to request approval
and rejects a model response that violates that policy. It does not weaken
questions for genuinely missing information.

The screenshot default controls new runs only and can be overridden with
`--retain-screenshots` or `--no-retain-screenshots`. Screen retention remains
off in the factory defaults.

This is not yet the planned deterministic consequential-action policy engine.
Such a policy must bind approval to the exact proposed action batch and verify
fresh phone state after approval, including broadcast and coordinated runs.
TapRig does not present a heuristic text-label filter as that guarantee.
