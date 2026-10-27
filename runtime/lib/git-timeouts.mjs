// Single source for the time budget of every Git subprocess the runtime spawns.
//
// The budget used to be a 15s literal at five call sites. On a slow volume that
// is not a safety margin but a hard failure: `git worktree add` for a large
// repository measured 145s on a busy volume where the same command in %TEMP%
// took 8.5s, so a delivery run could never create its candidate checkout
// while every other Git call sat one slow read
// away from the same fate. The default therefore covers a slow volume, and the
// parent process can size it per environment.
export const GIT_TIMEOUT_MS = 120_000;
export const MIN_GIT_TIMEOUT_MS = 1_000;
export const MAX_GIT_TIMEOUT_MS = 3_600_000;

/**
 * Resolve the Git subprocess budget from the environment.
 *
 * `VIBE_HARNESS_GIT_TIMEOUT_MS` is accepted inside the same absolute bounds the
 * verification budget uses (`MIN_TIMEOUT_MS`..`MAX_TIMEOUT_MS` in
 * `cli-runtime.mjs`). Unlike the land-lock budget it may widen as well as
 * narrow, because the measured failure mode is a volume slower than the
 * default rather than a stale lock; a missing, non-integer or out-of-range
 * value falls back to the default so a typo cannot silently drop the guard.
 *
 * @param {NodeJS.ProcessEnv} [environment]
 * @returns {number}
 */
export function gitTimeoutMs(environment = process.env) {
  const override = Number(environment.VIBE_HARNESS_GIT_TIMEOUT_MS);
  if (!Number.isInteger(override) || override < MIN_GIT_TIMEOUT_MS || override > MAX_GIT_TIMEOUT_MS) {
    return GIT_TIMEOUT_MS;
  }
  return override;
}
