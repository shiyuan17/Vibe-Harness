/**
 * Adapter runtime safety posture assessment.
 *
 * The Codex policy hook enforces red-zone writes, credential exfiltration,
 * egress allowlisting, and project-boundary checks at runtime. Hosts whose
 * `hooks` capability is not `stable`, or that declare no `redZonePrefixes`,
 * cannot enforce that policy and therefore run in a degraded safety posture.
 *
 * This module makes that degradation explicit so install/validate/doctor can
 * surface it to the user instead of leaving it implicit.
 */

/**
 * Assess the runtime safety posture of an adapter.
 *
 * @param {{ id: string, capabilities: Record<string, string>, redZonePrefixes?: string[] }} adapter
 * @returns {{ degraded: boolean, reasons: string[] }}
 */
export function adapterSafetyPosture(adapter) {
  const reasons = [];
  const hooks = adapter.capabilities?.hooks;
  if (hooks !== 'stable') {
    reasons.push(`hooks=${hooks ?? 'unsupported'}: runtime red-zone, egress, and credential policies are not enforced`);
  }
  if (!adapter.redZonePrefixes || adapter.redZonePrefixes.length === 0) {
    reasons.push('redZonePrefixes is empty: install-time red-zone classification does not apply');
  }
  return { degraded: reasons.length > 0, reasons };
}

/**
 * Build warning entries for the degraded safety posture of an adapter.
 * Returns an empty array when the adapter is not degraded.
 *
 * @param {{ id: string, capabilities: Record<string, string>, redZonePrefixes?: string[] }} adapter
 * @returns {Array<{ code: string, message: string }>}
 */
export function safetyPostureWarnings(adapter) {
  const { degraded, reasons } = adapterSafetyPosture(adapter);
  if (!degraded) return [];
  return [{
    code: 'DEGRADED_SAFETY_POSTURE',
    message: `${adapter.id} runs without stable runtime hooks (${reasons.join('; ')}); rely on human confirmation and review for sensitive operations.`,
  }];
}
