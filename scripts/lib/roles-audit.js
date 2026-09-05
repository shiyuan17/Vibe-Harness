import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseToml } from '@iarna/toml';

import { loadAdapterCatalog } from './adapter.js';
import { assertInsideDir, assertPortableRelativePath, assertSafePathInside } from './manifest.js';
import { loadRolePack, projectRole } from './role-projection.js';

const REQUIRED_ROLE_SECTIONS = ['## 决策方式', '## 质疑重点', '## 交付物', '## 禁止事项'];

function normalizeRoleContent(content) {
  return content.replace(/\r\n?/gu, '\n').trim();
}

export function findDuplicateRoleContents(entries = []) {
  const owners = new Map();
  const duplicates = [];
  for (const entry of entries) {
    const raw = typeof entry === 'string' ? entry : entry.content ?? '';
    const normalized = normalizeRoleContent(raw);
    const id = typeof entry === 'string' ? entry : entry.id ?? normalized;
    const owner = owners.get(normalized);
    if (owner && owner !== id) duplicates.push([owner, id]);
    else owners.set(normalized, id);
  }
  return duplicates;
}

function parseFrontmatter(content, label) {
  if (!content.startsWith('---\n')) throw new Error(label + ' must start with YAML frontmatter.');
  const end = content.indexOf('\n---\n', 4);
  if (end < 0) throw new Error(label + ' has unterminated YAML frontmatter.');
  const header = content.slice(4, end);
  if (!/(?:^|\n)(?:name|description):/u.test(header)) {
    throw new Error(label + ' is missing identifying frontmatter.');
  }
  return header;
}

function auditPermissionProjection(role, adapter, projected) {
  const writable = role.permissionPreset === 'implementation';
  if (adapter.roleProjection.format === 'codex-toml') {
    const parsed = parseToml(projected);
    const expectedSandbox = writable ? 'workspace-write' : 'read-only';
    if (parsed.sandbox_mode !== expectedSandbox) {
      return adapter.id + ' permission mapping for ' + role.id + ' is not restrictive.';
    }
    return null;
  }
  if (adapter.roleProjection.format === 'opencode-markdown') {
    const expectedEdit = writable ? 'allow' : 'deny';
    if (!new RegExp('^  edit: ' + expectedEdit + '$', 'mu').test(projected)) {
      return adapter.id + ' permission mapping for ' + role.id + ' is not restrictive.';
    }
    return null;
  }
  if (adapter.roleProjection.format === 'cursor-markdown') {
    const expectedReadonly = writable ? 'false' : 'true';
    if (!new RegExp('^readonly: ' + expectedReadonly + '$', 'mu').test(projected)) {
      return adapter.id + ' permission mapping for ' + role.id + ' is not restrictive.';
    }
    return null;
  }
  const toolsLine = projected.match(/^tools: (.+)$/mu)?.[1];
  if (!toolsLine) return adapter.id + ' permission mapping for ' + role.id + ' is missing tools.';
  const hasWrite = toolsLine.includes('"Write"');
  if (hasWrite !== writable) return adapter.id + ' permission mapping for ' + role.id + ' is not restrictive.';
  return null;
}

export async function runRolesAudit(rootDir) {
  const errors = [];
  const warnings = [];
  let rolePack;
  try {
    rolePack = await loadRolePack(rootDir);
  } catch (error) {
    return { errors: [error.message], ok: false, roleCount: 0, warnings };
  }

  const routerPath = path.join(rootDir, 'docs', 'rules', 'role-routing.md');
  let router;
  try {
    router = await readFile(routerPath, 'utf8');
  } catch (error) {
    return {
      errors: ['Role routing rule is unavailable at docs/rules/role-routing.md: ' + error.message],
      ok: false,
      roleCount: rolePack.items.length,
      warnings,
    };
  }
  const basePath = path.resolve(rootDir, rolePack.basePrompt);
  assertInsideDir(rootDir, basePath, 'role base prompt');
  await assertSafePathInside(rootDir, basePath, 'role base prompt');
  const basePrompt = await readFile(basePath, 'utf8');
  for (const fragment of ['## 工作方式', '## 权限边界', '## 交付标准']) {
    if (!basePrompt.includes(fragment)) errors.push('Role base prompt is missing ' + fragment + '.');
  }

  const adapters = await loadAdapterCatalog(rootDir);
  const rolePromptOwners = new Map();
  const projectionOwners = new Map();
  for (const role of rolePack.items) {
    try {
      assertPortableRelativePath(role.promptSource, 'role prompt source');
      const source = path.resolve(rootDir, role.promptSource);
      assertInsideDir(rootDir, source, 'role prompt source');
      await assertSafePathInside(rootDir, source, 'role prompt source');
      const rolePrompt = await readFile(source, 'utf8');
      const normalizedPrompt = normalizeRoleContent(rolePrompt);
      const promptOwner = rolePromptOwners.get(normalizedPrompt);
      if (promptOwner && promptOwner !== role.id) {
        errors.push('Roles ' + promptOwner + ' and ' + role.id + ' have duplicate complete role prompt content.');
      } else {
        rolePromptOwners.set(normalizedPrompt, role.id);
      }
      for (const section of REQUIRED_ROLE_SECTIONS) {
        if (!rolePrompt.includes(section)) errors.push('Role ' + role.id + ' is missing ' + section + '.');
      }
      if (role.routing.mode && !['auto', 'explicit'].includes(role.routing.mode)) {
        errors.push('Role ' + role.id + ' has an invalid routing mode.');
      }
      if (!router.includes(role.id)) errors.push('Role router does not mention ' + role.id + '.');
      const compiled = {
        ...role,
        prompt: basePrompt.trim() + '\n\n' + rolePrompt.trim() + '\n',
      };
      for (const adapter of adapters.items) {
        const first = projectRole(compiled, adapter);
        const second = projectRole(compiled, adapter);
        const projectionKey = adapter.id + '\u0000' + normalizeRoleContent(first);
        const projectionOwner = projectionOwners.get(projectionKey);
        if (projectionOwner && projectionOwner !== role.id) {
          errors.push(adapter.id + ' roles ' + projectionOwner + ' and ' + role.id + ' have duplicate complete role projections.');
        } else {
          projectionOwners.set(projectionKey, role.id);
        }
        if (first !== second) errors.push(adapter.id + ' projection for ' + role.id + ' is not deterministic.');
        if (adapter.roleProjection.format === 'codex-toml') {
          const parsed = parseToml(first);
          if (parsed.name !== role.id || typeof parsed.developer_instructions !== 'string') {
            errors.push('Codex projection for ' + role.id + ' is missing required fields.');
          }
        } else {
          parseFrontmatter(first, adapter.id + ' projection for ' + role.id);
        }
        const permissionError = auditPermissionProjection(role, adapter, first);
        if (permissionError) errors.push(permissionError);
      }
    } catch (error) {
      errors.push(error.message);
    }
  }

  return {
    errors: [...new Set(errors)].sort(),
    ok: errors.length === 0,
    roleCount: rolePack.items.length,
    warnings,
  };
}

export function renderRolesAudit(report) {
  const lines = [
    'Role audit: ' + (report.ok ? 'ok' : 'failed'),
    'Built-in roles: ' + report.roleCount,
    'Errors: ' + report.errors.length,
    'Warnings: ' + report.warnings.length,
  ];
  for (const error of report.errors) lines.push('- ERROR ' + error);
  for (const warning of report.warnings) lines.push('- WARN ' + warning);
  return lines.join('\n') + '\n';
}
