/**
 * Adapter runtime safety posture assessment.
 */

export function adapterSafetyPosture(adapter) {
  const reasons = [];
  const preToolUse = adapter.hookEvents?.preToolUse || 'unsupported';
  const permissionRequest = adapter.hookEvents?.permissionRequest || 'unsupported';
  if (preToolUse !== 'stable' || permissionRequest !== 'stable') {
    reasons.push('hookEvents=' + preToolUse + '/' + permissionRequest + ': runtime red-zone, egress, and credential policies are not fully enforced');
  }
  if (!adapter.redZonePrefixes || adapter.redZonePrefixes.length === 0) {
    reasons.push('redZonePrefixes is empty: install-time red-zone classification does not apply');
  }
  return { degraded: reasons.length > 0, reasons };
}

export function safetyPostureWarnings(adapter) {
  const { degraded, reasons } = adapterSafetyPosture(adapter);
  if (!degraded) return [];
  return [{
    code: 'DEGRADED_SAFETY_POSTURE',
    message: adapter.id + ' runs without stable runtime hooks (' + reasons.join('; ') + '); rely on human confirmation and review for sensitive operations.',
  }];
}
