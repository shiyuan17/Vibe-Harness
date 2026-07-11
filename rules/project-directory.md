# Project Directory

Project directory guidance records ownership and dependency direction so agents can locate the correct change boundary without inventing a new structure.

## Discovery order

1. Read the repository entry instructions, current-state and architecture documents when present.
2. Inspect package/workspace manifests, build entrypoints, adapters, and module indexes.
3. Use CodeGraph when the repository already contains an index; otherwise use repository search.
4. Confirm the nearest tests and validation commands before editing.

## Placement rules

- Put domain behavior with the domain that owns its state and interfaces.
- Shared directories contain capabilities proven reusable by multiple consumers, not convenient dumping grounds.
- Adapters translate between external and internal contracts; they do not own business rules.
- Generated, vendored, build, cache, evidence, and temporary directories are not source ownership locations.
- New top-level directories require an architecture reason, an owner, and documentation of dependency direction.

## Cross-boundary changes

When a change crosses modules, packages, repositories, or services, list each owner and interface, identify the compatibility and rollback strategy, and validate both sides. If ownership remains unclear, stop at clarification rather than spreading logic across layers.

## Completion standard

The change is complete when new and modified files live in declared ownership boundaries, imports follow the intended direction, and tests demonstrate the affected consumers.
