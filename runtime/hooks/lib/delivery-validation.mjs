const PLACEHOLDER = /^(?:todo|tbd|n\s*\/\s*a|待补充|待填写|\.\.\.|…|<[^>]+>)\.?$/iu;
const RESULT = /^(?:完成|未完成|阻塞|中断|completed|incomplete|blocked|interrupted)[。.]?$/iu;
const DELIVERY_FIELDS = [
  { label: '结果状态', names: ['结果状态', 'Result status'], validate: (value) => RESULT.test(value) },
  { label: '变更摘要', names: ['变更摘要', 'Change summary'] },
  { label: '影响范围', names: ['影响范围', 'Impact scope'] },
  { label: '工作流档位', names: ['工作流档位', 'Workflow tier'] },
  { label: '验证证据', names: ['验证证据', 'Verification evidence'] },
  { label: '未验证项', names: ['未验证项', 'Unverified item', 'Unverified items'] },
  { label: '剩余风险', names: ['剩余风险', 'Residual risk', 'Residual risks'] },
  { label: 'Git 状态', names: ['Git 状态', 'Git status'] },
  {
    label: 'Worktree / 分支 / merge-back 状态',
    names: ['Worktree / 分支 / merge-back 状态', 'Worktree / branch / merge-back status'],
  },
  { label: '后续动作', names: ['后续动作', 'Next step', 'Next steps'] },
  { label: 'Memory', names: ['Memory'] },
];

function stripNonEvidenceMarkdown(message) {
  const withoutComments = message.replace(/<!--[\s\S]*?-->/gu, '');
  const output = [];
  let fence = null;
  let htmlBlock = null;
  for (const line of withoutComments.split(/\r?\n/u)) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/u);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence) continue;
    if (htmlBlock) {
      if (new RegExp(`</${htmlBlock}\\s*>`, 'iu').test(line)) htmlBlock = null;
      continue;
    }
    const htmlStart = line.match(/^\s*<(?:div|details|summary|table|pre|section|article)\b/iu);
    if (htmlStart) {
      htmlBlock = htmlStart[0].match(/<([a-z]+)/iu)?.[1] ?? null;
      continue;
    }
    if (/^(?:\t| {4}|\s*>|\s*<)/u.test(line)) continue;
    output.push(line);
  }
  return output.join('\n');
}

function fieldValue(body, names) {
  for (const line of body.split(/\r?\n/u)) {
    const normalized = line.replace(/^\s*[-*]\s*/u, '').trim();
    for (const name of names) {
      const prefix = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*[:：]\\s*`, 'iu');
      if (!prefix.test(normalized)) continue;
      return normalized.replace(prefix, '').trim();
    }
  }
  return '';
}

export function validateDeliveryMessage(message) {
  const body = stripNonEvidenceMarkdown(typeof message === 'string' ? message : '');
  const missing = [];
  for (const field of DELIVERY_FIELDS) {
    const value = fieldValue(body, field.names);
    if (!value || PLACEHOLDER.test(value) || (field.validate && !field.validate(value))) missing.push(field.label);
  }
  return { ok: missing.length === 0, missing };
}
