import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertDiffSelfCheck } from "./diff.ts";
// Preset module is plain CommonJS. The loop below asserts the live list shape.
// @ts-expect-error no declaration file beside src/scenarios.js
import { serializeScenarios } from "../../../src/scenarios.js";
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

const live = serializeScenarios();
if (LOCAL_SCENARIOS.length !== live.length) {
  throw new Error(`fallback has ${LOCAL_SCENARIOS.length} scenarios, live list has ${live.length}`);
}
for (let i = 0; i < live.length; i++) {
  const local = LOCAL_SCENARIOS[i];
  const preset = live[i];
  if (!local || !preset) throw new Error("missing scenario row");
  if (local.id !== preset.id || local.title !== preset.title) {
    throw new Error(`fallback ${local.id} does not match live ${preset.id}`);
  }
  if (local.brief !== preset.prompt) throw new Error(`${preset.id} brief drifted from the preset prompt`);
  if (local.description !== preset.pass1Fault.summary) {
    throw new Error(`${preset.id} fault description drifted`);
  }
  if (local.files["brief.md"] !== preset.artifacts["brief.md"]) {
    throw new Error(`${preset.id} brief.md drifted`);
  }
  runJs(local.files, true);
  if (!local.pass1?.[preset.pass1Fault.file]) throw new Error(`${preset.id} missing pass 1 fault`);
  runJs(filesForPass(local, 1), false);
  console.log("pass", preset.id);
}
console.log("studio self-check ok");
