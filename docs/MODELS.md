# Model configuration and routing

TapRig separates model roles from provider/model IDs. The checked-in defaults
follow the current OpenAI catalog, but every target is editable in the private
OS application-data file `models.json`.

| Profile  | Fast        | Strong      | Vision        | Escalation budget               |
| -------- | ----------- | ----------- | ------------- | ------------------------------- |
| Economy  | GPT-6 Luna  | disabled    | disabled      | zero strong/vision calls        |
| Balanced | GPT-6 Luna  | GPT-6.1 Sol | GPT-6.1 Terra | three calls per escalated role  |
| Best     | GPT-6 Astra | GPT-6 Astra | GPT-6 Astra   | twenty calls per escalated role |

The model names reflect OpenAI's current guidance: Luna is the efficient
high-volume model, Sol balances capability and cost, Terra targets visual and
computer-use reasoning, and Astra is the most capable general model. See the
[official model catalog](https://developers.openai.com/api/docs/models).

```console
taprig model show
taprig model profile economy
taprig model set balanced fast my-provider-model-id
```

Provider credentials are referenced by environment-variable name. They are not
stored in `models.json`, SQLite, run events, prompts, or logs. The OpenAI adapter
uses the Responses API with strict JSON Schema output as documented in
[Structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

Routing is deterministic and budgeted. `fast` handles ordinary semantic
decisions, `strong` is available only for explicit escalation, and `vision` is
available only when semantic/local perception is insufficient. A route returns
no model when its budget is exhausted; callers must recover, ask, or fail rather
than silently spend through the limit.
