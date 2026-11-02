# Approvals

TapRig has typed, durable approvals distinct from questions. A question supplies
missing information; an approval authorizes one consequential next action.

When a task explicitly asks TapRig to confirm before acting, the phone model can
return `request_approval` instead of an action batch. The executor receives no
phone actions from that decision. TapRig persists the request, releases the
device lease, moves the run to `waiting-for-user`, and emits an
`approval.requested` event.

Approve or deny from any client:

```console
taprig attach <run-id>
taprig approve <run-id> <approval-id>
taprig deny <run-id> <approval-id>
```

Approval emits `approval.resolved` and resumes on the same phone or broadcast
cohort. Denial emits the same resolution event and stops the run without
executing the gated action. The control room and `taprig_approval` MCP tool call
the same authenticated daemon endpoint.

TapRig currently defaults to autonomous execution so unattended phone farms do
not acquire surprise blockers. Approval requests are model-selected only when
the task explicitly requires confirmation. A configurable deterministic policy
engine—for example, always confirm purchases, sends, deletes, or account
changes—remains part of the open settings workspace and is not claimed here.
