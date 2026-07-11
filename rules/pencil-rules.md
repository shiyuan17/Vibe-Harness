# Pencil Rules

Pencil design assets are structured source files. Read and edit them only through supported tools that preserve their schema; do not treat `.pen` as arbitrary text.

## Intake

- Confirm the `.pen` path, target viewport, user workflow, component states, design variables, and implementation scope.
- Inspect existing layouts and reusable components before adding new nodes.
- Separate design approval from implementation approval when the change affects navigation, permissions, or data contracts.

## Design requirements

- Define stable dimensions and responsive constraints for fixed-format controls and work surfaces.
- Cover loading, empty, error, disabled, permission-denied, long-text, narrow-screen, and repeated-action states when applicable.
- Keep component names and hierarchy understandable without relying on visual position alone.
- Do not encode secrets, production data, or machine-specific absolute paths in design assets.

## Delivery gate

Every referenced `.pen` file must have a same-directory, same-basename `.png` preview. A plan, task, or handoff that references only the source file is incomplete. The full governance validator enforces this pair when a `design/` directory exists.

## Verification

Render the design at the declared viewports, compare the preview with the source, and verify that text, controls, overlays, and adjacent content do not overlap. Implementation work must additionally use real browser evidence.
