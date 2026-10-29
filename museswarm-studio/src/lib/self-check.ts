import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertDiffSelfCheck } from "./diff.ts";
import { LOCAL_SCENARIOS, filesForPass } from "./scenarios.ts";
import { assertWorkspaceSelfCheck } from "./workspace.ts";

function runJs(files: Record<string, string>, expectPass: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-scenario-"));
  for (const [name, body] of Object.entries(files)) {
    if (!name.endsWith(".js")) continue;
    const dest = path.join(dir, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
  }
  for (const name of Object.keys(files)) {
    if (name.endsWith(".js")) execSync(`node --check ${JSON.stringify(name)}`, { cwd: dir });
  }
  let failed = false;
  try {
    execSync("node test.js", { cwd: dir, stdio: "pipe" });
  } catch {
    failed = true;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (failed === expectPass) {
    throw new Error(`node test.js expected pass=${expectPass} but failed=${failed}`);
  }
}

assertDiffSelfCheck();
assertWorkspaceSelfCheck();

for (const scenario of LOCAL_SCENARIOS) {
  runJs(scenario.files, true);
  console.log("pass", scenario.id);
}

const heal = LOCAL_SCENARIOS.find((s) => s.id === "self-heal-bugfix");
if (!heal?.pass1) throw new Error("self-heal scenario missing pass 1");
runJs(filesForPass(heal, 1), false);
console.log("pass self-heal pass1 fails as expected");
console.log("studio self-check ok");
