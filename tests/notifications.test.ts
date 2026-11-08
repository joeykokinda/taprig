import assert from "node:assert/strict";
import test from "node:test";

import { parseNotificationDump } from "../src/android/notifications.ts";

const dump = `
    NotificationRecord(0x0991d564: pkg=android user=UserHandle{-1} id=2147483647 tag=ranker_group importance=4 key=x: Notification(groupKey=ranker_group vis=PRIVATE))
      key=-1|android|2147483647|ranker_group|1000|ranker_group
            when=1794068051511
    NotificationRecord(0x0c52c482: pkg=android user=UserHandle{-1} id=26 tag=null importance=4 key=y: Notification(channel=DEVELOPER_IMPORTANT))
            when=0
                android.title=String (USB debugging connected)
                android.text=String (Tap to turn off USB debugging)
    NotificationRecord(0x0069f9ef: pkg=com.google.android.apps.messaging user=UserHandle{0} id=777 tag=null importance=4 key=z: Notification(channel=Messages))
            when=1794068396440
                android.title=String (Mom)
                android.text=String (Call me when you land)
                android.bigText=String (Call me when you land, love you)
`;

test("parses the notification shade newest first and skips group summaries", () => {
  assert.deepEqual(parseNotificationDump(dump), [
    {
      package: "com.google.android.apps.messaging",
      title: "Mom",
      text: "Call me when you land, love you",
      postedAt: "2026-11-07T16:19:56.440Z",
    },
    { package: "android", title: "USB debugging connected", text: "Tap to turn off USB debugging" },
  ]);
});
