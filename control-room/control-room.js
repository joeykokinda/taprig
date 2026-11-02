const $ = (selector) => document.querySelector(selector);
const leases = new Map();
let renderedDeviceIds = "";
let renderedQuestions = "";

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
        <span>${escapeHtml(run.mode).toUpperCase()}</span>
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

async function refresh() {
  try {
    const [{ devices }, { runs, telemetry }, { scripts }] = await Promise.all([
      json("/devices"),
      json("/runs"),
      json("/scripts"),
    ]);
    renderDevices(devices);
    renderScripts(scripts);
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
