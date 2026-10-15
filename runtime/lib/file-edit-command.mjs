// The `slice` and `patch` subcommands.
//
// Both commands read tracked text files by line and apply declarative edit
// operations; nothing here executes a command or writes outside the requested file.
//
// Extracted verbatim from `runtime/commands/run.mjs` so that file keeps only
// argument parsing, dispatch and output selection. Behaviour, field names and
// exit codes are unchanged; only the module boundary moved.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { boundedOutput, normalizePath } from './cli-output.mjs';
import { SCHEMA_VERSION } from './cli-runtime.mjs';

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}
function splitLines(text) {
  const hadTrailingNewline = text.endsWith('\n');
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (hadTrailingNewline) lines.pop();
  return { hadTrailingNewline, lines };
}
export async function sliceReport(projectDir, args) {
  if (!args.file) return { schemaVersion: SCHEMA_VERSION, command: 'slice', status: 'failed', error: 'slice needs --file <path>' };
  const file = path.resolve(projectDir, args.file);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    return { schemaVersion: SCHEMA_VERSION, command: 'slice', status: 'failed', error: `cannot read ${normalizePath(args.file)}: ${error.code ?? error.message}` };
  }
  const { lines } = splitLines(raw);
  const from = args.from ?? 1;
  const to = args.to ?? lines.length;
  if (!Number.isInteger(from) || from < 1 || to < from || from > lines.length + 1) {
    return { schemaVersion: SCHEMA_VERSION, command: 'slice', status: 'failed', error: `range ${from}-${to} is outside 1-${lines.length}` };
  }
  const numbered = args.numbers !== false;
  const width = String(Math.min(to, lines.length)).length;
  const selected = [];
  for (let index = from; index <= Math.min(to, lines.length); index += 1) {
    const line = lines[index - 1];
    selected.push(numbered ? `${String(index).padStart(width, ' ')} | ${line}` : line);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'slice',
    status: 'ready',
    eol: detectEol(raw) === '\r\n' ? 'crlf' : 'lf',
    file: normalizePath(path.relative(projectDir, file) || args.file),
    from,
    lines: selected,
    numbered,
    text: selected.join('\n'),
    to: Math.min(to, lines.length),
    totalLines: lines.length,
  };
}
function applyPatchOps(lines, ops, specDir) {
  const applied = [];
  let current = [...lines];
  let previousStart = Number.POSITIVE_INFINITY;
  for (const [index, op] of ops.entries()) {
    if (!op || typeof op !== 'object') throw Object.assign(new Error(`op[${index}] must be an object`), { code: 'PATCH_OP_INVALID' });
    if (op.kind === 'range') {
      const start = op.startLine;
      const end = op.endLine;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        throw Object.assign(new Error(`op[${index}] range ${String(start)}-${String(end)} is invalid`), { code: 'PATCH_OP_INVALID' });
      }
      if (start > previousStart) {
        throw Object.assign(new Error(`op[${index}] starts at line ${start} after a later op; list range ops from the highest line number down`), { code: 'PATCH_OP_ORDER_INVALID' });
      }
      previousStart = start;
      const first = current[start - 1];
      const last = current[end - 1];
      if (first === undefined || last === undefined) {
        throw Object.assign(new Error(`op[${index}] range ${start}-${end} is outside the file (${current.length} lines)`), { code: 'PATCH_RANGE_OUT_OF_BOUNDS' });
      }
      if (typeof op.expectStart !== 'string' || !first.includes(op.expectStart)) {
        throw Object.assign(new Error(`op[${index}] start guard failed at line ${start}: ${JSON.stringify(first.slice(0, 120))}`), { code: 'PATCH_GUARD_FAILED' });
      }
      if (typeof op.expectEnd !== 'string' || !last.includes(op.expectEnd)) {
        throw Object.assign(new Error(`op[${index}] end guard failed at line ${end}: ${JSON.stringify(last.slice(0, 120))}`), { code: 'PATCH_GUARD_FAILED' });
      }
      if (typeof op.replaceFrom !== 'string' || op.replaceFrom === '') {
        throw Object.assign(new Error(`op[${index}] needs replaceFrom pointing at a fragment file`), { code: 'PATCH_OP_INVALID' });
      }
      const fragmentPath = path.resolve(specDir, op.replaceFrom);
      let fragmentRaw;
      try {
        fragmentRaw = readFileSync(fragmentPath, 'utf8');
      } catch (error) {
        throw Object.assign(new Error(`op[${index}] cannot read ${op.replaceFrom}: ${error.code ?? error.message}`), { code: 'PATCH_FRAGMENT_UNREADABLE' });
      }
      const { lines: fragment } = splitLines(fragmentRaw);
      current = [...current.slice(0, start - 1), ...fragment, ...current.slice(end)];
      applied.push({ index, kind: 'range', replacedLines: end - start + 1, startLine: start, endLine: end, replacementLines: fragment.length, status: 'applied' });
      continue;
    }
    if (op.kind === 'sequence') {
      const match = Array.isArray(op.match) ? op.match : null;
      const replace = Array.isArray(op.replace) ? op.replace : null;
      if (!match || match.length === 0 || !replace) {
        throw Object.assign(new Error(`op[${index}] needs match and replace line arrays`), { code: 'PATCH_OP_INVALID' });
      }
      const hits = [];
      for (let at = 0; at + match.length <= current.length; at += 1) {
        if (match.every((line, offset) => current[at + offset] === line)) hits.push(at);
      }
      if (hits.length !== 1) {
        throw Object.assign(new Error(`op[${index}] match occurs ${hits.length} times (expected exactly 1)`), { code: 'PATCH_MATCH_NOT_UNIQUE' });
      }
      current = [...current.slice(0, hits[0]), ...replace, ...current.slice(hits[0] + match.length)];
      applied.push({ index, kind: 'sequence', matchLines: match.length, replacementLines: replace.length, startLine: hits[0] + 1, status: 'applied' });
      continue;
    }
    throw Object.assign(new Error(`op[${index}] kind must be "range" or "sequence"`), { code: 'PATCH_OP_INVALID' });
  }
  return { applied, lines: current };
}
export async function patchReport(projectDir, args) {
  if (!args.spec) return { schemaVersion: SCHEMA_VERSION, command: 'patch', status: 'failed', error: 'patch needs --spec <spec.json>' };
  const specPath = path.resolve(projectDir, args.spec);
  let spec;
  try {
    spec = JSON.parse(readFileSync(specPath, 'utf8'));
  } catch (error) {
    return { schemaVersion: SCHEMA_VERSION, command: 'patch', status: 'failed', error: `cannot read spec: ${error.message}` };
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || typeof spec.file !== 'string' || !Array.isArray(spec.ops) || spec.ops.length === 0) {
    return { schemaVersion: SCHEMA_VERSION, command: 'patch', status: 'failed', error: 'spec must be { "file": "<path>", "ops": [ ... ] } with at least one op' };
  }
  const specDir = path.dirname(specPath);
  const target = path.resolve(specDir, spec.file);
  let raw;
  try {
    raw = readFileSync(target, 'utf8');
  } catch (error) {
    return { schemaVersion: SCHEMA_VERSION, command: 'patch', status: 'failed', error: `cannot read ${normalizePath(spec.file)}: ${error.code ?? error.message}` };
  }
  const eol = detectEol(raw);
  const { hadTrailingNewline, lines } = splitLines(raw);
  let result;
  try {
    result = applyPatchOps(lines, spec.ops, specDir);
  } catch (error) {
    return {
      schemaVersion: SCHEMA_VERSION,
      command: 'patch',
      status: 'failed',
      code: error.code ?? 'PATCH_FAILED',
      error: boundedOutput(error.message, projectDir),
      file: normalizePath(spec.file),
      write: Boolean(args.write),
      written: false,
    };
  }
  const nextText = result.lines.join(eol) + (hadTrailingNewline ? eol : '');
  if (!args.write) {
    return {
      schemaVersion: SCHEMA_VERSION,
      command: 'patch',
      status: 'planned',
      dryRun: true,
      eol: eol === '\r\n' ? 'crlf' : 'lf',
      file: normalizePath(spec.file),
      ops: result.applied,
      write: false,
      written: false,
    };
  }
  try {
    writeFileSync(target, nextText);
  } catch (error) {
    return { schemaVersion: SCHEMA_VERSION, command: 'patch', status: 'failed', error: `cannot write ${normalizePath(spec.file)}: ${error.code ?? error.message}`, file: normalizePath(spec.file), written: false };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'patch',
    status: 'passed',
    eol: eol === '\r\n' ? 'crlf' : 'lf',
    file: normalizePath(spec.file),
    linesAfter: result.lines.length,
    linesBefore: lines.length,
    ops: result.applied,
    write: true,
    written: true,
  };
}
