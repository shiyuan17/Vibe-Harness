/**
 * Read-only view of the host's Hook trust state.
 *
 * Codex records Hook trust per Hook definition in the host config under
 * `[hooks.state.'<hooks.json 绝对路径>:<事件>:<索引>:<索引>']` with an optional
 * `enabled` flag. Vibe-Harness never writes that file and never echoes the
 * `trusted_hash` value (it is host state, not project state), so this module
 * only answers one question: is the current project's Hook definition trusted
 * and enabled, trusted but disabled, or not trusted at all.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** Host Hook states this module can report, in addition to `unknown`. */
export const HOST_HOOK_STATE_VALUES = ['trusted-enabled', 'trusted-disabled', 'untrusted', 'unknown'];

const HOOK_STATE_SECTION = /^\[\s*hooks\.state\s*\.\s*(['"])(?<key>.*)\1\s*\]$/u;
const ENABLED_FALSE = /^\s*enabled\s*=\s*false\s*$/u;
const ENABLED_TRUE = /^\s*enabled\s*=\s*true\s*$/u;
const TRUSTED_HASH = /^\s*trusted_hash\s*=/u;

/** @param {string} value */
function normalizePath(value) {
  return value.replaceAll('\\', '/').replace(/\/+$/u, '').toLowerCase();
}

/**
 * Host state keys are `<hooks.json 路径>:<事件>:<索引>:<索引>`. Split from the
 * right so Windows drive letters survive.
 *
 * @param {string} key
 * @returns {{ hooksPath: string, event: string, projectEntry: boolean }}
 */
function splitStateKey(key) {
  const parts = key.split(':');
  if (parts.length < 4) return { event: '', hooksPath: key, projectEntry: false };
  const innerIndex = parts.at(-1);
  const outerIndex = parts.at(-2);
  const event = parts.at(-3);
  const hooksPath = parts.slice(0, -3).join(':');
  const projectEntry = /^\d+$/u.test(outerIndex) && /^\d+$/u.test(innerIndex) && Boolean(event);
  return { event, hooksPath, projectEntry };
}

/**
 * @param {string} content
 * @returns {Array<{ key: string, enabled: boolean | null, trusted: boolean }>}
 */
function parseHookStateEntries(content) {
  const entries = [];
  let current = null;
  for (const line of content.split(/\r?\n/u)) {
    const section = HOOK_STATE_SECTION.exec(line);
    if (section) {
      current = { enabled: null, key: section.groups.key, trusted: false };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    if (/^\[/u.test(line)) {
      current = null;
      continue;
    }
    if (TRUSTED_HASH.test(line)) current.trusted = true;
    else if (ENABLED_FALSE.test(line)) current.enabled = false;
    else if (ENABLED_TRUE.test(line)) current.enabled = true;
  }
  return entries;
}

/**
 * @param {{ adapterId?: string, projectDir?: string, env?: Record<string, string | undefined>, homeDir?: string }} options
 * @returns {Promise<{ status: string, reason: string, configPath: string, hooksPath: string, entries: { total: number, enabled: number, disabled: number, trusted: number } }>}
 */
export async function readHostHookState({ adapterId, projectDir, env = process.env, homeDir } = {}) {
  const hooksPath = path.join(projectDir ?? process.cwd(), '.codex', 'hooks.json');
  const codexHome = env.CODEX_HOME && env.CODEX_HOME.trim() ? env.CODEX_HOME : path.join(homeDir || homedir(), '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  const empty = { disabled: 0, enabled: 0, total: 0, trusted: 0 };
  if (adapterId && adapterId !== 'codex') {
    return { configPath, entries: empty, hooksPath, reason: 'not-codex-host', status: 'unknown' };
  }
  let content;
  try {
    content = await readFile(configPath, 'utf8');
  } catch (error) {
    return {
      configPath,
      entries: empty,
      hooksPath,
      reason: error?.code === 'ENOENT' ? 'config-missing' : 'config-unreadable',
      status: 'unknown',
    };
  }
  const expected = normalizePath(hooksPath);
  const projectEntries = parseHookStateEntries(content).filter((entry) => {
    const { hooksPath: entryPath, projectEntry } = splitStateKey(entry.key);
    return projectEntry && normalizePath(entryPath) === expected;
  });
  const entries = {
    disabled: projectEntries.filter((entry) => entry.enabled === false).length,
    enabled: projectEntries.filter((entry) => entry.enabled !== false).length,
    total: projectEntries.length,
    trusted: projectEntries.filter((entry) => entry.trusted).length,
  };
  if (projectEntries.length === 0) {
    return { configPath, entries, hooksPath, reason: 'no-entries', status: 'untrusted' };
  }
  if (entries.disabled === 0) {
    return { configPath, entries, hooksPath, reason: 'entries-enabled', status: 'trusted-enabled' };
  }
  return {
    configPath,
    entries,
    hooksPath,
    reason: entries.enabled === 0 ? 'entries-disabled' : 'entries-partially-disabled',
    status: 'trusted-disabled',
  };
}
