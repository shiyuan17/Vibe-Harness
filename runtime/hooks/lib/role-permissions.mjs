import { isWorkspaceToolName } from './read-only-commands.mjs';

// Role permission-preset tiers for hook-side enforcement. These sets mirror
// scripts/lib/role-projection.js WRITE_PRESETS/EXECUTE_PRESETS and are both
// derived from manifests/roles.json permissionPresets capabilities (canonical
// source): a preset is writable when it grants 'workspace-write', and
// executable when it is writable or grants 'validation-command'. Equivalence
// across the three declarations is enforced by validateRolePresetDerivations
// in scripts/lib/pack-validation.js. The runtime hook must not read source
// manifests/, so these literals are the shipped fail-safe copy.
export const WRITABLE_PRESETS = new Set(['implementation']);
export const EXECUTABLE_PRESETS = new Set(['implementation', 'verification', 'release-readiness']);

/**
 * Map a permission preset id to its enforcement tier. An unknown or empty
 * preset fails closed to 'read-only': an unrecognized id can only restrict,
 * never widen, what the hook allows.
 * @param {string | null | undefined} permissionPreset
 * @returns {'writable' | 'executable' | 'read-only' | null}
 */
export function rolePresetTier(permissionPreset) {
  if (typeof permissionPreset !== 'string' || permissionPreset.trim() === '') return null;
  if (WRITABLE_PRESETS.has(permissionPreset)) return 'writable';
  if (EXECUTABLE_PRESETS.has(permissionPreset)) return 'executable';
  return 'read-only';
}

/**
 * Whether the preset forbids direct workspace-write tools for this call.
 * Mirrors the host projections: non-writable presets deny the edit/apply_patch
 * tool family (opencode `edit: deny`, non-writable codex sandbox stays below
 * workspace-write), while shell-command effects remain governed by the
 * Execution Envelope so verification presets can still run test commands.
 * @param {string | null | undefined} permissionPreset
 * @param {string} toolName
 * @returns {boolean}
 */
export function presetDeniesToolWrite(permissionPreset, toolName) {
  const tier = rolePresetTier(permissionPreset);
  if (tier === null || tier === 'writable') return false;
  return isWorkspaceToolName(String(toolName ?? ''));
}

/**
 * Whether the preset forbids this execution-effect classification. Read-only
 * presets deny every classification that is not provably read-only, including
 * undecidable calls (opencode keeps bash disabled for read-only presets; the
 * codex sandbox stays read-only).
 * @param {string | null | undefined} permissionPreset
 * @param {{readOnly?: boolean} | null | undefined} classification
 * @returns {boolean}
 */
export function presetDeniesClassification(permissionPreset, classification) {
  if (rolePresetTier(permissionPreset) !== 'read-only') return false;
  return !classification?.readOnly;
}
