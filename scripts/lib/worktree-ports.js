// Worktree port segmentation — source-repository entry point.
//
// The implementation lives in `runtime/lib/worktree-ports.mjs` so the
// installed project script (`runtime/commands/run.mjs worktree`) and this
// repository's CLI (`scripts/worktree.js`) report the same port and
// environment facts from one implementation. This module stays as the stable
// import path for the repository's own scripts and tests.
export * from '../../runtime/lib/worktree-ports.mjs';
