const $ = (selector) => document.querySelector(selector);

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
  $("#devices").innerHTML = devices.length
    ? devices
        .map(
          (device) => `
      <article class="device">
        <div class="device-line"><span>${escapeHtml(device.identity?.model ?? device.serial)}</span><b>${escapeHtml(device.state).toUpperCase()}</b></div>
        <div class="phone">LIVE VIEW<br/>PENDING</div>
        <div class="device-line"><span>${escapeHtml(device.serial)}</span><span>${escapeHtml(device.foregroundActivity?.packageName ?? "—")}</span></div>
      </article>`,
        )
        .join("")
    : '<p class="empty">NO DEVICES CONNECTED</p>';
}

function renderRuns(runs) {
  const active = runs.filter((run) => !["completed", "failed", "stopped"].includes(run.status));
  $("#run-count").textContent = active.length;
  $("#runs").innerHTML = runs.length
    ? runs
        .slice(0, 20)
        .map(
          (run) => `
      <article class="trace-row">
        <time>${escapeHtml(new Date(run.updatedAt).toLocaleTimeString())}</time>
        <strong>${escapeHtml(run.status).toUpperCase()}</strong>
        <p title="${escapeHtml(run.task)}">${escapeHtml(run.task)}</p>
      </article>`,
        )
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

async function refresh() {
  try {
    const [{ devices }, { runs }, { scripts }] = await Promise.all([
      json("/devices"),
      json("/runs"),
      json("/scripts"),
    ]);
    renderDevices(devices);
    renderRuns(runs);
    renderScripts(scripts);
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
    const { run } = await json("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task, mode: $("#mode").value }),
    });
    $("#task-result").textContent = `CREATED ${run.id}`;
    $("#task").value = "";
    await refresh();
  } catch (error) {
    $("#task-result").textContent = `FAILED: ${error.message}`;
  }
});

setInterval(() => {
  $("#clock").textContent = new Date().toLocaleTimeString([], { hour12: false });
}, 1000);
setInterval(refresh, 1000);
refresh();
