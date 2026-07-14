const DELIVERY_FIELDS = [
  ['结果状态', /^(?:[-*]\s*)?(?:结果状态|Result status)\s*[:：]\s*(?:(?:完成|未完成|阻塞|中断)(?:\s|$)|(?:completed|incomplete|blocked|interrupted)\b)/imu],
  ['变更摘要', /^(?:[-*]\s*)?(?:变更摘要|Change summary)\s*[:：]\s*\S+/imu],
  ['影响范围', /^(?:[-*]\s*)?(?:影响范围|Impact scope)\s*[:：]\s*\S+/imu],
  ['工作流档位', /^(?:[-*]\s*)?(?:工作流档位|Workflow tier)\s*[:：]\s*\S+/imu],
  ['验证证据', /^(?:[-*]\s*)?(?:验证证据|Verification evidence)\s*[:：]\s*\S+/imu],
  ['未验证项', /^(?:[-*]\s*)?(?:未验证项|Unverified items?)\s*[:：]\s*\S+/imu],
  ['剩余风险', /^(?:[-*]\s*)?(?:剩余风险|Residual risks?)\s*[:：]\s*\S+/imu],
  ['Git 状态', /^(?:[-*]\s*)?(?:Git 状态|Git status)\s*[:：]\s*\S+/imu],
  ['Worktree / 分支 / merge-back 状态', /^(?:[-*]\s*)?(?:Worktree\s*\/\s*分支\s*\/\s*merge-back 状态|Worktree\s*\/\s*branch\s*\/\s*merge-back status)\s*[:：]\s*\S+/imu],
  ['后续动作', /^(?:[-*]\s*)?(?:后续动作|Next steps?)\s*[:：]\s*\S+/imu],
  ['Memory', /^(?:[-*]\s*)?Memory\s*[:：]\s*\S+/imu],
];

export function validateDeliveryMessage(message) {
  const body = typeof message === 'string' ? message : '';
  const missing = DELIVERY_FIELDS
    .filter(([, pattern]) => !pattern.test(body))
    .map(([name]) => name);
  return { ok: missing.length === 0, missing };
}
