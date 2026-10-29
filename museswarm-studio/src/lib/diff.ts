export type DiffOp = { kind: "eq" | "add" | "del"; line: string };

export type DiffRow = {
  left: DiffOp | null;
  right: DiffOp | null;
};

/**
 * Line diff for the self-healing explorer.
 * ponytail: classic O(n*m) LCS. Past ~400 lines per side (n*m > 160k) it
 * falls back to a lookahead resync so a huge artifact can't freeze the tab.
 * Upgrade path: Myers with a hunk window if workspaces grow past that.
 */
export function diffLines(before: string, after: string): DiffOp[] {
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");
  if (a.length * b.length > 160_000) return resync(a, b);
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i];
    const next = dp[i + 1];
    const line = a[i];
    if (!row || !next || line === undefined) continue;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = line === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = a[i];
    const bj = b[j];
    if (ai === undefined || bj === undefined) break;
    if (ai === bj) {
      out.push({ kind: "eq", line: ai });
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      out.push({ kind: "del", line: ai });
      i++;
    } else {
      out.push({ kind: "add", line: bj });
      j++;
    }
  }
  while (i < n) {
    const line = a[i++];
    if (line !== undefined) out.push({ kind: "del", line });
  }
  while (j < m) {
    const line = b[j++];
    if (line !== undefined) out.push({ kind: "add", line });
  }
  return out;
}

function resync(a: string[], b: string[]): DiffOp[] {
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  const look = 12;
  while (i < a.length && j < b.length) {
    const ai = a[i];
    const bj = b[j];
    if (ai === undefined || bj === undefined) break;
    if (ai === bj) {
      out.push({ kind: "eq", line: ai });
      i++;
      j++;
      continue;
    }
    let found: "a" | "b" | null = null;
    let at = 0;
    for (let k = 1; k <= look; k++) {
      if (a[i + k] === bj) {
        found = "a";
        at = k;
        break;
      }
      if (b[j + k] === ai) {
        found = "b";
        at = k;
        break;
      }
    }
    if (found === "a") {
      for (let k = 0; k < at; k++) {
        const line = a[i++];
        if (line !== undefined) out.push({ kind: "del", line });
      }
    } else if (found === "b") {
      for (let k = 0; k < at; k++) {
        const line = b[j++];
        if (line !== undefined) out.push({ kind: "add", line });
      }
    } else {
      out.push({ kind: "del", line: ai });
      out.push({ kind: "add", line: bj });
      i++;
      j++;
    }
  }
  while (i < a.length) {
    const line = a[i++];
    if (line !== undefined) out.push({ kind: "del", line });
  }
  while (j < b.length) {
    const line = b[j++];
    if (line !== undefined) out.push({ kind: "add", line });
  }
  return out;
}

export function pairDiffRows(ops: DiffOp[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (!op) break;
    if (op.kind === "eq") {
      rows.push({ left: op, right: op });
      i++;
      continue;
    }
    const dels: DiffOp[] = [];
    const adds: DiffOp[] = [];
    while (i < ops.length && ops[i]?.kind !== "eq") {
      const cur = ops[i];
      if (!cur) break;
      if (cur.kind === "del") dels.push(cur);
      else adds.push(cur);
      i++;
    }
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    }
  }
  return rows;
}

export function unifiedDiff(path: string, before: string, after: string): string {
  const ops = diffLines(before, after);
  const lines = [
    `--- a/${path}\t(Pass 1 · REWORK)`,
    `+++ b/${path}\t(Pass 2 · VERIFIED_PASS)`,
  ];
  let oldNo = 1;
  let newNo = 1;
  for (const op of ops) {
    if (op.kind === "eq") {
      lines.push(` ${op.line}`);
      oldNo++;
      newNo++;
    } else if (op.kind === "del") {
      lines.push(`-${op.line}`);
      oldNo++;
    } else {
      lines.push(`+${op.line}`);
      newNo++;
    }
  }
  if (oldNo === 1 && newNo === 1 && ops.length === 0) lines.push("(empty)");
  return lines.join("\n");
}

export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === "add") added++;
    else if (op.kind === "del") removed++;
  }
  return { added, removed };
}

export function assertDiffSelfCheck(): void {
  const ops = diffLines("a\nb\nc", "a\nB\nc");
  const got = ops.map((o) => `${o.kind}:${o.line}`).join(",");
  if (got !== "eq:a,del:b,add:B,eq:c") {
    throw new Error(`diff self-check failed: ${got}`);
  }
  const same = diffLines("x", "x");
  const first = same[0];
  if (same.length !== 1 || !first || first.kind !== "eq") {
    throw new Error("diff identity failed");
  }
  const rows = pairDiffRows(ops);
  if (rows.length !== 3 || rows[1]?.left?.kind !== "del" || rows[1]?.right?.kind !== "add") {
    throw new Error("diff row pairing failed");
  }
}
