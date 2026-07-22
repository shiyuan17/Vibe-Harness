import { execFile } from 'node:child_process';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_CONTEXT_LENGTH = 4096;
const MAX_TASKS = 5;
const MAX_TASK_SUMMARY_LENGTH = 2800;
const STATUS_ORDER = new Map([
  ['进行中', 0],
  ['验证失败', 1],
  ['阻塞', 2],
  ['等待人工', 3],
  ['等待依赖', 4],
  ['空闲', 5],
]);

async function git(rootDir, args) {
  try {
    return (await execFileAsync('git', args, { cwd: rootDir, timeout: 3000, windowsHide: true })).stdout.trim();
  } catch {
    return '';
  }
}

export async function findProjectRoot(cwd) {
  const start = path.resolve(cwd);
  const gitRoot = await git(start, ['rev-parse', '--show-toplevel']);
  const boundary = gitRoot ? path.resolve(gitRoot) : path.parse(start).root;
  let current = start;
  while (true) {
    const [canonical, legacy] = await Promise.all([
      access(path.join(current, 'cognis.config.json')).then(() => true, () => false),
      access(path.join(current, 'loopengine.config.json')).then(() => true, () => false),
    ]);
    if (canonical || legacy) return current;
    if (current === boundary) return boundary;
    const parent = path.dirname(current);
    if (parent === current) return boundary;
    current = parent;
  }
}

async function readOptionalText(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function readProjectConfig(rootDir) {
  const [canonical, legacy] = await Promise.all([
    readOptionalText(path.join(rootDir, 'cognis.config.json')),
    readOptionalText(path.join(rootDir, 'loopengine.config.json')),
  ]);
  if (canonical !== null && legacy !== null) {
    throw Object.assign(new Error('COGNIS_CONFIG_CONFLICT: canonical and legacy project configs coexist.'), {
      code: 'COGNIS_CONFIG_CONFLICT',
    });
  }
  const content = canonical ?? legacy;
  if (content === null) throw Object.assign(new Error('Project configuration is missing.'), { code: 'ENOENT' });
  return JSON.parse(content);
}

export async function readHookSettings(rootDir) {
  try {
    const config = await readProjectConfig(rootDir);
    let installState = null;
    for (const relativePath of ['.cognis/install-state.json', '.loopengine/install-state.json']) {
      const content = await readOptionalText(path.join(rootDir, relativePath));
      if (content !== null) {
        installState = JSON.parse(content);
        break;
      }
    }
    const mode = ['off', 'observe', 'guarded', 'strict'].includes(config.hooks?.mode)
      ? config.hooks.mode
      : 'guarded';
    const completionGate = ['off', 'advisory', 'blocking'].includes(config.hooks?.completionGate)
      ? config.hooks.completionGate
      : 'advisory';
    return {
      completionGate,
      evaluationsEnabled: Boolean(config.evaluations?.enabled),
      mode,
      rtkEnabled: Object.hasOwn(config.hooks?.rtk ?? {}, 'enabled')
        ? config.hooks.rtk.enabled
        : Boolean(installState?.rtkHooksEnabled),
      validationCommands: config.validationCommands ?? {},
      workflow: config.governance?.workflow ?? 'strict',
    };
  } catch (error) {
    if (error.code === 'COGNIS_CONFIG_CONFLICT') throw error;
    return {
      completionGate: 'advisory',
      evaluationsEnabled: false,
      mode: 'guarded',
      rtkEnabled: false,
      validationCommands: {},
      workflow: 'strict',
    };
  }
}

function truncate(value, maxLength) {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function section(body, name) {
  const lines = body.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === `## ${name}`);
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && /^##\s+/u.test(line.trim()));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

function parseTask(body, relativePath) {
  const title = body.match(/^#\s+(\S+)\s+(.+)$/mu);
  const preamble = body.split(/^##\s+/mu, 1)[0];
  const fields = Object.fromEntries(
    [...preamble.matchAll(/^-\s*([^：:\r\n]+)[：:]\s*(.+)$/gmu)]
      .map((match) => [match[1].trim(), match[2].trim()]),
  );
  const value = (...names) => names.map((name) => fields[name]).find(Boolean);
  const tier = value('工作流档位', 'Workflow tier');
  const phase = value('当前阶段', 'Current phase');
  const status = value('当前状态', 'Current status');
  const result = value('处理结果', 'Result');
  if (!title || !tier || !phase || !status || !result) {
    return { malformed: true, relativePath };
  }
  if (!['开放', 'open'].includes(result.toLowerCase())) return null;
  return {
    id: truncate(title[1], 80),
    next: truncate(section(body, '下一步动作') || section(body, 'Next action') || '未填写', 240),
    phase: truncate(phase, 40),
    relativePath,
    status: truncate(status, 40),
    tier: truncate(tier, 40),
    title: truncate(title[2], 120),
  };
}

async function collectMarkdownFiles(directory, rootDir, result = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectMarkdownFiles(absolute, rootDir, result);
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      result.push({ absolute, relative: path.relative(rootDir, absolute).replaceAll('\\', '/') });
    }
  }
  return result;
}

async function taskContracts(rootDir) {
  const taskDir = path.join(rootDir, 'docs', 'tasks');
  try {
    const files = await collectMarkdownFiles(taskDir, rootDir);
    return Promise.all(files.map(async ({ absolute, relative }) => (
      parseTask(await readFile(absolute, 'utf8'), relative)
    )));
  } catch {
    return [];
  }
}

export async function inspectActiveTasks(rootDir) {
  const tasks = (await taskContracts(rootDir))
    .filter((task) => task && !task.malformed && !['空闲', 'idle'].includes(task.status.toLowerCase()));
  return {
    any: tasks.length > 0,
    full: tasks.some((task) => ['完整', 'full'].includes(task.tier.toLowerCase())),
  };
}

async function taskSummary(rootDir) {
  try {
    const parsed = await taskContracts(rootDir);
    const malformed = parsed.filter((task) => task?.malformed)
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const active = parsed.filter((task) => task && !task.malformed)
      .sort((left, right) => (
        (STATUS_ORDER.get(left.status) ?? Number.MAX_SAFE_INTEGER)
        - (STATUS_ORDER.get(right.status) ?? Number.MAX_SAFE_INTEGER)
        || left.relativePath.localeCompare(right.relativePath)
      ))
      .slice(0, MAX_TASKS);
    const lines = [
      ...active.map((task) => `  - ${task.id} ${task.title} [${task.tier}/${task.phase}/${task.status}] 下一步=${task.next}`),
      ...malformed.map((task) => `  - ${task.relativePath} [格式不可识别]`),
    ];
    const summary = lines.length > 0 ? lines.join('\n') : '  - none';
    return summary.length <= MAX_TASK_SUMMARY_LENGTH
      ? summary
      : `${summary.slice(0, MAX_TASK_SUMMARY_LENGTH - 1)}…`;
  } catch {
    return '  - none';
  }
}

export async function buildProjectContext(rootDir) {
  const [branch, status, tasks] = await Promise.all([
    git(rootDir, ['branch', '--show-current']),
    git(rootDir, ['status', '--short']),
    taskSummary(rootDir),
  ]);
  const allStatusLines = status ? status.split(/\r?\n/u) : [];
  const statusLines = allStatusLines.slice(0, 20);
  const changedSummary = allStatusLines.length > statusLines.length
    ? `${allStatusLines.length} changed path(s), first ${statusLines.length} shown`
    : `${allStatusLines.length} changed path(s)`;
  const instruction = 'Use repository rules and verify current filesystem state before acting.';
  const context = [
    `Project root: ${rootDir}`,
    `Git branch: ${branch || '(detached or unavailable)'}`,
    `Working tree: ${statusLines.length === 0 ? 'clean' : changedSummary}`,
    'Active task contracts:',
    tasks,
  ].join('\n');
  const available = MAX_CONTEXT_LENGTH - instruction.length - 1;
  return `${context.slice(0, available)}\n${instruction}`;
}

export async function runGovernanceCheck(rootDir) {
  let validator;
  for (const relativePath of [
    '.agents/cognis/governance/validate.mjs',
    '.agents/loopengine/governance/validate.mjs',
  ]) {
    const candidate = path.join(rootDir, relativePath);
    try {
      await access(candidate);
      validator = candidate;
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  try {
    if (!validator) throw Object.assign(new Error('Governance validator is missing.'), { code: 'ENOENT' });
    await execFileAsync(process.execPath, [validator], {
      cwd: rootDir,
      timeout: 15000,
      windowsHide: true,
    });
    return { ok: true, status: 'passed' };
  } catch (error) {
    if (error.code === 'ENOENT') {
      for (const relativePath of ['.cognis/install-state.json', '.loopengine/install-state.json']) {
        try {
          const state = JSON.parse(await readFile(path.join(rootDir, relativePath), 'utf8'));
          if (['minimal', 'docs-only'].includes(state.profile)) {
            return { ok: true, status: 'not-applicable' };
          }
          break;
        } catch (stateError) {
          if (stateError.code !== 'ENOENT') break;
        }
      }
      return { ok: false, status: 'unavailable' };
    }
    return { ok: false, status: 'failed' };
  }
}

function splitCommand(command) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/gu;
  for (const match of command.matchAll(pattern)) tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
}

export async function runEvaluationCheck(rootDir, command) {
  if (!command) return { ok: true, skipped: true };
  const [program, ...args] = splitCommand(command);
  if (!program) return { ok: false };
  const executable = process.platform === 'win32' && ['pnpm', 'npm', 'yarn'].includes(program)
    ? `${program}.cmd`
    : (program === 'node' ? process.execPath : program);
  try {
    await execFileAsync(executable, args, {
      cwd: rootDir,
      maxBuffer: 1024 * 1024,
      timeout: 10 * 60 * 1000,
      windowsHide: true,
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
