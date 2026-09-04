const defaultTemplateData = {
  codebaseMemoryStateDirectory: '.vibe-harness',
  hookBootstrapCommand: 'node -e \\"const{spawnSync}=require(\'node:child_process\'),path=require(\'node:path\');const root=spawnSync(\'git\',[\'rev-parse\',\'--show-toplevel\'],{encoding:\'utf8\'});if(root.error||root.status!==0||!root.stdout.trim()){process.stderr.write(\'Vibe-Harness Hook requires a Git worktree root.\');process.exit(root.status||1)}const hook=path.join(root.stdout.trim(),\'.agents\',\'runtime\',\'hooks\',\'codex-hook.mjs\');const env={...process.env,VIBE_HARNESS_GIT_ROOT:root.stdout.trim()};const child=spawnSync(process.execPath,[hook,...process.argv.slice(1)],{stdio:\'inherit\',env});if(child.error){process.stderr.write(\'Vibe-Harness Hook bootstrap failed.\');process.exit(1)}process.exit(child.status??1)\\" --',
  installedSurface: {
    clarificationPostureLine: '',
    codebaseMemoryMcpLine: '',
    discoveryLine: '使用仓库搜索和已安装规则定位相关代码；需要结构化索引时先确认目标项目已有能力。',
    engineeringRulesLine: '',
    hooksLine: '',
    memoryLoadLine: '',
    memorySkillsLine: '',
    operationalRulesLine: '',
    profileLine: '- 当前 profile 使用 Vibe-Harness Codex 安装面。',
    reviewLoopLine: '',
    rulesLine: '- 规则位于 `docs/rules/`。',
    skillRoutingLine: '',
    skillsLine: '',
    templatesLine: '- 模板位于 `docs/templates/`。',
    toolingLine: '',
  },
  packageManager: 'pnpm',
  projectProfile: {
    codingStandards: '未发现专用 lint/format 配置；沿用仓库现有代码风格并保持最小改动。',
    directoryGuidance: '未发现显式模块清单；按现有目录职责就近修改。',
    packageManager: 'pnpm',
    reviewGuidance: '按风险与改动范围选择验证方式，并明确未覆盖路径。',
    stackSummary: '未识别到主技术栈；以目标项目现有文件为准。',
    vcsStatusCommand: 'git status --short',
    vcsStatusInstruction: '编辑前运行 `git status --short`，保护用户未归属改动。',
    vcsSummary: '未识别 VCS',
    verificationSummary: '使用目标项目配置的验证命令，并补充聚焦测试或人工核对证据。',
    logging: {
      status: 'unknown',
      evidenceSummary: '实现：未发现；配置：未发现；查询：未发现；关联字段：未发现',
      contractSummary: '实现：未发现；配置：未发现；来源：未发现；查询：未发现；关联字段：未发现；验证：未发现',
    },
  },
  projectName: 'target project',
  validationCommands: {
    lint: '未配置',
    typecheck: '未配置',
    test: '未配置',
    eval: '未配置',
  },
};

export const managedInstructionBlockStart = '<!-- VIBE_HARNESS:START -->';
export const managedInstructionBlockEnd = '<!-- VIBE_HARNESS:END -->';

function buildStartupLines(surface, projectProfile) {
  const tick = String.fromCharCode(96);
  const lines = [
    '先读取 ' + tick + 'docs/rules/governance-core.md' + tick + '；只有出现 Skill 或专项领域信号时再读取 ' + tick + 'docs/rules/AGENT_SKILL_ROUTING.md' + tick + ' 和一个命中的专项规则。',
  ];
  if (surface.memoryLoadLine) lines.push(surface.memoryLoadLine);
  if (projectProfile.vcsStatusInstruction) lines.push(projectProfile.vcsStatusInstruction);
  if (surface.discoveryLine) lines.push(surface.discoveryLine);
  lines.push(
    '将任务归为快速、轻量或完整，并选择与主张匹配的验证。',
    '使用“获取可信事实 → 判定并执行 → 聚焦验证 → 简洁交付”的单一路径；宿主按 description 直接选择领域 Skill。',
  );
  return lines.map((line, index) => String(index + 1) + '. ' + line).join('\n');
}

const managedInstructionBlockPattern = /<!-- VIBE_HARNESS:START -->[\s\S]*?<!-- VIBE_HARNESS:END -->\n?/u;

function lookup(data, expression) {
  return expression.split('.').reduce((value, key) => {
    if (value && Object.hasOwn(value, key)) {
      return value[key];
    }
    return undefined;
  }, data);
}

export function withDefaultTemplateData(data = {}) {
  const installedSurface = {
    ...defaultTemplateData.installedSurface,
    ...(data.installedSurface ?? {}),
  };
  if (!installedSurface.startupLines) {
    installedSurface.startupLines = buildStartupLines(installedSurface, {
      ...defaultTemplateData.projectProfile,
      ...(data.projectProfile ?? {}),
    });
  }
  return {
    ...defaultTemplateData,
    ...data,
    installedSurface,
    projectProfile: {
      ...defaultTemplateData.projectProfile,
      ...(data.projectProfile ?? {}),
      logging: {
        ...defaultTemplateData.projectProfile.logging,
        ...(data.projectProfile?.logging ?? {}),
      },
    },
    validationCommands: {
      ...defaultTemplateData.validationCommands,
      ...(data.validationCommands ?? {}),
    },
  };
}

export function renderTemplate(template, data = {}) {
  const resolvedData = withDefaultTemplateData(data);
  const rendered = template.replaceAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/gu, (match, expression) => {
    const value = lookup(resolvedData, expression);
    if (value === undefined) {
      throw new Error(`Missing template variable: ${expression}`);
    }
    if (value === null) {
      return '未配置';
    }
    return String(value);
  });
  if (template.includes('installedSurface.startupLines')) {
    return rendered.replace(/\n## 启动\n[\s\S]*?\n## 硬边界\n/u, '\n## 启动\n' + resolvedData.installedSurface.startupLines + '\n## 硬边界\n');
  }
  return rendered;
}

export function hasIncompleteManagedInstructionBlock(content = '') {
  return content.includes(managedInstructionBlockStart) !== content.includes(managedInstructionBlockEnd);
}

function managedInstructionMatch(content = '') {
  const canonical = content.match(managedInstructionBlockPattern);
  return canonical
    ? { end: managedInstructionBlockEnd, match: canonical, pattern: managedInstructionBlockPattern, start: managedInstructionBlockStart }
    : null;
}

export function renderManagedInstructionBlock(content) {
  return `${managedInstructionBlockStart}\n${String(content).trimEnd()}\n${managedInstructionBlockEnd}\n`;
}

export function extractManagedInstructionBlock(content = '') {
  const found = managedInstructionMatch(content);
  return found ? renderManagedInstructionBlock(found.match[0]
    .replace(found.start, '')
    .replace(found.end, '')
    .trim()) : null;
}

export function removeManagedInstructionBlock(content = '') {
  if (hasIncompleteManagedInstructionBlock(content)) {
    throw new Error('Instruction file contains an incomplete Vibe-Harness managed block.');
  }
  const found = managedInstructionMatch(content);
  if (!found) return content;
  const { match } = found;
  const start = match.index > 0 && content[match.index - 1] === '\n' ? match.index - 1 : match.index;
  const remaining = `${content.slice(0, start)}${content.slice(match.index + match[0].length)}`.trimEnd();
  return remaining ? `${remaining}\n` : '';
}

export function mergeManagedInstructionBlock(existingContent, managedContent) {
  if (hasIncompleteManagedInstructionBlock(existingContent)) {
    throw new Error('Instruction file contains an incomplete Vibe-Harness managed block.');
  }

  const managedBlock = renderManagedInstructionBlock(managedContent);
  if (!existingContent || existingContent.trim().length === 0) {
    return managedBlock;
  }

  const found = managedInstructionMatch(existingContent);
  if (found) {
    return existingContent.replace(found.pattern, managedBlock);
  }

  const separator = existingContent.endsWith('\n')
    ? (existingContent.endsWith('\n\n') ? '' : '\n')
    : '\n\n';
  return `${existingContent}${separator}${managedBlock}`;
}
