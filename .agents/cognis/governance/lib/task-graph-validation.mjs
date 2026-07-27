import path from 'node:path';

const TERMINAL_RESULTS = new Set(['completed', 'wont_do', 'duplicate', 'cancelled']);

function isVersioned(document) {
  return [2, 3].includes(document.control?.['控制版本']);
}

function taskKind(document) {
  return document.control?.['任务类型'];
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function normalizedScope(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replaceAll('\\', '/')
    .replace(/\/+/gu, '/')
    .replace(/\/\*\*$/u, '')
    .replace(/\/$/u, '')
    .toLocaleLowerCase('en-US');
  return normalized;
}

function scopesOverlap(left, right) {
  const leftPath = normalizedScope(left);
  const rightPath = normalizedScope(right);
  if (!leftPath || !rightPath) return false;
  return leftPath === rightPath || leftPath.startsWith(`${rightPath}/`) || rightPath.startsWith(`${leftPath}/`);
}

function evidenceTime(row) {
  const timestamp = Date.parse(row?.['核验时间']);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function hasSuccessfulCommandEvidence(document, command, minimumTime) {
  return list(document.evidence).some((row) => row?.['证据类型'] === '命令'
    && row?.['命令或产物'] === command
    && String(row?.['退出码']) === '0'
    && evidenceTime(row) !== null
    && evidenceTime(row) >= minimumTime);
}

function duplicateIds(documents) {
  const groups = new Map();
  for (const document of documents) {
    if (!document.id) continue;
    groups.set(document.id, [...(groups.get(document.id) ?? []), document]);
  }
  return [...groups.entries()]
    .filter(([, matches]) => matches.length > 1 && matches.some(isVersioned))
    .map(([id]) => id);
}

function findDependencyCycles(documents) {
  const ids = new Set(documents.map((document) => document.id));
  const visiting = new Set();
  const visited = new Set();
  const cycles = [];

  function visit(id, trail) {
    if (visiting.has(id)) {
      const start = trail.indexOf(id);
      cycles.push([...trail.slice(start), id]);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const document = documents.find((candidate) => candidate.id === id);
    for (const dependency of list(document?.control?.['依赖任务'])) {
      if (ids.has(dependency)) visit(dependency, [...trail, id]);
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const document of documents) visit(document.id, []);
  return cycles;
}

function validateParent(parent, byId) {
  const errors = [];
  const childIds = list(parent.control?.['子任务']);
  const batches = list(parent.control?.['执行批次']);
  const children = childIds.map((id) => byId.get(id)).filter(Boolean);
  const batchOccurrences = new Map();
  const batchIndex = new Map();

  for (const [index, batch] of batches.entries()) {
    for (const id of list(batch)) {
      batchOccurrences.set(id, (batchOccurrences.get(id) ?? 0) + 1);
      if (!batchIndex.has(id)) batchIndex.set(id, index);
      if (!childIds.includes(id)) errors.push(`${parent.source.path}：执行批次引用未声明的子任务 ${id}`);
    }
  }
  for (const id of childIds) {
    if ((batchOccurrences.get(id) ?? 0) !== 1) errors.push(`${parent.source.path}：子任务 ${id} 必须在执行批次中恰好一次`);
    const child = byId.get(id);
    if (!child) {
      errors.push(`${parent.source.path}：子任务 ${id} 不存在`);
      continue;
    }
    if (!isVersioned(child) || taskKind(child) !== '子任务') errors.push(`${parent.source.path}：${id} 必须是 v2/v3 子任务`);
    if (child.control?.['父任务编号'] !== parent.id) errors.push(`${parent.source.path}：子任务 ${id} 未反向声明父任务 ${parent.id}`);
  }

  const childSet = new Set(childIds);
  for (const child of children) {
    const dependencies = list(child.control?.['依赖任务']);
    const conflicts = list(child.control?.['冲突任务']);
    for (const dependency of dependencies) {
      if (!childSet.has(dependency)) {
        errors.push(`${child.source.path}：依赖任务 ${dependency} 不存在或不属于同一父任务`);
        continue;
      }
      const dependencyBatch = batchIndex.get(dependency);
      const childBatch = batchIndex.get(child.id);
      if (dependencyBatch !== undefined && childBatch !== undefined && dependencyBatch >= childBatch) {
        errors.push(`${child.source.path}：依赖任务 ${dependency} 必须位于更早的执行批次`);
      }
    }
    for (const conflict of conflicts) {
      if (!childSet.has(conflict)) {
        errors.push(`${child.source.path}：冲突任务 ${conflict} 不存在或不属于同一父任务`);
        continue;
      }
      const peer = byId.get(conflict);
      if (!list(peer?.control?.['冲突任务']).includes(child.id)) {
        errors.push(`${child.source.path}：与 ${conflict} 的冲突关系必须对称声明`);
      }
      if (batchIndex.get(conflict) !== undefined && batchIndex.get(conflict) === batchIndex.get(child.id)) {
        errors.push(`${parent.source.path}：冲突任务 ${child.id} 与 ${conflict} 不得位于同一执行批次`);
      }
    }
    const batch = batches[batchIndex.get(child.id)];
    if (child.control?.['并行安全'] === '独占写入' && list(batch).length > 1) {
      errors.push(`${child.source.path}：独占写入子任务不得与其他任务位于同一执行批次`);
    }
  }

  for (let leftIndex = 0; leftIndex < children.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < children.length; rightIndex += 1) {
      const left = children[leftIndex];
      const right = children[rightIndex];
      const overlap = list(left.control?.['写入范围']).some((leftScope) => list(right.control?.['写入范围'])
        .some((rightScope) => scopesOverlap(leftScope, rightScope)));
      if (!overlap) continue;
      const leftDeclares = list(left.control?.['冲突任务']).includes(right.id);
      const rightDeclares = list(right.control?.['冲突任务']).includes(left.id);
      if (!leftDeclares || !rightDeclares) {
        errors.push(`${parent.source.path}：写入范围重叠的 ${left.id} 与 ${right.id} 必须对称声明冲突`);
      }
      if (batchIndex.get(left.id) !== undefined && batchIndex.get(left.id) === batchIndex.get(right.id)) {
        errors.push(`${parent.source.path}：写入范围重叠的 ${left.id} 与 ${right.id} 不得位于同一执行批次`);
      }
    }
  }

  if (parent.result === 'completed') {
    const completedChildEvidence = children
      .filter((child) => child.result === 'completed')
      .flatMap((child) => list(child.evidence).map(evidenceTime).filter((value) => value !== null));
    const minimumIntegrationTime = completedChildEvidence.length > 0 ? Math.max(...completedChildEvidence) : 0;
    for (const child of children) {
      if (!TERMINAL_RESULTS.has(child.result)) errors.push(`${parent.source.path}：子任务 ${child.id} 尚未终结`);
      if (child.control?.['合并回主线状态'] === '待处理') errors.push(`${parent.source.path}：子任务 ${child.id} 仍有待处理的合并回主线状态`);
      if (child.result === 'completed' && list(child.evidence).every((row) => evidenceTime(row) === null)) {
        errors.push(`${parent.source.path}：已完成子任务 ${child.id} 缺少带核验时间的完成证据`);
      }
    }
    for (const command of list(parent.control?.['集成验证'])) {
      if (!hasSuccessfulCommandEvidence(parent, command, minimumIntegrationTime)) {
        errors.push(`${parent.source.path}：集成验证缺少 fan-in 后的本轮成功证据：${command}`);
      }
    }
    if (parent.control?.['红队审查结论'] !== '批准'
      || !parent.control?.['红队审查者']
      || parent.control?.['红队审查者'] === parent.control?.['责任角色']) {
      errors.push(`${parent.source.path}：父任务完成前最终 diff 必须获得独立审查批准`);
    }
  }
  return errors;
}

export function validateTaskGraph(documents) {
  const versionedDocuments = documents.filter(isVersioned);
  if (versionedDocuments.length === 0) return [];
  const errors = [];
  const byId = new Map();
  for (const document of documents) if (document.id && !byId.has(document.id)) byId.set(document.id, document);

  for (const id of duplicateIds(documents)) errors.push(`任务编号 ${id} 重复`);
  for (const document of versionedDocuments) {
    const basename = path.basename(document.source.path, path.extname(document.source.path));
    if (basename !== document.id) errors.push(`${document.source.path}：文件名 ${basename} 必须与任务编号 ${document.id} 一致`);
    for (const dependency of list(document.control?.['依赖任务'])) {
      if (!byId.has(dependency)) errors.push(`${document.source.path}：依赖任务 ${dependency} 不存在`);
    }
    for (const conflict of list(document.control?.['冲突任务'])) {
      const peer = byId.get(conflict);
      if (!peer) {
        errors.push(`${document.source.path}：冲突任务 ${conflict} 不存在`);
      } else if (!list(peer.control?.['冲突任务']).includes(document.id)) {
        errors.push(`${document.source.path}：与 ${conflict} 的冲突关系必须对称声明`);
      }
    }
    if (document.result === 'completed') {
      for (const dependency of list(document.control?.['依赖任务'])) {
        if (byId.get(dependency)?.result !== 'completed') errors.push(`${document.source.path}：依赖任务 ${dependency} 尚未完成`);
      }
    }
    if (taskKind(document) === '子任务') {
      const parentId = document.control?.['父任务编号'];
      const parent = byId.get(parentId);
      if (!parent) {
        errors.push(`${document.source.path}：父任务 ${parentId} 不存在`);
      } else if (!isVersioned(parent) || taskKind(parent) !== '父任务') {
        errors.push(`${document.source.path}：父任务 ${parentId} 必须是“父任务”类型的 v2/v3 合同`);
      } else if (!list(parent.control?.['子任务']).includes(document.id)) {
        errors.push(`${document.source.path}：父任务 ${parentId} 未声明子任务 ${document.id}`);
      }
      if (document.result === 'completed') {
        if (document.control?.['合并回主线状态'] === '待处理') {
          errors.push(`${document.source.path}：完成的子任务仍有待处理的合并回主线状态`);
        }
      }
    }
  }
  for (const cycle of findDependencyCycles(versionedDocuments)) {
    errors.push(`v2/v3 任务依赖环 ${cycle.join(' -> ')}`);
  }
  for (const parent of versionedDocuments.filter((document) => taskKind(document) === '父任务')) {
    errors.push(...validateParent(parent, byId));
  }
  return errors;
}
