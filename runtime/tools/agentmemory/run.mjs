#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const allowedEnvironmentNames = new Set([
  'ALL_PROXY', 'APPDATA', 'COMSPEC', 'HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'LANG', 'LC_ALL',
  'LC_CTYPE', 'LOCALAPPDATA', 'NO_PROXY', 'PATH', 'Path', 'PATHEXT', 'PROGRAMDATA', 'ProgramData',
  'SHELL', 'SSL_CERT_DIR', 'SSL_CERT_FILE', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE',
  'WINDIR', 'all_proxy', 'https_proxy', 'http_proxy', 'no_proxy',
]);
for (const name of Object.keys(process.env)) {
  if (!allowedEnvironmentNames.has(name) && !name.startsWith('AGENTMEMORY_')) delete process.env[name];
}
await import(pathToFileURL(path.join(toolDir, 'node_modules/@agentmemory/mcp/bin.mjs')));
