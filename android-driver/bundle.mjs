// Copies the release APKs into build/bundle with the manifest the TapRig host verifies before install.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dirname;
const output = join(root, "build", "bundle");
mkdirSync(output, { recursive: true });
const manifest = { protocolVersion: 1 };
for (const [key, file] of [
  ["stub", "stub/build/outputs/apk/release/stub-release.apk"],
  ["driver", "driver/build/outputs/apk/release/driver-release.apk"],
]) {
  const name = `taprig-${key}.apk`;
  copyFileSync(join(root, file), join(output, name));
  manifest[key] = {
    file: name,
    sha256: createHash("sha256")
      .update(readFileSync(join(output, name)))
      .digest("hex"),
  };
}
writeFileSync(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(output);
