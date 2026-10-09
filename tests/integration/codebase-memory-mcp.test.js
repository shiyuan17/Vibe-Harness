import '../helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  aliasPathForRoot,
  replaceAliasInStatusOutput,
} from '../../runtime/tools/codebase-memory-mcp/path-alias.mjs';
import { codebaseMemoryProjectSlug } from '../../runtime/tools/codebase-memory-mcp/cache-path.mjs';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '../..');
const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test('Vibe-Harness removes the CodeGraph CLI integration and doctor report', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-doctor-'));
  try {
    const help = await execFileAsync(process.execPath, [cliPath, 'help']);
    assert.equal(help.stdout.toLowerCase().includes('codegraph'), false);
    await execFileAsync(process.execPath, [cliPath, 'init', '--project', target]);

    let doctor;
    try {
      doctor = await execFileAsync(process.execPath, [cliPath, 'doctor', '--project', target]);
    } catch (error) {
      doctor = error;
    }
    const report = JSON.parse(doctor.stdout || doctor.stderr);
    assert.equal(Object.hasOwn(report, 'codegraph'), false);
    assert.equal(await exists(path.join(rootDir, 'scripts/lib/codegraph.js')), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('codebase-memory-mcp rule uses MCP tools and a repository-search fallback without global writes', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-codebase-memory-profile-'));
  const rulePath = path.join(rootDir, 'docs/rules/codebase-memory-mcp.md');
  const ruleSource = await readFile(rulePath, 'utf8');
  const marker = String.fromCharCode(96);
  const rule = ruleSource.replaceAll('<code>', marker).replaceAll('</code>', marker);
  const agents = await readFile(path.join(rootDir, 'adapters/codex/AGENTS.template.md'), 'utf8');

  try {
    // The documented surface is the one 0.11.0 actually exposes. A rule that
    // names an unreachable tool makes its first step unexecutable.
    for (const tool of [
      'index_repository', 'index_status', 'list_projects', 'check_index_coverage',
      'search_graph', 'query_graph', 'trace_path', 'get_code_snippet',
      'detect_changes', 'get_architecture', 'manage_adr',
    ]) {
      assert.equal(rule.includes(`\`${tool}\``), true, `${tool} should be documented`);
    }
    assert.equal(rule.includes('trace_call_path'), false);
    assert.match(rule, /codebase-memory status --project \. --json/u);
    assert.match(rule, /refresh --project \. --write/u);
    assert.match(rule, /search_graph.*trace_path.*get_code_snippet/su);
    assert.match(rule, /MCP.*不可用.*(?:rg|仓库搜索)/su);
    assert.match(rule, /不得.*(?:全局|Agent).*配置/su);
    assert.equal(rule.includes('codebase-memory-mcp install'), false);
    assert.equal(agents.includes('codebase-memory-mcp'), false);
    assert.equal(agents.toLowerCase().includes('codegraph'), false);
    // The 2024 removal took out the CLI-era integration (scripts/lib/codegraph.js,
    // doctor and help enumeration). What ships today is the MCP-era optional
    // rule-only plugin, so the rule file is expected on disk.
    assert.equal(await exists(path.join(rootDir, 'docs/rules/codegraph.md')), true);

    await execFileAsync(process.execPath, [cliPath, 'init', '--project', target]);
    const core = await execFileAsync(process.execPath, [cliPath, 'install', '--project', target, '--target', 'codex', '--profile', 'core', '--dry-run', '--verbose'], { maxBuffer: 8 * 1024 * 1024 });
    const full = await execFileAsync(process.execPath, [cliPath, 'install', '--project', target, '--target', 'codex', '--profile', 'full', '--dry-run', '--verbose'], { maxBuffer: 8 * 1024 * 1024 });
    const selected = await execFileAsync(process.execPath, [cliPath, 'install', '--project', target, '--target', 'codex', '--profile', 'full', '--plugin', '-codebase-memory-mcp', '--dry-run', '--verbose'], { maxBuffer: 8 * 1024 * 1024 });
    const coreAgents = JSON.parse(core.stdout).previewFiles.find((file) => file.target === 'AGENTS.md').content;
    const fullAgents = JSON.parse(full.stdout).previewFiles.find((file) => file.target === 'AGENTS.md').content;
    const selectedAgents = JSON.parse(selected.stdout).previewFiles.find((file) => file.target === 'AGENTS.md').content;

    assert.equal(coreAgents.includes('codebase-memory-mcp'), false);
    assert.equal(fullAgents.includes('codebase-memory-mcp'), false);
    assert.equal(selectedAgents.includes('codebase-memory-mcp'), true);

    // The rule-only tool plugins stay opt-in: no profile installs them, and each
    // explicit --plugin selection installs the rule file plus its index line.
    for (const plugin of ['codegraph', 'serena', 'probe']) {
      assert.equal(coreAgents.includes(plugin), false, `core should not install ${plugin}`);
      assert.equal(fullAgents.includes(plugin), false, `full should not install ${plugin}`);

      const pluginInstall = await execFileAsync(process.execPath, [cliPath, 'install', '--project', target, '--target', 'codex', '--profile', 'core', '--plugin', plugin, '--dry-run', '--verbose'], { maxBuffer: 8 * 1024 * 1024 });
      const pluginPreview = JSON.parse(pluginInstall.stdout).previewFiles;
      const pluginAgents = pluginPreview.find((file) => file.target === 'AGENTS.md').content;
      assert.equal(pluginPreview.some((file) => file.target === `docs/rules/${plugin}.md`), true, `${plugin} rule file should install`);
      assert.equal(pluginAgents.includes(`${plugin}（`), true, `${plugin} should render in the rules index`);
    }
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('codebase-memory uses a stable Windows alias for the same Unicode root', () => {
  const root = 'D:\\projects\\web-ui\\组件\\code\\sample-admin';
  const first = aliasPathForRoot(root);
  const second = aliasPathForRoot(root);

  assert.equal(first, second);
  assert.match(path.basename(first), /^vibe-harness-cbm-[a-f0-9]{16}$/u);
  assert.notEqual(aliasPathForRoot(`${root}-other`), first);
});

test('codebase-memory preserves valid JSON when replacing a Windows alias in status output', () => {
  const alias = 'C:\\Users\\test\\AppData\\Local\\Temp\\vibe-harness-cbm-0123456789abcdef';
  const target = 'D:\\projects\\web-ui\\组件\\code\\sample-admin';
  const output = JSON.stringify({ root_path: alias, status: 'ready' });
  const parsed = JSON.parse(replaceAliasInStatusOutput(output, alias, target));

  assert.equal(parsed.root_path, target);
  assert.equal(parsed.status, 'ready');
});

test('codebase-memory 0.11.0 信封输出在别名替换后仍是有效 JSON', () => {
  const alias = 'C:\\Users\\test\\AppData\\Local\\Temp\\vibe-harness-cbm-0123456789abcdef';
  const target = 'D:\\projects\\web-ui\\组件\\code\\sample-admin';
  // 0.11.0 `--json` wraps the human-readable block, and it reports Windows
  // paths with forward slashes.
  const statusText = [
    'project: sample',
    'nodes: 3',
    'edges: 4',
    'status: ready',
    `root_path: ${alias.replaceAll('\\', '/')}`,
    'indexed_at: 2026-01-01T00:00:00Z',
  ].join('\n');
  const envelope = JSON.stringify({ content: [{ text: statusText, type: 'text' }], isError: false });
  const rewritten = replaceAliasInStatusOutput(envelope, alias, target);

  assert.equal(rewritten.includes('vibe-harness-cbm-0123456789abcdef'), false);
  assert.equal(rewritten.includes(target.replaceAll('\\', '/')), true);
  assert.equal(JSON.parse(rewritten).isError, false);
});

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_EMAIL: 'test@example.test',
  GIT_AUTHOR_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.test',
  GIT_COMMITTER_NAME: 'Test',
};

async function gitProject(args, cwd) {
  return execFileAsync('git', args, { cwd, env: gitEnv, maxBuffer: 1024 * 1024, windowsHide: true });
}

/**
 * Hermetic private-cache root: the CLI resolves `%LOCALAPPDATA%` (Windows) or
 * `$XDG_CACHE_HOME` (POSIX) from its own environment, so pointing both at a
 * temporary directory keeps the assertions away from the operator's real cache.
 */
function privateCacheEnv(base, cacheHome) {
  return { ...base, LOCALAPPDATA: cacheHome, XDG_CACHE_HOME: cacheHome };
}

function privateCacheDir(targetDir, cacheHome) {
  return path.join(cacheHome, 'vibe-harness', 'codebase-memory-mcp', codebaseMemoryProjectSlug(targetDir));
}

/** Run a CLI command whose receipt is JSON on stdout or on stderr on failure. */
async function runCliJson(args, options = {}) {
  let result;
  try {
    result = await execFileAsync(process.execPath, [cliPath, ...args], {
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      ...options,
    });
  } catch (error) {
    result = error;
  }
  return JSON.parse(result.stdout || result.stderr);
}

/**
 * The freshness contract end to end: the wrapper stamps the HEAD it indexed and
 * the project command compares that stamp with the current HEAD. The runtime is
 * a fixture here, so the test stays hermetic while still exercising the real
 * wrapper, the real state file and the real command.
 */
test('wrapper 落盘已索引 HEAD，项目命令据此报告 missing、fresh 与 stale', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-cbm-state-'));
  const toolDir = path.join(target, '.agents/runtime/tools/codebase-memory-mcp');
  const commandPath = path.join(target, '.agents/runtime/commands/run.mjs');
  const cacheDir = path.join(target, '..', `${path.basename(target)}-private-cache`);
  const runtimeSource = path.join(rootDir, 'runtime/tools/codebase-memory-mcp');
  const env = { ...process.env, CBM_ALLOWED_ROOT: target, CBM_CACHE_DIR: path.resolve(cacheDir) };
  const runStatus = async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [commandPath, 'codebase-memory', 'status', '--project', '.', '--json'],
      { cwd: target, env, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
    );
    return JSON.parse(stdout);
  };

  try {
    await mkdir(toolDir, { recursive: true });
    await mkdir(path.join(target, '.agents/runtime/commands'), { recursive: true });
    for (const file of ['run.mjs', 'path-alias.mjs', 'cache-path.mjs', 'index-state.mjs', 'project-root.mjs']) {
      await copyFile(path.join(runtimeSource, file), path.join(toolDir, file));
    }
    // The project command imports the shared runtime library, so the fixture
    // mirrors the installed layout instead of a single file.
    await mkdir(path.join(target, '.agents/runtime'), { recursive: true });
    await cp(path.join(rootDir, 'runtime/lib'), path.join(target, '.agents/runtime/lib'), { recursive: true });
    await copyFile(path.join(rootDir, 'runtime/commands/run.mjs'), commandPath);
    const packageDir = path.join(toolDir, 'node_modules/codebase-memory-mcp');
    await mkdir(packageDir, { recursive: true });
    await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: 'codebase-memory-mcp', version: '0.11.0' }), 'utf8');
    await writeFile(path.join(packageDir, 'bin.js'), [
      "const args = process.argv.slice(2);",
      "const tool = args[args.indexOf('cli') + 1] ?? '';",
      "const envelope = (text) => JSON.stringify({ content: [{ text, type: 'text' }], isError: false });",
      "if (tool === 'index_repository') {",
      "  process.stdout.write(envelope(JSON.stringify({ edges: 7, nodes: 9, project: 'fixture-project', status: 'indexed' })) + '\\n');",
      "} else if (tool === 'list_projects') {",
      "  process.stdout.write(envelope('projects: 0  (cols: name root_path branch)\\ntotal: 0\\n') + '\\n');",
      "} else {",
      "  process.stdout.write(envelope('project: fixture-project\\nnodes: 9\\nedges: 7\\nstatus: ready\\nindexed_at: 2026-01-01T00:00:00Z\\n') + '\\n');",
      "}",
    ].join('\n'), 'utf8');

    await writeFile(path.join(target, 'indexed.js'), 'export const first = 1;\n', 'utf8');
    await gitProject(['init', '--initial-branch=main'], target);
    await gitProject(['add', '.'], target);
    await gitProject(['-c', 'commit.gpgsign=false', 'commit', '-m', 'first'], target);
    const firstHead = (await gitProject(['rev-parse', 'HEAD'], target)).stdout.trim();

    const beforeIndex = await runStatus();
    assert.equal(beforeIndex.status, 'missing');
    assert.equal(beforeIndex.reason, 'no-index-state');
    assert.equal(beforeIndex.headSha, firstHead);

    const wrapperPath = path.join(toolDir, 'run.mjs');
    await execFileAsync(process.execPath, [
      wrapperPath, 'cli', 'index_repository', '--repo-path', '.', '--mode', 'moderate', '--persistence', 'false', '--json',
    ], { cwd: target, env, maxBuffer: 4 * 1024 * 1024, windowsHide: true });

    const state = JSON.parse(await readFile(
      path.join(target, '.vibe-harness/tool-state/codebase-memory-mcp/index-state.json'),
      'utf8',
    ));
    assert.equal(state.headSha, firstHead);
    assert.equal(state.nodes, 9);
    assert.equal(state.edges, 7);
    assert.equal(state.runtimeVersion, '0.11.0');
    assert.equal(state.project, 'fixture-project');
    assert.equal(state.schemaVersion, 1);

    const fresh = await runStatus();
    assert.equal(fresh.status, 'fresh');
    assert.equal(fresh.reason, 'head-sha-match');
    assert.equal(fresh.indexedHeadSha, firstHead);

    await writeFile(path.join(target, 'second.js'), 'export const second = 2;\n', 'utf8');
    await gitProject(['add', '.'], target);
    await gitProject(['-c', 'commit.gpgsign=false', 'commit', '-m', 'second'], target);
    const secondHead = (await gitProject(['rev-parse', 'HEAD'], target)).stdout.trim();

    const stale = await runStatus();
    assert.equal(stale.status, 'stale');
    assert.equal(stale.reason, 'head-sha-changed');
    assert.equal(stale.headSha, secondHead);
    assert.equal(stale.indexedHeadSha, firstHead);
    assert.equal(Array.isArray(stale.guidance), true);

    const refreshed = JSON.parse((await execFileAsync(process.execPath, [
      commandPath, 'codebase-memory', 'refresh', '--project', '.', '--write', '--json',
    ], { cwd: target, env, maxBuffer: 8 * 1024 * 1024, windowsHide: true })).stdout);
    assert.equal(refreshed.action, 'refresh');
    assert.equal(refreshed.status, 'fresh');
    assert.equal(refreshed.refresh.indexRepository.status, 'passed');

    const planned = JSON.parse((await execFileAsync(process.execPath, [
      commandPath, 'codebase-memory', 'refresh', '--project', '.', '--json',
    ], { cwd: target, env, maxBuffer: 4 * 1024 * 1024, windowsHide: true })).stdout);
    assert.equal(planned.status, 'planned');
    assert.equal(planned.dryRun, true);
    assert.equal(planned.steps.length, 2);
  } finally {
    await rm(target, { force: true, recursive: true });
    await rm(path.resolve(cacheDir), { force: true, recursive: true });
  }
});

/**
 * The cache moved out of the project, so nothing in the repository tree tells
 * a user where the graph is or whether it still matches HEAD. doctor answers
 * both questions and flags the pre-0.11.0 copies that would otherwise keep
 * serving an outdated graph.
 */
test('doctor 报告外移缓存位置、状态戳新鲜度与陈旧副本', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-cbm-cache-doctor-'));
  const cacheHome = await mkdtemp(path.join(tmpdir(), 'vibe-harness-cbm-cache-home-'));
  const userHome = await mkdtemp(path.join(tmpdir(), 'vibe-harness-cbm-user-home-'));
  const env = { ...privateCacheEnv(process.env, cacheHome), HOME: userHome, USERPROFILE: userHome };
  const runDoctor = () => runCliJson(['doctor', '--project', target, '--allow-degraded'], { env });
  try {
    await runCliJson(['init', '--project', target], { env });
    // A projected runtime is what makes the cache report relevant for a project.
    await mkdir(path.join(target, '.agents/runtime/tools/codebase-memory-mcp'), { recursive: true });
    await writeFile(path.join(target, '.agents/runtime/tools/codebase-memory-mcp/run.mjs'), 'export {};\n', 'utf8');
    await writeFile(path.join(target, 'app.js'), 'export const app = 1;\n', 'utf8');
    await gitProject(['init', '--initial-branch=main'], target);
    await gitProject(['add', '.'], target);
    await gitProject(['-c', 'commit.gpgsign=false', 'commit', '-m', 'first'], target);
    const headSha = (await gitProject(['rev-parse', 'HEAD'], target)).stdout.trim();

    const cacheDir = privateCacheDir(target, cacheHome);
    await mkdir(cacheDir, { recursive: true });
    const legacyUserCache = path.join(userHome, '.cache', 'codebase-memory-mcp');
    await mkdir(legacyUserCache, { recursive: true });
    const statePath = path.join(target, '.vibe-harness/tool-state/codebase-memory-mcp/index-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      edges: 7,
      headSha,
      indexedAt: '2026-01-01T00:00:00Z',
      nodes: 9,
      project: 'fixture-project',
      rootPath: target,
      runtimeVersion: '0.11.0',
    }), 'utf8');

    const fresh = await runDoctor();
    assert.equal(fresh.codebaseMemoryCache.cacheDir, cacheDir);
    assert.equal(fresh.codebaseMemoryCache.cacheDirExists, true);
    assert.equal(fresh.codebaseMemoryCache.explicitCacheDir, false);
    assert.equal(fresh.codebaseMemoryCache.freshness.state, 'fresh');
    assert.equal(fresh.codebaseMemoryCache.indexState.indexedAt, '2026-01-01T00:00:00Z');
    assert.deepEqual(fresh.codebaseMemoryCache.staleCopies, [{ kind: 'user-level', path: legacyUserCache }]);
    assert.equal(
      fresh.warnings.some((warning) => warning.code === 'CODEBASE_MEMORY_CACHE_STALE_COPY'),
      true,
    );

    await writeFile(path.join(target, 'second.js'), 'export const second = 2;\n', 'utf8');
    await gitProject(['add', '.'], target);
    await gitProject(['-c', 'commit.gpgsign=false', 'commit', '-m', 'second'], target);
    const stale = await runDoctor();
    assert.equal(stale.codebaseMemoryCache.freshness.state, 'stale');
    assert.equal(stale.codebaseMemoryCache.freshness.reason, 'head-sha-changed');
    assert.equal(
      stale.warnings.some((warning) => warning.code === 'CODEBASE_MEMORY_INDEX_STALE'),
      true,
    );
  } finally {
    await rm(target, { force: true, recursive: true });
    await rm(cacheHome, { force: true, recursive: true });
    await rm(userHome, { force: true, recursive: true });
  }
});

test('uninstall 在 runtime 离开项目时清理外移缓存，dry-run 只报告计划', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-cbm-cache-uninstall-'));
  const cacheHome = await mkdtemp(path.join(tmpdir(), 'vibe-harness-cbm-cache-uninstall-home-'));
  const env = privateCacheEnv(process.env, cacheHome);
  try {
    await runCliJson(['init', '--project', target], { env });
    await runCliJson(['install', '--project', target, '--target', 'codex', '--profile', 'core', '--write'], { env });
    const cacheDir = privateCacheDir(target, cacheHome);
    await mkdir(cacheDir, { recursive: true });

    const planned = await runCliJson(['uninstall', '--project', target, '--all-targets', '--dry-run'], { env });
    assert.equal(planned.cacheCleanup.planned, true);
    assert.equal(planned.cacheCleanup.dir, cacheDir);
    assert.equal(await exists(cacheDir), true);

    const applied = await runCliJson(
      ['uninstall', '--project', target, '--all-targets', '--write', '--confirm-red-zone'],
      { env },
    );
    assert.equal(applied.cacheCleanup.removed, true);
    assert.equal(applied.cacheCleanup.dir, cacheDir);
    assert.equal(await exists(cacheDir), false);
  } finally {
    await rm(target, { force: true, recursive: true });
    await rm(cacheHome, { force: true, recursive: true });
  }
});
