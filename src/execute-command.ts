import type { Action } from "./core/contracts.ts";

export interface ExecuteCommand {
  serial: string;
  action: Action;
}

function integer(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!value || !Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

export function parseExecuteCommand(args: readonly string[]): ExecuteCommand {
  const [serial, operation, ...values] = args;
  if (!serial) throw new Error("execute requires a device serial");

  if (operation === "key") {
    const key = values[0];
    if (
      key !== "back" &&
      key !== "home" &&
      key !== "recents" &&
      key !== "enter" &&
      key !== "delete"
    ) {
      throw new Error("key must be back, home, recents, enter, or delete");
    }
    return { serial, action: { type: "key.press", key } };
  }
  if (operation === "tap") {
    return {
      serial,
      action: { type: "gesture.tap", x: integer(values[0], "x"), y: integer(values[1], "y") },
    };
  }
  if (operation === "swipe") {
    return {
      serial,
      action: {
        type: "gesture.swipe",
        from: { x: integer(values[0], "from x"), y: integer(values[1], "from y") },
        to: { x: integer(values[2], "to x"), y: integer(values[3], "to y") },
        durationMs: integer(values[4], "duration"),
      },
    };
  }
  if (operation === "launch") {
    const packageName = values[0];
    if (!packageName) throw new Error("launch requires an Android package name");
    return { serial, action: { type: "app.launch", packageName } };
  }

  throw new Error("execute operation must be key, tap, swipe, or launch");
}
