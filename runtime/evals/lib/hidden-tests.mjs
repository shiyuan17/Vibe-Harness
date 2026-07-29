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

// Runs the hidden test commands declared in `request.case.input.fixture.tests` against the agent
// workspace. Returns ['hidden-tests-passed'] when every command exits with its expectedExitCode
// (default 0) within timeoutMs, ['hidden-tests-failed'] on any mismatch, timeout, or spawn error
// (fail-closed), and [] when no tests are declared. FAIL_TO_PASS discipline: all commands must pass.
export async function runHiddenTests(request, environment) {
  const tests = request.case.input?.fixture?.tests ?? [];
  if (tests.length === 0) return [];
  for (const test of tests) {
    if (!Array.isArray(test.command) || test.command.length === 0) return ['hidden-tests-failed'];
    const timeoutMs = test.timeoutMs ?? 30000;
    let result;
    try {
      result = await executeHiddenTest(test.command, request.workspace, environment, timeoutMs);
    } catch {
      return ['hidden-tests-failed'];
    }
    if (result.code !== (test.expectedExitCode ?? 0)) return ['hidden-tests-failed'];
  }
  return ['hidden-tests-passed'];
}
