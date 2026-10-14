# Internal Harness scenarios

This directory contains the canonical Scenario v3 definitions for H01-H23. Each scenario references a disposable fixture manifest in `../fixtures/` and follows the authoring contract in `../docs/scenario-authoring.md`.

The definitions are runner-neutral. A backend must declare every required capability before it starts a scenario. Hidden checks are controller-owned and must never be copied into the Agent-visible prompt or workspace.

H21-H23 use runner event markers for reasoning evidence. H21 requires two distinct `hypothesis` events, one `experiment`, then `change` and successful `verification`; H22 requires `unknown`, `experiment-proposed`, `experiment-completed`, `change`, and successful `verification`; H23 requires `state-model`, `invariant`, an invalid `transition-check`, `change`, and successful `verification`. Payloads must contain the fields described by each scenario's runner contract.
