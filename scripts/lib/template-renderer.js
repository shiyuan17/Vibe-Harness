import { readFileSync } from 'node:fs';

// The Hook bootstrap is a real CommonJS file so it can be read, reviewed, and
// executed on its own; the installed hooks.json embeds its text as the payload
// of `node -e`. Every host runs that command through its own shell, so the
// payload may only contain characters that survive cmd.exe, PowerShell, and sh
// verbatim: a double quote, backslash, backtick, dollar sign, percent sign, or
// line break would be re-interpreted before Node ever sees the script. The
// whitelist below is therefore a hard gate, not a style preference.
//
// The placeholder is substituted into JSON templates as raw text, so the two
// quotes that wrap the payload are emitted JSON-escaped (\" rather than ").
// The host unescapes them while parsing hooks.json, which is what finally hands
// the shell a quoted `node -e "<payload>"` command.
const hookBootstrapSourcePath = new URL('./hook-bootstrap.cjs', import.meta.url);
const hookBootstrapForbiddenPattern = /["\\`$%\r\n]/u;

function renderHookBootstrapCommand() {
  const source = readFileSync(hookBootstrapSourcePath, 'utf8').replace(/\r?\n$/u, '');
  const forbidden = source.match(hookBootstrapForbiddenPattern);
  if (forbidden) {
    throw new Error(
      'Hook bootstrap payload contains a shell-unsafe character: ' + JSON.stringify(forbidden[0])
      + ' (see scripts/lib/hook-bootstrap.cjs).',
    );
  }
  return 'node -e \\"' + source + '\\" --';
}

export const hookBootstrapCommand = renderHookBootstrapCommand();

const defaultTemplateData = {
  codebaseMemoryStateDirectory: '.vibe-harness',
  hookBootstrapCommand,
  installedSurface: {
    clarificationPostureLine: '',
    codebaseMemoryMcpLine: '',
    discoveryLine: '使用仓库搜索和已安装规则定位相关代码；需要结构化索引时先确认目标项目已有能力。',
    hooksLine: '',
    memoryLoadLine: '',
    memorySkillsLine: '',
    profileLine: '- 当前 profile 使用 Vibe-Harness Codex 安装面。',
    responseModeLine: '',
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
    verificationSummary: '快速层：未配置；中等层：未配置；深度层：未配置',
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
    tiers: {
      quick: [],
      standard: [],
      deep: [],
    },
  },
};

export const managedInstructionBlockStart = '<!-- VIBE_HARNESS:START -->';
export const managedInstructionBlockEnd = '<!-- VIBE_HARNESS:END -->';

/** @param {unknown} value */
function renderListValue(value) {
  if (value === null || value === undefined) return '未配置';
  // Tier placeholders hold command arrays; an empty array is the explicit
  // "not configured" state rather than a rendered `[]`.
  if (Array.isArray(value)) {
    return value.length > 0 ? value.map((item) => String(item)).join('、') : '未配置';
  }
  return String(value);
}

/**
 * The instruction sections every adapter's template shares verbatim.
 *
 * Codex, Claude, Gemini and opencode each render their own instruction file,
 * but the hard bounds, the verify semantics and the rule-priority paragraph are
 * the same resident text in all of them. Keeping one copy here means a change
 * lands once instead of four times, which is what let the four templates drift
 * apart silently before. Host-specific bullets (for example Claude's Hook
 * activation note) stay in the host's own template next to the shared line.
 *
 * @param {{validationCommands?: {tiers?: {quick?: string[], standard?: string[], deep?: string[]}}}} data
 */
export function buildManagedInstructionSections(data = {}) {
  const tick = String.fromCharCode(96);
  const tiers = data.validationCommands?.tiers ?? {};
  return {
    hardBoundsLines: [
      '- 只在授权范围内行动；红区、生产、权限、凭据、外部写入和不可逆操作按 governance-core 的授权与批准规则执行；缺少覆盖授权时人工确认，已有覆盖授权不重复确认。',
      '- 不编造事实或证据；没有本轮有效验证不得声称完成。',
      '- 任务记录是可选的人读文档，不触发测试、Review、子 Agent 或完成门禁。',
    ].join('\n'),
    rulesPriorityLine: '规则优先级：平台系统与用户本轮指令优先；目标项目明确的本地规则优先于 Vibe-Harness 默认规则，'
      + '但不得让渡 governance-core 硬边界中的授权规则、红区与证据标准（本地规则只能收紧，不能放宽或取代）；'
      + '目录级规则只作用于其子树。先按优先级、适用范围和当前明确指令解析冲突；仅对仍影响结果且无法解决的实质冲突请求澄清。'
      + '统一优先级矩阵见 ' + tick + 'docs/rules/governance-core.md' + tick + ' 的硬边界节。',
    verifySemanticsLine: tick + 'vibe-harness validate --project' + tick + ' 只检查安装一致性；'
      + tick + 'vibe-harness verify --project <path>' + tick + ' 默认只执行快速层（开发中同步，失败阻塞当前实施单元）'
      + renderListValue(tiers.quick) + '；中等层（阶段或合并前，' + renderListValue(tiers.standard)
      + '）与深度层（异步或发布边界，' + renderListValue(tiers.deep)
      + '）必须显式升级 ' + tick + '--tier standard|deep' + tick + '，' + tick + '--full' + tick
      + ' 运行完整矩阵。快速层通过时收据标注部分范围并给出下一层入口，未取得被延迟层的证据前不得宣称集成、发布或整体完成；'
      + '深度层可由项目 CI 或独立 worktree 异步完成。测试范围细则见 ' + tick + 'docs/rules/test-rules.md' + tick + '。',
  };
}

function buildStartupLines(surface, projectProfile) {
  const tick = String.fromCharCode(96);
  // The long-task anchor line names the installed entry point when the project
  // carries the runtime commands; a project without them falls back to the
  // last delivery record as the recovery baseline.
  const anchorLine = surface.hasProjectScripts
    ? '长任务（预计执行超过 60 分钟，或发生第一次上下文压缩）先用 '
      + tick + 'node .agents/runtime/commands/run.mjs task init --project <path> --write' + tick
      + ' 建立状态锚点（锚点与收据位于 ' + tick + '.vibe-harness/tasks/' + tick
      + '；阶段推进用 ' + tick + 'task update' + tick
      + '，重复验证用 ' + tick + 'run.mjs verify --reuse' + tick
      + '；已建锚点后再次压缩必须先更新锚点再继续写入）；命中 Skill 触发场景时先读该 Skill 的 ' + tick + 'SKILL.md' + tick + ' 再行动。'
    : '长任务（预计执行超过 60 分钟，或发生第一次上下文压缩）先建立状态锚点，项目未提供锚点入口时以最后一次交付记录充当恢复基准；已建锚点后再次压缩必须先更新锚点再继续写入；命中 Skill 触发场景时先读该 Skill 的 '
      + tick + 'SKILL.md' + tick + ' 再行动。';
  const lines = [
    '先读取 ' + tick + 'docs/rules/governance-core.md' + tick + ' 顶部的 Fast Path 卡片；仅当任务超出快速档或命中升级触发时读取全文。只有出现 Skill 或专项领域信号时再读取 ' + tick + 'docs/rules/agent-skill-routing.md' + tick + ' 和一个命中的专项规则。',
    anchorLine,
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
  const validationCommands = {
    ...defaultTemplateData.validationCommands,
    ...(data.validationCommands ?? {}),
    // Tiers are merged per key: a caller that supplies one tier (or none)
    // must still render the other labels instead of failing the render.
    tiers: {
      ...defaultTemplateData.validationCommands.tiers,
      ...(data.validationCommands?.tiers ?? {}),
    },
  };
  return {
    ...defaultTemplateData,
    ...data,
    installedSurface,
    managedBlock: {
      ...buildManagedInstructionSections({ validationCommands }),
      ...(data.managedBlock ?? {}),
    },
    projectProfile: {
      ...defaultTemplateData.projectProfile,
      ...(data.projectProfile ?? {}),
      logging: {
        ...defaultTemplateData.projectProfile.logging,
        ...(data.projectProfile?.logging ?? {}),
      },
    },
    validationCommands,
  };
}

export function renderTemplate(template, data = {}) {
  const resolvedData = withDefaultTemplateData(data);
  const placeholderPattern = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/gu;
  const rendered = template.split('\n').flatMap((line) => {
    let substituted = false;
    const value = line.replaceAll(placeholderPattern, (match, expression) => {
      substituted = true;
      return resolvePlaceholder(resolvedData, expression);
    });
    // A line that carries only placeholders and renders to nothing would leave
    // a blank line in the resident instructions. The hosts pay for every line
    // they load, so the whole line is dropped instead of emitting an empty one.
    if (substituted && value.trim() === '') return [];
    return [value];
  }).join('\n');
  if (template.includes('installedSurface.startupLines')) {
    return rendered.replace(/\n## 启动\n[\s\S]*?\n## 硬边界\n/u, '\n## 启动\n' + resolvedData.installedSurface.startupLines + '\n## 硬边界\n');
  }
  return rendered;
}

function resolvePlaceholder(resolvedData, expression) {
  const value = lookup(resolvedData, expression);
  if (value === undefined) {
    throw new Error(`Missing template variable: ${expression}`);
  }
  return renderListValue(value);
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
