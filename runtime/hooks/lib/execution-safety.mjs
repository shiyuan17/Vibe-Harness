import { classifyExecutionEffects, ordinaryGitDelivery } from './execution-effects.mjs';
import { presetDeniesClassification, presetDeniesToolWrite } from './role-permissions.mjs';

function highRiskMerge(input) {
  const command = String(input.toolInput?.command ?? input.toolInput?.cmd ?? '');
  if (!/\bgit(?:\.exe)?\s+(?:-[^\s]+\s+)*merge\b/iu.test(command)) return false;
  const targets = command.match(/\bgit(?:\.exe)?\s+(?:-[^\s]+\s+)*merge\s+(.+)$/iu)?.[1] ?? '';
  return /(?:^|\s)(?:main|master|release(?:[/-]|$)|hotfix[/-]|feat[/-]|fix[/-]|refs\/heads\/(?:main|master|release)|[^/\s]+\/(?:feat|fix|hotfix)[/-])/iu.test(targets)
    || /--(?:no-ff|no-commit|squash)\b/iu.test(targets);
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
