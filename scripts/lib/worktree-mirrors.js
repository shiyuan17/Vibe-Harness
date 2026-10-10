// Worktree governance-surface projection — source-repository entry point.
//
// The implementation lives in `runtime/lib/worktree-mirrors.mjs` so the
// installed project script (`runtime/commands/run.mjs worktree`) and this
// repository's CLI (`scripts/worktree.js`) project and audit the same mirrors
// from one implementation. This module stays as the stable import path for the
// repository's own scripts and tests.
export * from '../../runtime/lib/worktree-mirrors.mjs';
