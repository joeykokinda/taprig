#!/usr/bin/env bash
# Drives a booted emulator through the TapRig daemon: enrollment, launch, notifications.
set -euo pipefail
export TAPRIG_DATA_DIR="${TAPRIG_DATA_DIR:-${RUNNER_TEMP:-/tmp}/taprig}"
export TAPRIG_DRIVER_DIR="${TAPRIG_DRIVER_DIR:-$PWD/android-driver/build/bundle}"
log="${RUNNER_TEMP:-/tmp}/daemon.log"
serial="${TAPRIG_SERIAL:-emulator-5554}"

node src/cli.ts daemon serve > "$log" 2>&1 &
daemon=$!
trap 'kill "$daemon" 2>/dev/null || true' EXIT

for _ in $(seq 1 90); do
  if node src/cli.ts doctor > "${RUNNER_TEMP:-/tmp}/doctor.txt" 2>&1; then break; fi
  sleep 2
done
cat "${RUNNER_TEMP:-/tmp}/doctor.txt"
grep -q "PASS  $serial" "${RUNNER_TEMP:-/tmp}/doctor.txt" || { cat "$log"; exit 1; }

node src/cli.ts execute "$serial" launch com.android.settings
sleep 3
adb -s "$serial" shell dumpsys window | grep -q "com.android.settings" || { cat "$log"; exit 1; }
node src/cli.ts execute "$serial" key home
node src/cli.ts notifications "$serial"
echo "emulator smoke passed on $serial"
