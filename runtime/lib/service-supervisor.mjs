import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:net';

process.once('message', (input) => {
  const cwd = realpathSync(input.cwd);
  const fingerprint = createHash('sha256').update(JSON.stringify([cwd, input.tokens])).digest('hex');
  const child = spawn(input.tokens[0] === 'node' ? process.execPath : input.tokens[0], input.tokens.slice(1), {
    cwd, env: { ...process.env, PORT: String(input.port) }, stdio: 'ignore', windowsHide: true,
    detached: process.platform !== 'win32',
  });
  let exited = false;
  let stopping = false;
  const startedAt = new Date().toISOString();
  const identity = { pid: child.pid, supervisorPid: process.pid, cwd, commandFingerprint: fingerprint, startedAt };
  const server = createServer((socket) => {
    let buffer = '';
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 4096) { socket.destroy(); return; }
      if (!buffer.includes('\n')) return;
      let request;
      try { request = JSON.parse(buffer.trim()); } catch { socket.destroy(); return; }
      if (request.action === 'status') { socket.end(JSON.stringify({ ...identity, status: exited ? 'blocked' : 'running' }) + '\n'); return; }
      if (request.action !== 'stop' || stopping
        || ['pid', 'supervisorPid', 'cwd', 'commandFingerprint', 'startedAt'].some((key) => request[key] !== identity[key])) {
        socket.end(JSON.stringify({ status: 'blocked', reason: 'ownership-mismatch' }) + '\n'); return;
      }
      stopping = true;
      const finish = (status) => {
        socket.end(JSON.stringify({ ...identity, status }) + '\n');
        if (status === 'stopped') server.close(() => process.exit(0));
        else stopping = false;
      };
      if (exited) { finish('blocked'); return; }
      const timer = setTimeout(() => finish('blocked'), 5000);
      child.once('exit', () => { clearTimeout(timer); finish('stopped'); });
      if (process.platform === 'win32') execFile('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 4000 }, () => {});
      else try { process.kill(-child.pid, 'SIGTERM'); } catch { clearTimeout(timer); finish('blocked'); }
    });
  });
  child.once('error', () => { server.close(); process.exit(1); });
  child.once('exit', () => {
    exited = true;
  });
  child.once('spawn', () => {
    server.once('error', () => { child.kill(); process.exit(1); });
    server.listen(input.endpoint, () => {
      process.send?.({ ...identity, status: 'running' });
      process.disconnect?.();
    });
  });
});
