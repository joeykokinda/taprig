import { type AdbOutputRunner, runAdbOutput } from "./raw-actions.ts";

export interface PhoneNotification {
  package: string;
  title: string;
  text: string;
  /** ISO time when the app posted it; undefined when Android reports none. */
  postedAt?: string;
}

/**
 * Reads the notification shade from `dumpsys notification --noredact`. Group summaries and
 * records without a title are skipped; newest first.
 */
export function parseNotificationDump(dump: string): PhoneNotification[] {
  const notifications: Array<PhoneNotification & { when: number }> = [];
  let current: (PhoneNotification & { when: number }) | undefined;
  const flush = () => {
    if (current?.title) notifications.push(current);
    current = undefined;
  };
  for (const raw of dump.split(/\r?\n/u)) {
    const line = raw.trim();
    const record = /^NotificationRecord\(.*?\bpkg=([\w.]+)/u.exec(line);
    if (record?.[1]) {
      flush();
      current = { package: record[1], title: "", text: "", when: 0 };
      continue;
    }
    if (!current) continue;
    const when = /^when=(\d+)/u.exec(line);
    if (when?.[1]) current.when = Number(when[1]);
    const field = /^android\.(title|text|bigText)=String \((.*)\)$/u.exec(line);
    if (field?.[1] === "title") current.title = field[2] ?? "";
    else if (field?.[1] === "text" && !current.text) current.text = field[2] ?? "";
    else if (field?.[1] === "bigText" && field[2]) current.text = field[2];
  }
  flush();
  return notifications
    .sort((left, right) => right.when - left.when)
    .map(({ when, ...notification }) => ({
      ...notification,
      ...(when > 0 ? { postedAt: new Date(when).toISOString() } : {}),
    }));
}

export async function listNotifications(
  serial: string,
  output: AdbOutputRunner = runAdbOutput,
): Promise<PhoneNotification[]> {
  return parseNotificationDump(await output(serial, ["dumpsys", "notification", "--noredact"]));
}
