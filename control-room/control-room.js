const $ = (selector) => document.querySelector(selector);
const leases = new Map();
let renderedDeviceIds = "";
let renderedQuestions = "";
let activityRunId = "";
let activitySequence = 0;
let activityEvents = [];

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function json(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (response.status === 204) return {};
  return response.json();
}

function renderDevices(devices) {
  $("#device-count").textContent = devices.length;
  $("#ready-count").textContent = devices.filter((device) => device.state === "ready").length;
  const ids = devices.map((device) => device.serial).join("|");
  if (ids === renderedDeviceIds) {
    for (const device of devices) {
      const card = document.querySelector(`[data-device="${CSS.escape(device.serial)}"]`);
      if (card) {
        card.querySelector("[data-state]").textContent = device.state.toUpperCase();
        card.querySelector("[data-package]").textContent =
          device.foregroundActivity?.packageName ?? "—";
      }
    }
    return;
  }
  renderedDeviceIds = ids;
  $("#group-form").elements.deviceIds.innerHTML = devices
    .map(
      (device) =>
        `<option value="${escapeHtml(device.serial)}">${escapeHtml(device.identity?.model ?? device.serial)} · ${escapeHtml(device.serial)}</option>`,
    )
    .join("");
  $("#devices").innerHTML = devices.length
    ? devices
        .map(
          (device) => `
      <article class="device" data-device="${escapeHtml(device.serial)}">
        <div class="device-line"><span>${escapeHtml(device.identity?.model ?? device.serial)}</span><b data-state>${escapeHtml(device.state).toUpperCase()}</b></div>
        <div class="phone"><img draggable="false" alt="Live screen for ${escapeHtml(device.serial)}" src="/devices/${encodeURIComponent(device.serial)}/stream.mjpeg" /></div>
        <div class="device-line"><span>${escapeHtml(device.serial)}</span><span data-package>${escapeHtml(device.foregroundActivity?.packageName ?? "—")}</span></div>
        <div class="manual-controls">
          <button data-action="takeover">TAKE CONTROL</button>
          <button data-action="back">BACK</button>
          <button data-action="home">HOME</button>
        </div>
      </article>`,
        )
        .join("")
    : '<p class="empty">NO DEVICES CONNECTED</p>';
}

async function manualRequest(deviceId, body) {
  const response = await json(`/devices/${encodeURIComponent(deviceId)}/manual-actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  leases.set(deviceId, response.lease);
}

$("#devices").addEventListener("click", async (event) => {
  const card = event.target.closest("[data-device]");
  if (!card) return;
  const deviceId = card.dataset.device;
  const button = event.target.closest("button");
  const action = button?.dataset.action;
  try {
    if (action === "takeover") {
      const current = leases.get(deviceId);
      if (current) {
        await json(`/devices/${encodeURIComponent(deviceId)}/takeover`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ leaseId: current.id }),
        });
        leases.delete(deviceId);
        button.textContent = "TAKE CONTROL";
      } else {
        const { lease } = await json(`/devices/${encodeURIComponent(deviceId)}/takeover`, {
          method: "POST",
        });
        leases.set(deviceId, lease);
        button.textContent = "RELEASE CONTROL";
      }
      return;
    }
    const lease = leases.get(deviceId);
    if (!lease) throw new Error("take control first");
    if (action === "back" || action === "home") {
      await manualRequest(deviceId, { leaseId: lease.id, type: "key", key: action });
      return;
    }
    if (event.target.matches(".phone img")) {
      const bounds = event.target.getBoundingClientRect();
      await manualRequest(deviceId, {
        leaseId: lease.id,
        type: "tap",
        xRatio: (event.clientX - bounds.left) / bounds.width,
        yRatio: (event.clientY - bounds.top) / bounds.height,
      });
    }
  } catch (error) {
    $("#task-result").textContent = `CONTROL: ${error.message}`;
    leases.delete(deviceId);
    if (button && action === "takeover") button.textContent = "TAKE CONTROL";
  }
});

function renderRuns(runs, telemetry) {
  const active = runs.filter((run) => !["completed", "failed", "stopped"].includes(run.status));
  $("#run-count").textContent = active.length;
  $("#runs").innerHTML = runs.length
    ? runs
        .slice(0, 20)
        .map((run) => {
          const metrics = telemetry.get(run.id);
          return `
      <article class="trace-row">
        <time>${escapeHtml(new Date(run.updatedAt).toLocaleTimeString())}</time>
        <span>${escapeHtml(`${run.mode}${run.affinity?.group ? ` / ${run.affinity.group}` : run.affinity ? ` / ${run.affinity.deviceIds.length} DEVICES` : ""}`).toUpperCase()}</span>
        <strong>${escapeHtml(run.status).toUpperCase()}</strong>
        <p title="${escapeHtml(run.task)}">${escapeHtml(run.task)}</p>
        ${
          metrics
            ? `<small>${metrics.modelCalls} MODEL / ${metrics.inputTokens + metrics.outputTokens} TOKENS / ${metrics.attemptedActions} ACTIONS / ${Math.round(metrics.elapsedMs)}MS</small>`
            : ""
        }
      </article>`;
        })
        .join("")
    : '<p class="empty">NO RUNS YET</p>';
}

function activityLabel(event) {
  if (event.type !== "run.trace") return event.type.replace("run.", "").toUpperCase();
  const trace = event.trace;
  if (trace.phase === "observation") {
    return `OBSERVE · ${trace.deviceId} · ${trace.foregroundPackage ?? "UNKNOWN"}`;
  }
  if (trace.phase === "decision") {
    return `DECIDE · ${trace.deviceId} · ${trace.decisionType.toUpperCase()} · ${trace.actionCount} ACTIONS`;
  }
  return `ACT · ${trace.deviceId} · ${trace.steps.map((step) => `${step.actionType}:${step.status}`).join(" · ")}`;
}

async function refreshActivity(runs) {
  const active = runs.find((run) => !["completed", "failed", "stopped"].includes(run.status));
  const selected = active ?? runs[0];
  if (!selected) {
    activityRunId = "";
    activitySequence = 0;
    activityEvents = [];
  } else {
    if (selected.id !== activityRunId) {
      activityRunId = selected.id;
      activitySequence = 0;
      activityEvents = [];
    }
    const { events } = await json(
      `/runs/${encodeURIComponent(activityRunId)}/events?after=${activitySequence}`,
    );
    if (events.length) activitySequence = events.at(-1).sequence;
    activityEvents = [...activityEvents, ...events].slice(-100);
  }
  $("#activity-run").textContent = activityRunId || "NO RUN";
  $("#activity").innerHTML = activityEvents.length
    ? activityEvents
        .map(
          ({ sequence, event }) => `
      <div class="activity-row"><b>${sequence}</b><time>${event.at ? escapeHtml(new Date(event.at).toLocaleTimeString()) : "CREATED"}</time><span>${escapeHtml(activityLabel(event))}</span></div>`,
        )
        .join("")
    : '<p class="empty">NO ACTIVITY YET</p>';
}

function renderScripts(scripts) {
  $("#script-count").textContent = scripts.length;
  $("#scripts").innerHTML = scripts.length
    ? scripts
        .map(
          (script) => `
      <article class="script-row"><span>${escapeHtml(script.name)}</span><b>${escapeHtml(script.id)} / V${script.version}</b></article>`,
        )
        .join("")
    : '<p class="empty">NO SCRIPTS YET</p>';
}

function renderGroups(groups) {
  const selected = $("#run-group").value;
  $("#run-group").innerHTML = [
    '<option value="">ALL READY DEVICES</option>',
    ...groups.map(
      (group) =>
        `<option value="${escapeHtml(group.name)}">${escapeHtml(group.name.toUpperCase())} · ${group.deviceIds.length}</option>`,
    ),
  ].join("");
  if (groups.some((group) => group.name === selected)) $("#run-group").value = selected;
  $("#groups").innerHTML = groups.length
    ? groups
        .map(
          (group) => `
      <article class="group-row" data-group="${escapeHtml(group.name)}">
        <span>${escapeHtml(group.name)}</span>
        <small>${group.deviceIds.map(escapeHtml).join(" · ")}</small>
        <button type="button" data-action="delete-group">DELETE</button>
      </article>`,
        )
        .join("")
    : '<p class="empty">NO DEVICE GROUPS</p>';
}

function renderQuestions(questions) {
  const signature = questions.map(({ runId, id, prompt }) => `${runId}:${id}:${prompt}`).join("|");
  if (signature === renderedQuestions) return;
  renderedQuestions = signature;
  $("#questions").innerHTML = questions.length
    ? questions
        .map(
          ({ runId, id, prompt }) => `
      <form class="question-row" data-run-id="${escapeHtml(runId)}" data-question-id="${escapeHtml(id)}">
        <p>${escapeHtml(prompt)}</p>
        <input name="answer" required maxlength="10000" autocomplete="off" aria-label="Answer" />
        <label class="sensitive-answer"><input name="sensitive" type="checkbox" /> SENSITIVE — DO NOT SAVE</label>
        <button type="submit">ANSWER + RESUME →</button>
      </form>`,
        )
        .join("")
    : '<p class="empty">NO OPEN QUESTIONS</p>';
}

function renderSetup(setup) {
  const steps = [
    [true, "LOCAL DAEMON", "ONLINE"],
    [
      setup.devices.total > 0,
      "PHONE CONNECTED",
      setup.devices.total ? `${setup.devices.total} DETECTED` : "CONNECT USB + ENABLE DEBUGGING",
    ],
    [
      setup.devices.ready > 0,
      "PHONE READY",
      setup.devices.ready ? `${setup.devices.ready} READY` : "UNLOCK + ACCEPT TRUST PROMPT",
    ],
    [
      setup.agentConfigured,
      "AGENT CONFIGURED",
      setup.agentConfigured
        ? `${setup.modelProfile ?? "DEFAULT"} PROFILE`
        : `SET ${setup.modelKeyEnv ?? "PROVIDER API KEY"} + RESTART`,
    ],
    [setup.hasRuns, "FIRST RUN", setup.hasRuns ? "CREATED" : "TRY “OPEN SETTINGS” ABOVE"],
  ];
  $("#setup-state").textContent = setup.status === "ready" ? "SYSTEM READY" : "ACTION NEEDED";
  $("#setup-state").className = setup.status === "ready" ? "ready" : "";
  $("#setup-steps").innerHTML = steps
    .map(
      ([complete, label, detail], index) => `
      <li class="${complete ? "complete" : ""}"><b>${String(index + 1).padStart(2, "0")}</b><span>${escapeHtml(label)}</span><em>${escapeHtml(detail)}</em></li>`,
    )
    .join("");
}

async function refresh() {
  try {
    const [{ devices }, { runs, telemetry }, { scripts }, { groups }, setup] = await Promise.all([
      json("/devices"),
      json("/runs"),
      json("/scripts"),
      json("/device-groups"),
      json("/setup"),
    ]);
    renderSetup(setup);
    renderDevices(devices);
    renderScripts(scripts);
    renderGroups(groups);
    const questionGroups = await Promise.all(
      runs
        .filter((run) => run.status === "waiting-for-user")
        .map((run) =>
          json(`/runs/${encodeURIComponent(run.id)}/questions`).then(({ questions }) =>
            questions.map((question) => ({ ...question, runId: run.id })),
          ),
        ),
    );
    renderRuns(runs, new Map(Object.entries(telemetry)));
    await refreshActivity(runs);
    renderQuestions(questionGroups.flat().filter((question) => question.status === "open"));
    $("#connection").textContent = "LOCAL DAEMON / ONLINE";
  } catch {
    $("#connection").textContent = "LOCAL DAEMON / OFFLINE";
  }
}

$("#task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const task = $("#task").value.trim();
  if (!task) return;
  $("#task-result").textContent = "CREATING RUN…";
  try {
    const maxModelCalls = $("#max-model-calls").valueAsNumber;
    const maxActions = $("#max-actions").valueAsNumber;
    const budget = {
      ...(Number.isNaN(maxModelCalls) ? {} : { maxModelCalls }),
      ...(Number.isNaN(maxActions) ? {} : { maxActions }),
    };
    const { run } = await json("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task,
        mode: $("#mode").value,
        ...($("#run-group").value ? { group: $("#run-group").value } : {}),
        ...(Object.keys(budget).length > 0 ? { budget } : {}),
      }),
    });
    $("#task-result").textContent = `CREATED ${run.id}`;
    $("#task").value = "";
    await refresh();
  } catch (error) {
    $("#task-result").textContent = `FAILED: ${error.message}`;
  }
});

$("#group-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const name = form.elements.name.value.trim();
  const deviceIds = [...form.elements.deviceIds.selectedOptions].map((option) => option.value);
  try {
    await json(`/device-groups/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceIds }),
    });
    form.reset();
    $("#task-result").textContent = `SAVED GROUP ${name}`;
    await refresh();
  } catch (error) {
    $("#task-result").textContent = `GROUP FAILED: ${error.message}`;
  }
});

$("#groups").addEventListener("click", async (event) => {
  const row = event.target.closest("[data-group]");
  if (!row || event.target.dataset.action !== "delete-group") return;
  try {
    await json(`/device-groups/${encodeURIComponent(row.dataset.group)}`, { method: "DELETE" });
    $("#task-result").textContent = `DELETED GROUP ${row.dataset.group}`;
    await refresh();
  } catch (error) {
    $("#task-result").textContent = `GROUP DELETE FAILED: ${error.message}`;
  }
});

$("#questions").addEventListener("change", (event) => {
  if (event.target.name !== "sensitive") return;
  event.target.form.elements.answer.type = event.target.checked ? "password" : "text";
});

$("#questions").addEventListener("submit", async (event) => {
  const form = event.target.closest(".question-row");
  if (!form) return;
  event.preventDefault();
  try {
    await json(
      `/runs/${encodeURIComponent(form.dataset.runId)}/questions/${encodeURIComponent(form.dataset.questionId)}/answer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          answer: form.elements.answer.value,
          sensitive: form.elements.sensitive.checked,
        }),
      },
    );
    $("#task-result").textContent = `ANSWERED ${form.dataset.questionId}`;
    await refresh();
  } catch (error) {
    $("#task-result").textContent = `ANSWER FAILED: ${error.message}`;
  }
});

setInterval(() => {
  $("#clock").textContent = new Date().toLocaleTimeString([], { hour12: false });
}, 1000);
setInterval(refresh, 1000);
refresh();
