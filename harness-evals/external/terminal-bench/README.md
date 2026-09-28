# Terminal-Bench through Harbor

This adapter delegates task acquisition, environment execution, Codex integration, verification, and ATIF trajectory production to Harbor. It plans a pinned dataset run for one task with `--n-concurrent-trials 1` and stores the job under the supplied artifact directory.

The Harness result preserves Harbor's reward and trajectory reference. If the official result omits a reward, the outcome is blocked and metric coverage is zero. The adapter does not infer success from process exit alone.
