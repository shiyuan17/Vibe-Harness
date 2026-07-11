import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { validateJsonAgainstSchema } from './schema-validation.mjs';

function validateEntries(tasks, { crossRepoEnabled = false } = {}) {
  const errors = [];
  for (const task of tasks) {
    const owner = task.id ?? '<unknown task>';
    if (task.status === 'blocked' && !task.blockedReason?.trim()) errors.push(`${owner} blocked status requires blockedReason`);
    if (['blocked', 'waiting_human', 'waiting_dependency'].includes(task.status) && !task.resumeHint?.trim()) errors.push(`${owner} resumable status requires resumeHint`);
    if (task.risk === 'high' && task.resolution === 'open' && task.packetTier === 'Lightweight' && task.implementTier !== 'Full') errors.push(`${owner} high-risk Lightweight task requires implementTier=Full`);
    if (task.resolution === 'done' && task.phase !== 'done') errors.push(`${owner} resolution=done requires phase=done`);
    if (task.resolution === 'done' && Array.isArray(task.children) && task.children.some((child) => child.resolution !== 'done')) errors.push(`${owner} cannot complete while child tasks remain open`);
    if (task.resolution === 'done' && !['complete', 'not_required'].includes(task.mergeBackStatus)) errors.push(`${owner} done task requires mergeBackStatus=complete or not_required`);
    if (task.resolution === 'done' && task.risk === 'high' && (!task.verifier?.trim() || task.verifier === 'implementation-agent')) errors.push(`${owner} high-risk done task requires an independent verifier`);
    if (task.resolution === 'done' && task.crossRepoEvidence && !task.crossRepoEvidence.resultSummary?.trim()) errors.push(`${owner} done cross-repo task requires crossRepoEvidence.resultSummary`);
    if (crossRepoEnabled && !task.crossRepoEvidence) errors.push(`${owner} cross-repo project task requires crossRepoEvidence`);
    if (task.resolution === 'open' && task.crossRepoEvidence) {
      const fields = ['backendRef', 'endpoint', 'verifyCommand', 'resultSummary'].filter((field) => task.crossRepoEvidence[field]?.trim());
      if (fields.length < 3) errors.push(`${owner} open cross-repo task requires at least three structured evidence fields`);
    }
  }
  return errors;
}

function collectTaskManifests(root, schema) {
  const tasksRoot = resolve(root, 'docs/tasks');
  if (!existsSync(tasksRoot)) return { errors: [], tasks: [] };
  const tasks = [];
  const errors = [];
  for (const entry of readdirSync(tasksRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name !== 'task.json') continue;
    const file = resolve(entry.parentPath ?? entry.path, entry.name);
    try {
      const task = JSON.parse(readFileSync(file, 'utf8'));
      tasks.push(task);
      errors.push(...validateJsonAgainstSchema(task, schema, `task ${task.id ?? '<unknown>'}`));
    } catch (error) {
      errors.push(`Invalid JSON: ${file}: ${error.message}`);
    }
  }
  return { errors, tasks };
}

export function validateTasks(root) {
  const backlogPath = resolve(root, 'backlog.json');
  const backlogTasks = [];
  const errors = [];
  let crossRepoEnabled = false;
  const configPath = resolve(root, 'loopengine.config.json');
  if (existsSync(configPath)) {
    try {
      crossRepoEnabled = JSON.parse(readFileSync(configPath, 'utf8')).crossRepo?.enabled === true;
    } catch (error) {
      errors.push(`Invalid JSON: loopengine.config.json: ${error.message}`);
    }
  }
  if (existsSync(backlogPath)) {
    try {
      const backlog = JSON.parse(readFileSync(backlogPath, 'utf8'));
      backlogTasks.push(...(Array.isArray(backlog) ? backlog : (backlog.tasks ?? backlog.items ?? [])));
    } catch (error) {
      errors.push(`Invalid JSON: backlog.json: ${error.message}`);
    }
  }
  let schema;
  try {
    schema = JSON.parse(readFileSync(resolve(root, 'docs/schemas/task.schema.json'), 'utf8'));
  } catch (error) {
    return [...errors, `Invalid task schema: ${error.message}`];
  }
  const manifests = collectTaskManifests(root, schema);
  return [
    ...errors,
    ...manifests.errors,
    ...validateEntries(backlogTasks, { crossRepoEnabled }),
    ...validateEntries(manifests.tasks, { crossRepoEnabled }),
  ];
}
