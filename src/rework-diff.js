// ponytail: O(n*m) line LCS. Fine for workspace files under a few thousand lines; switch to Myers if artifacts grow past that.
function diffLineOps(beforeLines, afterLines) {
  const n = beforeLines.length;
  const m = afterLines.length;
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i];
    const next = dp[i + 1];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = beforeLines[i] === afterLines[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  let oldLine = 1;
  let newLine = 1;
  while (i < n && j < m) {
    if (beforeLines[i] === afterLines[j]) {
      ops.push({ t: ' ', line: beforeLines[i], oldLine, newLine });
      i += 1;
      j += 1;
      oldLine += 1;
      newLine += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: '-', line: beforeLines[i], oldLine, newLine: null });
      i += 1;
      oldLine += 1;
    } else {
      ops.push({ t: '+', line: afterLines[j], oldLine: null, newLine });
      j += 1;
      newLine += 1;
    }
  }
  while (i < n) {
    ops.push({ t: '-', line: beforeLines[i], oldLine, newLine: null });
    i += 1;
    oldLine += 1;
  }
  while (j < m) {
    ops.push({ t: '+', line: afterLines[j], oldLine: null, newLine });
    j += 1;
    newLine += 1;
  }
  return ops;
}

function formatUnifiedDiff(filePath, ops) {
  const context = 3;
  const keep = ops.map((op) => op.t !== ' ');
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].t === ' ') continue;
    const from = Math.max(0, i - context);
    const to = Math.min(ops.length - 1, i + context);
    for (let k = from; k <= to; k++) keep[k] = true;
  }

  const lines = [`--- a/${filePath}`, `+++ b/${filePath}`];
  let idx = 0;
  while (idx < ops.length) {
    if (!keep[idx]) {
      idx += 1;
      continue;
    }
    let end = idx;
    while (end < ops.length && keep[end]) end += 1;
    const hunk = ops.slice(idx, end);
    const oldStart = (hunk.find((op) => op.oldLine) || {}).oldLine || 1;
    const newStart = (hunk.find((op) => op.newLine) || {}).newLine || 1;
    const oldCount = hunk.filter((op) => op.t !== '+').length;
    const newCount = hunk.filter((op) => op.t !== '-').length;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of hunk) lines.push(op.t + op.line);
    idx = end;
  }
  return lines.join('\n');
}

function lineSnippet(lines, lineNo, radius = 3) {
  const center = Math.max(1, Number(lineNo) || 1);
  const start = Math.max(0, center - 1 - radius);
  const end = Math.min(lines.length, center + radius);
  return lines.slice(start, end).join('\n');
}

function buildReworkDiff({ filePath, before, after, author, source = 'unspecified', reworkAttempt }) {
  const beforeLines = String(before).replace(/\r\n/g, '\n').split('\n');
  const afterLines = String(after).replace(/\r\n/g, '\n').split('\n');
  const ops = diffLineOps(beforeLines, afterLines);
  const firstDel = ops.find((op) => op.t === '-');
  const firstAdd = ops.find((op) => op.t === '+');
  return {
    path: filePath,
    author,
    source,
    fixedBy: source === 'model' ? `${author} (Muse Spark reply)` : `engine (${source})`,
    verifiedPass: null,
    passFrom: 1,
    passTo: (reworkAttempt || 1) + 1,
    reworkAttempt: reworkAttempt || 1,
    diff: formatUnifiedDiff(filePath, ops),
    beforeSnippet: lineSnippet(beforeLines, firstDel ? firstDel.oldLine : 1),
    afterSnippet: lineSnippet(afterLines, firstAdd ? firstAdd.newLine : 1),
    timestamp: new Date().toISOString(),
  };
}

module.exports = { buildReworkDiff };
