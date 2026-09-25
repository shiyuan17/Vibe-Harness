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
 * Every sentence here is resident context on every turn, so the sections stay
 * summaries: the normative detail lives in `docs/rules/governance-core.md` and
 * `docs/rules/test-rules.md`, and each line keeps only the decision an agent
 * must make without opening a rule file. Re-expanding them costs tokens on
 * every request and is what the resident line budget exists to prevent.
 *
 *
 * @param {{validationCommands?: {tiers?: {quick?: string[], standard?: string[], deep?: string[]}}}} data
 */
export function buildManagedInstructionSections(data = {}) {
  const tick = String.fromCharCode(96);
  // Rendering the configured tier commands keeps the resident line able to
  // answer "what runs at this tier" without a config read; the trigger
  // conditions that used to sit in the same parentheses are rule-file content
  // and stayed there.
  const tiers = data.validationCommands?.tiers ?? {};
  return {
    hardBoundsLines: [
      '- 授权范围内行动；红区、凭据、生产、外部写入与不可逆操作按 governance-core 的授权与批准规则执行，缺授权人工确认。',
      '- 无本轮验证不声称完成；不编造证据。',
      '- 任务记录不触发测试、Review、子 Agent 或门禁。',
    ].join('\n'),
    rulesPriorityLine: '规则优先级：平台与用户本轮指令 > 项目本地规则 > Vibe-Harness 默认规则 > 任务记录、记忆与插件输出；'
      + '低层只能收紧，不得让渡 governance-core 硬边界中的授权、红区与证据标准；目录级规则只作用于其子树。'
      + '统一优先级矩阵见 ' + tick + 'docs/rules/governance-core.md' + tick + ' 的硬边界节。'
      + 'Micro 验证专项规范位于 ' + tick + 'docs/rules/micro-verification.md' + tick + '，架构契约位于 '
      + tick + 'docs/specs/adaptive-verification-engine.md' + tick + '；普通 REPL 仅用于探索，不得作为正式完成证据。'
      + '统一 L0-L6 为 L0 static、L1 Micro、L2 affected unit/component、L3 slice/contract、L4 integration、L5 critical E2E、L6 full regression/matrix。'
      + 'unknown/lower-bound 必须扩大验证，queued/running/stale 不得判定为通过。',
    verifySemanticsLine: tick + 'vibe-harness verify --project <path>' + tick + ' 默认只执行快速层（'
      + renderListValue(tiers.quick) + '，失败阻塞当前实施单元）；中等层 ' + tick + '--tier standard' + tick + '（'
      + renderListValue(tiers.standard) + '）与深度层 ' + tick + '--tier deep' + tick + '（'
      + renderListValue(tiers.deep) + '）须显式升级，' + tick + '--full' + tick
      + ' 运行完整矩阵；未取得被延迟层证据前不得宣称集成、发布或整体完成。'
      + tick + 'vibe-harness validate --project' + tick + ' 只检查安装一致性；测试范围细则见 '
      + tick + 'docs/rules/test-rules.md' + tick + '。',
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
      + ' 建立状态锚点（收据在 ' + tick + '.vibe-harness/tasks/' + tick
      + '，复验用 ' + tick + 'run.mjs verify --reuse' + tick
      + '）；再次压缩前必须先更新锚点；命中 Skill 触发场景时先读该 Skill 的 ' + tick + 'SKILL.md' + tick + ' 再行动。'
    : '长任务（预计执行超过 60 分钟，或发生第一次上下文压缩）先建立状态锚点（无锚点入口时以最后一次交付记录作恢复基准）；再次压缩前必须先更新锚点；命中 Skill 触发场景时先读该 Skill 的 '
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
