// Worktree isolation audit — source-repository entry point.
//
// The implementation moved to `runtime/lib/worktree-audit.mjs` so the installed
// project script (`runtime/commands/run.mjs worktree`) and this repository's CLI
// (`scripts/worktree.js`) share one implementation instead of drifting apart.
// This module stays as the stable import path for the repository's own scripts
// and tests.
export * from '../../runtime/lib/worktree-audit.mjs';
