# Pencil 规则

Pencil 设计资产是结构化源文件。只能通过能保持 schema 的受支持工具读取和编辑，不得把 `.pen` 当作普通文本处理。

## 启动检查

- Confirm the `.pen` path, target viewport, user workflow, component states, design variables, and implementation scope.
- Inspect existing layouts and reusable components before adding new nodes.
- Separate design approval from implementation approval when the change affects navigation, permissions, or data contracts.

## 设计要求

- Define stable dimensions and responsive constraints for fixed-format controls and work surfaces.
- Cover loading, empty, error, disabled, permission-denied, long-text, narrow-screen, and repeated-action states when applicable.
- Keep component names and hierarchy understandable without relying on visual position alone.
- Do not encode secrets, production data, or machine-specific absolute paths in design assets.

## 交付门禁

每个被引用的 `.pen` 文件必须有同目录、同 basename 的 `.png` 预览图。只引用源文件的 plan、task 或 handoff 视为不完整。存在 `design/` 目录时，full 治理校验器会强制检查这对文件。

## 验证

按声明 viewport 渲染设计，对比预览图与源文件，并确认文本、控件、浮层和相邻内容不重叠。进入实现时还必须补充真实浏览器证据。
