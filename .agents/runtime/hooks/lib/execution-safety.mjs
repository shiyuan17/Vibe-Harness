import { classifyExecutionEffects, gitInvocation, ordinaryGitDelivery } from './execution-effects.mjs';
import { shellInvocation, shellSegments } from './read-only-commands.mjs';
import { presetDeniesClassification, presetDeniesToolWrite } from './role-permissions.mjs';

function highRiskMerge(input) {
  const command = String(input.toolInput?.command ?? input.toolInput?.cmd ?? '');
  return shellSegments(command).some((segment) => {
    const shell = shellInvocation(segment);
    if (shell && ['pwsh', 'powershell', 'bash', 'sh', 'cmd'].includes(shell.name)) {
      const commandIndex = shell.args.findIndex((argument) => /^(?:-c|-command|\/c)$/iu.test(argument));
      if (commandIndex >= 0) return highRiskMerge({
        ...input, toolInput: { command: shell.args.slice(commandIndex + 1).join(' ') },
      });
    }
    const invocation = gitInvocation(segment);
    if (invocation?.command !== 'merge') return false;
    const { args } = invocation;
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      if (['-m', '--message', '-s', '--strategy', '-X', '--strategy-option', '--into-name'].includes(argument)) {
        index += 1;
        continue;
      }
      if (/^--(?:no-ff|no-commit|squash)$/u.test(argument)) return true;
      if (argument.startsWith('-')) continue;
      if (/^(?:main|master|release(?:[/-]|$)|hotfix[/-]|feat[/-]|fix[/-]|refs\/heads\/(?:main|master|release)|[^/\s]+\/(?:feat|fix|hotfix)[/-])/iu.test(argument)) return true;
    }
    return false;
  });
}

export function evaluateExecutionSafety(input, { permissionPreset = null } = {}) {
  const classification = classifyExecutionEffects(input);
  if (presetDeniesToolWrite(permissionPreset, String(input.toolName ?? ''))
    || presetDeniesClassification(permissionPreset, classification)) {
    return { action: 'deny', reasonCode: 'ROLE_PERMISSION_PRESET',
      reason: '当前角色权限预设不允许此操作，请交由具备相应权限的角色或主会话执行。' };
  }
  if (classification.credentialPersistence) {
    return { action: 'deny', reasonCode: 'CREDENTIAL_PERSISTENCE',
      reason: '禁止把凭据助手输出直接落盘。' };
  }
  if (classification.immutableWorkspaceOperation) {
    return { action: 'deny', reasonCode: 'WORKTREE_IDENTITY_MOVE',
      reason: '不得移动当前活动工作区身份，请创建并核验新的隔离工作区。' };
  }
  if (highRiskMerge(input)
    && input.toolInput?.highRiskMergeConfirmed !== true
    && process.env.VIBE_HARNESS_CONFIRM_HIGH_RISK_MERGE !== '1') {
    return { action: 'deny', reasonCode: 'HIGH_RISK_MERGE_CONFIRMATION_REQUIRED',
      reason: '检测到高风险合并。请确认源分支、目标分支和影响范围后重试；普通同分支同步可继续。' };
  }
  const delivery = ordinaryGitDelivery(input, classification);
  if (delivery && typeof delivery !== 'string') return delivery;
  if (classification.effects.some((effect) => ['gitCommit', 'gitPush'].includes(effect)) && !delivery) {
    return { action: 'deny', reasonCode: 'GIT_DELIVERY_UNVERIFIED',
      reason: '仅可直接执行已核验的普通提交或非强制推送，请使用项目交付入口或明确当前分支的单一远端目标。' };
  }
  return { action: 'allow' };
}
