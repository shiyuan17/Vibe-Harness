import { spawn } from 'node:child_process';

const LIMIT = 1024 * 1024;

const environmentAllowlist = new Set([
  'ALL_PROXY', 'APPDATA', 'AZURE_OPENAI_API_KEY', 'CODEX_HOME', 'COMSPEC', 'HOME',
  'HTTPS_PROXY', 'HTTP_PROXY', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOCALAPPDATA', 'NO_PROXY',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'PATH', 'Path', 'PATHEXT', 'PROGRAMDATA', 'ProgramData',
  'SHELL', 'SSL_CERT_DIR', 'SSL_CERT_FILE', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE',
  'WINDIR', 'all_proxy', 'https_proxy', 'http_proxy', 'no_proxy',
]);

function filteredEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => environmentAllowlist.has(name)));
}

function executeHiddenTest(command, cwd, environment, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env: { ...filteredEnvironment(process.env), ...environment },
      shell: false,
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ code: 124, stderr: 'hidden test timed out', stdout: '' });
    }, timeoutMs);
    const append = (value, chunk) => {
      const next = Buffer.concat([value, chunk]);
      return next.length > LIMIT ? next.subarray(0, LIMIT) : next;
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 1, stderr: 'hidden test failed to spawn', stdout: '' });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stderr: stderr.toString('utf8'), stdout: stdout.toString('utf8') });
    });
    child.stdin.end();
  });
}

// Runs every hidden command so reports can distinguish behavior and API-contract failures.
// Command output stays inside this harness and is never returned to the run artifact.
export async function runHiddenTests(request, environment) {
  const tests = request.case.input?.fixture?.tests ?? [];
  const summary = { apiContractFailures: 0, apiExistenceFailures: 0, failed: 0, passed: 0, total: tests.length };
  if (tests.length === 0) return { events: [], summary };
  for (const test of tests) {
    let passed = false;
    if (!Array.isArray(test.command) || test.command.length === 0) {
      summary.failed += 1;
      if (test.kind === 'api-contract' || test.diagnosticCategory === 'api-contract' || test.diagnosticCategory === 'api-existence') summary.apiContractFailures += 1;
      if (test.diagnosticCategory === 'api-existence') summary.apiExistenceFailures += 1;
      continue;
    }
    const timeoutMs = test.timeoutMs ?? 30000;
    try {
      const result = await executeHiddenTest(test.command, request.workspace, environment, timeoutMs);
      passed = result.code === (test.expectedExitCode ?? 0);
    } catch {}
    if (passed) summary.passed += 1;
    else {
      summary.failed += 1;
      if (test.kind === 'api-contract' || test.diagnosticCategory === 'api-contract' || test.diagnosticCategory === 'api-existence') summary.apiContractFailures += 1;
      if (test.diagnosticCategory === 'api-existence') summary.apiExistenceFailures += 1;
    }
  }
  return {
    events: summary.failed === 0 ? ['hidden-tests-passed'] : ['hidden-tests-failed'],
    summary,
  };
}
