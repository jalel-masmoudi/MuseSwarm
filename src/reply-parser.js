'use strict';

// Tolerant parsing of LLM replies that are supposed to carry JSON (and often full file contents).
// Real Muse Spark replies wrap JSON in fences, prepend <think> blocks or prose, put raw newlines
// or `template literals` inside string values, and use several file-patch shapes.

const CONTENT_KEYS = ['content', 'code', 'source', 'text', 'contents', 'body', 'newContent', 'after'];
const PATH_KEYS = ['path', 'file', 'filename', 'fileName', 'name', 'filePath'];
const PATCH_KEYS = ['files', 'patch', 'patches', 'changes', 'edits', 'artifacts'];
const MESSAGE_KEYS = ['messageToVerifier', 'message', 'summary', 'explanation', 'rootCause'];

function stripThink(text) {
  let out = String(text || '');
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // An unterminated leading <think> (reply cut off mid-reasoning) hides everything after it.
  if (/<think>/i.test(out) && !/<\/think>/i.test(out)) out = out.replace(/<think>[\s\S]*$/i, '');
  return out.trim();
}

function fencedBlocks(text) {
  const blocks = [];
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) blocks.push({ info: m[1].trim(), body: m[2], index: m.index });
  return blocks;
}

// Scan for balanced top-level {...} spans, tracking "..." strings and `...` template literals.
function balancedObjects(text) {
  const spans = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === '`') quote = ch;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          spans.push(text.slice(start, i + 1));
          start = i;
          break;
        }
      }
    }
  }
  return spans;
}

// Make near-JSON parseable: escape raw control characters inside strings, convert `template`
// values to JSON strings, and drop trailing commas.
function repairJson(src) {
  let out = '';
  let quote = null;
  let escaped = false;
  let buf = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote === '"') {
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === '\\') {
        out += ch;
        escaped = true;
      } else if (ch === '"') {
        out += ch;
        quote = null;
      } else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (ch < ' ') out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
      else out += ch;
      continue;
    }
    if (quote === '`') {
      if (escaped) {
        buf += ch === '`' ? '`' : `\\${ch}`;
        escaped = false;
      } else if (ch === '\\') escaped = true;
      else if (ch === '`') {
        out += JSON.stringify(buf);
        buf = '';
        quote = null;
      } else buf += ch;
      continue;
    }
    if (ch === '"' || ch === '`') {
      quote = ch;
      if (ch === '"') out += ch;
      continue;
    }
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

function parseLooseJson(src) {
  const trimmed = String(src || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_) {}
  try {
    return JSON.parse(repairJson(trimmed));
  } catch (_) {}
  return null;
}

function jsonCandidates(text) {
  const clean = stripThink(text);
  const out = [];
  for (const block of fencedBlocks(clean)) {
    if (!block.info || /^(json|jsonc|json5)$/i.test(block.info)) out.push(block.body);
  }
  out.push(clean);
  out.push(...balancedObjects(clean));
  return out;
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

// Returns the first parseable JSON object in the reply (preferring ones that satisfy `prefer`).
function extractJson(text, prefer = null) {
  if (!text) return null;
  let first = null;
  for (const candidate of jsonCandidates(text)) {
    const parsed = parseLooseJson(candidate);
    if (!isPlainObject(parsed)) continue;
    if (!prefer || prefer(parsed)) return parsed;
    if (!first) first = parsed;
  }
  return first;
}

function normalizePath(raw, knownPaths) {
  if (typeof raw !== 'string') return null;
  let p = raw.trim().replace(/^['"`]|['"`]$/g, '').replace(/\\/g, '/');
  p = p.replace(/^.*\/workspaces\/[^/]+\//, '');
  p = p.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  if (!p || p.includes('..')) return null;
  const known = knownPaths || [];
  if (known.includes(p)) return p;
  const base = p.split('/').pop();
  const byBase = known.filter((k) => k.split('/').pop() === base);
  if (byBase.length === 1) return byBase[0];
  return null;
}

function contentOf(value) {
  if (typeof value === 'string') return value;
  if (!isPlainObject(value)) return null;
  for (const key of CONTENT_KEYS) if (typeof value[key] === 'string') return value[key];
  return null;
}

function pathOf(value) {
  if (!isPlainObject(value)) return null;
  for (const key of PATH_KEYS) if (typeof value[key] === 'string') return value[key];
  return null;
}

function collectFromShape(node, knownPaths, files) {
  if (Array.isArray(node)) {
    for (const item of node) {
      const p = normalizePath(pathOf(item), knownPaths);
      const c = contentOf(item);
      if (p && c !== null) files[p] = c;
    }
    return;
  }
  if (!isPlainObject(node)) return;
  const single = pathOf(node);
  if (single && contentOf(node) !== null) {
    const p = normalizePath(single, knownPaths);
    if (p) files[p] = contentOf(node);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    const p = normalizePath(key, knownPaths);
    const c = contentOf(value);
    if (p && c !== null) files[p] = c;
  }
}

function filesFromJson(obj, knownPaths) {
  const files = {};
  let shape = null;
  for (const key of PATCH_KEYS) {
    if (obj[key] === undefined) continue;
    collectFromShape(obj[key], knownPaths, files);
    if (Object.keys(files).length) {
      shape = Array.isArray(obj[key]) ? `json_${key}_array` : `json_${key}_object`;
      return { files, shape };
    }
  }
  collectFromShape(obj, knownPaths, files);
  if (Object.keys(files).length) shape = pathOf(obj) ? 'json_single_file' : 'json_path_keys';
  return { files, shape };
}

// Fallback for prose replies: ```js blocks labelled with a filename in the info string,
// on the line just before the fence, or in a leading `// file: x.js` comment.
function filesFromFences(text, knownPaths) {
  const files = {};
  const clean = stripThink(text);
  for (const block of fencedBlocks(clean)) {
    if (/^(json|jsonc|json5)$/i.test(block.info)) continue;
    const before = clean.slice(Math.max(0, block.index - 160), block.index).split('\n').filter(Boolean).pop() || '';
    const firstLine = block.body.split('\n')[0] || '';
    const hints = [
      ...block.info.split(/[\s:=]+/),
      ...(before.match(/[\w./\\-]+\.(?:js|html|md|json)/g) || []),
      ...(firstLine.match(/^\s*(?:\/\/|<!--|#)\s*(?:file(?:name)?:?\s*)?([\w./\\-]+\.(?:js|html|md|json))/i) || []).slice(1),
    ];
    for (const hint of hints) {
      const p = normalizePath(hint.replace(/^title=/, ''), knownPaths);
      if (p) {
        files[p] = block.body.replace(/\n$/, '');
        break;
      }
    }
  }
  return files;
}

function extractFilePatch(text, knownPaths) {
  const result = { files: {}, message: '', format: null, parsedJson: false };
  if (!text) return result;
  const isPatch = (o) => PATCH_KEYS.some((k) => o[k] !== undefined) || Boolean(pathOf(o));
  const obj = extractJson(text, isPatch);
  if (obj) {
    result.parsedJson = true;
    for (const key of MESSAGE_KEYS) {
      if (typeof obj[key] === 'string' && obj[key].trim()) {
        result.message = obj[key];
        break;
      }
    }
    const { files, shape } = filesFromJson(obj, knownPaths);
    if (Object.keys(files).length) {
      result.files = files;
      result.format = shape;
      return result;
    }
  }
  const fenced = filesFromFences(text, knownPaths);
  if (Object.keys(fenced).length) {
    result.files = fenced;
    result.format = 'fenced_code';
  }
  return result;
}

module.exports = {
  stripThink,
  repairJson,
  parseLooseJson,
  extractJson,
  extractFilePatch,
  normalizePath,
};
