import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { auditRuntimeTools, resolveNpmAuditInvocation } from '../scripts/lib/runtime-audit.js';

const rootDir = path.resolve('.');

function auditPayload({ critical = 0, high = 0, low = 0, moderate = 0 } = {}) {
  return {
    auditReportVersion: 2,
    metadata: {
      vulnerabilities: { critical, high, info: 0, low, moderate, total: critical + high + low + moderate },
    },
    vulnerabilities: {},
  };
}

test('runtime audit mirrors the installed dependency surface for every tool', async () => {
  const calls = [];
  const report = await auditRuntimeTools(rootDir, {
    runAudit: async (request) => {
      calls.push(request);
      return { exitCode: 0, stderr: '', stdout: JSON.stringify(auditPayload()) };
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.tools.length, 5);
  const agentmemory = calls.find((call) => call.id === 'agentmemory' && call.surface === 'installed');
  const chromeDevtools = calls.find((call) => call.id === 'chrome-devtools-mcp' && call.surface === 'installed');
  const playwright = calls.find((call) => call.id === 'playwright-cli' && call.surface === 'installed');
  assert.ok(chromeDevtools, 'Chrome DevTools MCP dependency surface should be audited');
  assert.equal(agentmemory.args.includes('--omit=optional'), true);
  assert.equal(agentmemory.args.includes('--omit=dev'), false);
  assert.equal(playwright.args.includes('--omit=dev'), false);
  assert.equal(calls.some((call) => call.id === 'agentmemory' && call.surface === 'lockfile'), true);
});

test('runtime audit launches npm through npm-cli.js on Windows', async () => {
  const execPath = path.join('C:', 'node', 'node.exe');
  const invocation = await resolveNpmAuditInvocation(['audit'], {
    execPath,
    pathExists: async (candidate) => candidate.endsWith(path.join('node_modules', 'npm', 'bin', 'npm-cli.js')),
    platform: 'win32',
  });
  assert.equal(invocation.command, execPath);
  assert.match(invocation.args[0], /npm[\\/]bin[\\/]npm-cli\.js$/u);
  assert.equal(invocation.args[1], 'audit');
});

test('runtime audit blocks high findings but reports moderate findings', async () => {
  const report = await auditRuntimeTools(rootDir, {
    runAudit: async ({ id, surface }) => {
      const findings = id === 'agentmemory' && surface === 'lockfile'
        ? { critical: 1, high: 4, moderate: 11 }
        : id === 'open-code-review'
          ? { moderate: 2 }
          : id === 'codebase-memory-mcp'
            ? { high: 1 }
            : {};
      return { exitCode: findings.high || findings.critical ? 1 : 0, stderr: '', stdout: JSON.stringify(auditPayload(findings)) };
    },
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.blocking, [{ critical: 0, high: 1, id: 'codebase-memory-mcp' }]);
  assert.deepEqual(report.warnings, [{ id: 'open-code-review', moderate: 2 }]);
  const agentmemory = report.tools.find((tool) => tool.id === 'agentmemory');
  assert.deepEqual(agentmemory.installed, { critical: 0, high: 0, info: 0, low: 0, moderate: 0, total: 0 });
  assert.deepEqual(agentmemory.excludedOptional, { critical: 1, high: 4, info: 0, low: 0, moderate: 11, total: 16 });
});

test('runtime audit fails closed on command and output errors', async () => {
  const commandFailure = await auditRuntimeTools(rootDir, {
    runAudit: async () => ({ exitCode: 2, stderr: 'registry unavailable', stdout: '' }),
  });
  assert.equal(commandFailure.ok, false);
  assert.match(commandFailure.errors[0].message, /did not return JSON/u);

  const invalidOutput = await auditRuntimeTools(rootDir, {
    runAudit: async () => ({ exitCode: 0, stderr: '', stdout: '{invalid' }),
  });
  assert.equal(invalidOutput.ok, false);
  assert.match(invalidOutput.errors[0].message, /invalid JSON/u);
});
