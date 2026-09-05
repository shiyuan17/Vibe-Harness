# Internal Harness scenarios

This directory contains the canonical Scenario v3 definitions for H01-H20. Each scenario references a disposable fixture manifest in `../fixtures/` and follows the authoring contract in `../docs/scenario-authoring.md`.

The definitions are runner-neutral. A backend must declare every required capability before it starts a scenario. Hidden checks are controller-owned and must never be copied into the Agent-visible prompt or workspace.
