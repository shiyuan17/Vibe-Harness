---
name: debugging-and-error-recovery
description: Use when errors, failing tests, build failures, or unexpected behavior require diagnosis and recovery.
---

# 调试与恢复兼容入口

使用 `systematic-debugging` 作为唯一实现真值：先复现并收集证据，再定位根因、写回归测试、实施最小修复并验证。若 canonical skill 不可用，回退到项目排障规则，明确记录复现、假设、证据、修复和未验证项；不得凭猜测连续改动。
