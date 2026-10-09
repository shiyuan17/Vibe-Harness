# CooperBench adapter

The adapter plans the official two-step CLI flow: `cooperbench run` followed by `cooperbench eval`. It accepts only the official `solo`, `coop`, and `team` settings. Each setting must be run under the same pinned task and measurement conditions to support a valid collaboration comparison.

Feature scores remain the outcome oracle; coordination metrics are preserved separately and cannot compensate for a failed feature. Run names include the patch and verifier digest, preventing results from different experiments from sharing an output identity.
