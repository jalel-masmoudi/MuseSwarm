import { diffLines } from "./diff.ts";

export type ReworkFileDiff = {
  path: string;
  pass1?: string;
  pass2?: string;
  unified?: string;
};

const PASS1_KEYS = ["pass1", "before", "from", "old", "a", "broken", "rework", "left"];
const PASS2_KEYS = ["pass2", "after", "to", "new", "b", "fixed", "verified", "right"];
const UNIFIED_KEYS = ["unified", "diff", "patch", "unifiedDiff"];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pickStr(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function filePath(obj: Record<string, unknown>, fallback: string): string {
  const path = pickStr(obj, ["path", "file", "name", "filename"]);
  return path || fallback;
}

function contentOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return null;
  return pickStr(rec, ["content", "text", "body", "source", "code"]) ?? null;
}

export function collectFiles(...sources: unknown[]): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (node: unknown, keyHint?: string) => {
    if (!node) return;
    if (typeof node === "string") {
      if (keyHint) out[keyHint] = node;
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const rec = asRecord(node);
    if (!rec) return;
    const nested = rec["files"] ?? rec["artifacts"] ?? rec["artifactFiles"];
    const own = contentOf(rec);
    const hinted = filePath(rec, keyHint || "");
    if (own !== null && hinted) out[hinted] = own;
    if (nested && nested !== node) visit(nested);
    for (const [key, value] of Object.entries(rec)) {
      if (key === "files" || key === "artifacts" || key === "artifactFiles") continue;
      if (typeof value === "string" && key.includes(".")) out[key] = value;
      else if (asRecord(value) && contentOf(value) !== null) visit(value, key);
    }
  };
  for (const source of sources) visit(source);
  return out;
}

function oneDiff(entry: unknown, fallbackPath: string): ReworkFileDiff | null {
  if (typeof entry === "string" && fallbackPath) {
    return { path: fallbackPath, unified: entry };
  }
  const rec = asRecord(entry);
  if (!rec) return null;
  const path = filePath(rec, fallbackPath);
  if (!path) return null;
  const pass1 = pickStr(rec, PASS1_KEYS);
  const pass2 = pickStr(rec, PASS2_KEYS);
  const unified = pickStr(rec, UNIFIED_KEYS);
  if (pass1 === undefined && pass2 === undefined && unified === undefined) return null;
  const diff: ReworkFileDiff = { path };
  if (pass1 !== undefined) diff.pass1 = pass1;
  if (pass2 !== undefined) diff.pass2 = pass2;
  if (unified !== undefined) diff.unified = unified;
  return diff;
}

export function parseReworkDiffs(raw: unknown): ReworkFileDiff[] {
  if (!raw) return [];
  const list: unknown[] = [];
  if (Array.isArray(raw)) {
    list.push(...raw);
  } else {
    const rec = asRecord(raw);
    if (!rec) return [];
    const nested = rec["diffs"] ?? rec["reworkDiffs"] ?? rec["files"] ?? rec["patches"];
    const nestedRec = asRecord(nested);
    if (Array.isArray(nested)) list.push(...nested);
    else if (nestedRec) {
      for (const [path, value] of Object.entries(nestedRec)) list.push(wrap(path, value));
    } else {
      for (const [path, value] of Object.entries(rec)) {
        if (path === "ok" || path === "sessionId" || path === "id" || path === "source") continue;
        list.push(wrap(path, value));
      }
    }
  }
  const diffs: ReworkFileDiff[] = [];
  for (const entry of list) {
    const rec = asRecord(entry);
    const diff = oneDiff(entry, rec ? filePath(rec, "") : "");
    if (diff) diffs.push(diff);
  }
  return diffs;
}

function wrap(path: string, value: unknown): unknown {
  if (typeof value === "string") return { path, unified: value };
  const rec = asRecord(value);
  if (!rec) return null;
  return { path, ...rec };
}

export function diffsFromSnapshots(
  pass1: Record<string, string>,
  pass2: Record<string, string>,
): ReworkFileDiff[] {
  const paths = [...new Set([...Object.keys(pass1), ...Object.keys(pass2)])].sort();
  const diffs: ReworkFileDiff[] = [];
  for (const path of paths) {
    const before = pass1[path] ?? "";
    const after = pass2[path] ?? "";
    if (before === after) continue;
    diffs.push({ path, pass1: before, pass2: after });
  }
  return diffs;
}

export function diffChanged(diff: ReworkFileDiff): boolean {
  if (diff.pass1 !== undefined && diff.pass2 !== undefined) return diff.pass1 !== diff.pass2;
  return Boolean(diff.unified && diff.unified.trim());
}

export function materializeUnified(diff: ReworkFileDiff): string {
  if (diff.unified && diff.unified.trim()) return diff.unified;
  return "";
}

export function hasLineDiff(diff: ReworkFileDiff): boolean {
  return diff.pass1 !== undefined && diff.pass2 !== undefined;
}

export function assertWorkspaceSelfCheck(): void {
  const files = collectFiles(
    [{ path: "brief.md", content: "# Brief" }],
    { "solution.js": "module.exports = {};" },
    { artifacts: { "test.js": { content: "assert.ok(1)" } } },
  );
  if (files["brief.md"] !== "# Brief" || files["solution.js"] !== "module.exports = {};") {
    throw new Error("collectFiles map/array failed");
  }
  if (files["test.js"] !== "assert.ok(1)") throw new Error("collectFiles artifacts failed");

  const parsed = parseReworkDiffs({
    diffs: [{ file: "solution.js", before: "seen", after: "left" }],
  });
  const first = parsed[0];
  if (!first || first.path !== "solution.js" || first.pass1 !== "seen" || first.pass2 !== "left") {
    throw new Error("parseReworkDiffs failed");
  }
  const fromMap = parseReworkDiffs({ "app.js": { pass1: "a", pass2: "b" } });
  if (fromMap[0]?.path !== "app.js" || fromMap[0]?.pass2 !== "b") {
    throw new Error("parseReworkDiffs map failed");
  }
  const snaps = diffsFromSnapshots({ "a.js": "1\n2" }, { "a.js": "1\n3" });
  const ops = diffLines(snaps[0]?.pass1 ?? "", snaps[0]?.pass2 ?? "");
  if (!ops.some((op) => op.kind === "add" && op.line === "3")) {
    throw new Error("snapshot diff failed");
  }
}
