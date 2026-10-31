import { join } from "node:path";
import { app, BrowserWindow, dialog, shell } from "electron";

import {
  daemonRequest,
  daemonStatus,
  startDaemonProcess,
  stopDaemonProcess,
} from "../src/daemon/lifecycle.ts";

let ownsDaemon = false;
let quitting = false;

async function openControlRoom(): Promise<void> {
  process.env.TAPRIG_DATA_DIR = app.getPath("userData");
  process.env.TAPRIG_CONTROL_ROOM = join(app.getAppPath(), "control-room");
  if (!(await daemonStatus())) {
    process.env.ELECTRON_RUN_AS_NODE = "1";
    await startDaemonProcess(join(app.getAppPath(), "dist/desktop/cli.js"));
    ownsDaemon = true;
  }
  const response = await daemonRequest("/browser-sessions", { method: "POST" });
  if (!response.ok) throw new Error(`TapRig daemon returned HTTP ${response.status}`);
  const { url } = (await response.json()) as { url: string };
  const trustedOrigin = new URL(url).origin;
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: "#080808",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url: destination }) => {
    if (destination.startsWith("https://")) void shell.openExternal(destination);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, destination) => {
    if (new URL(destination).origin !== trustedOrigin) event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());
  await window.loadURL(url);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => BrowserWindow.getAllWindows()[0]?.focus());
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void openControlRoom();
  });
  app.on("before-quit", (event) => {
    if (!ownsDaemon || quitting) return;
    event.preventDefault();
    quitting = true;
    void stopDaemonProcess().finally(() => app.quit());
  });
  app
    .whenReady()
    .then(openControlRoom)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox("TapRig could not start", message);
      app.quit();
    });
}
