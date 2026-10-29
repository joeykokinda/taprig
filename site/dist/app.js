const deviceButtons = document.querySelectorAll(".device");
const selectedDevice = document.querySelector("#selected-device");
const runDemo = document.querySelector("#run-demo");
const trace = document.querySelector("#trace");
const elapsed = document.querySelector("#elapsed");

for (const button of deviceButtons) {
  button.addEventListener("click", () => {
    for (const candidate of deviceButtons) candidate.classList.remove("active");
    button.classList.add("active");
    selectedDevice.textContent = `${button.dataset.device} · ${button.dataset.state}`;
  });
}

const demoSteps = [
  ["00:00.000", "ORCHESTRATOR", "Compiled prerequisites and completion condition"],
  ["00:00.018", "DEVICE ACTOR", "USB transport, boot, keyguard, and internet ready"],
  ["00:00.074", "EXECUTOR", "Launched com.android.settings"],
  ["00:00.421", "OBSERVER", "Settings foreground confirmed"],
  ["00:00.604", "EXECUTOR", "Opened Network & internet"],
  ["00:00.881", "VERIFIER", "Wi-Fi connected; returned Home; task complete"],
];

runDemo.addEventListener("click", async () => {
  runDemo.disabled = true;
  runDemo.textContent = "RUNNING…";
  trace.replaceChildren();

  for (const [index, [time, actor, message]] of demoSteps.entries()) {
    const item = document.createElement("li");
    item.className = "active";
    item.innerHTML = `<time>${time}</time><span>${actor}</span><p>${message}</p>`;
    trace.append(item);
    elapsed.textContent = `${Number(time.slice(3)).toFixed(2)}S`;
    await new Promise((resolve) => setTimeout(resolve, index === 0 ? 150 : 430));
    item.className = "done";
  }

  runDemo.textContent = "RUN AGAIN →";
  runDemo.disabled = false;
});
