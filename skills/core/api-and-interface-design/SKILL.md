---
name: api-and-interface-design
description: 设计稳定 API、模块边界或公共接口时使用。用于 REST/GraphQL endpoint、模块类型契约、前后端边界或跨模块 schema。
---

# API 与接口设计

目标是让调用方能稳定、清楚、可演进地使用接口。接口一旦发布，就会被以意想不到的方式依赖。

## 使用时机

- 新增或修改公共 API。
- 定义 DTO、schema、event、配置或模块边界。
- 前后端、跨仓、插件或第三方集成需要契约。
- 变更会影响已有调用方。

## 设计原则

1. 契约优先：先写请求、响应、错误和权限，再实现。
2. 只发布一个当前版本：优先兼容演进，避免无计划分叉。
3. 边界校验：外部输入在入口校验，内部类型保持可信。
4. 可加不轻改：新增字段通常安全；改名、改类型、改语义通常破坏兼容。
5. 命名可预测：同一概念在 API、DTO、UI model 和文档中使用同一词。
6. 错误语义一致：区分 validation、auth、not found、conflict、server error。

## REST 模式

- 资源用名词：`/projects/{projectId}/tasks`。
- 列表必须考虑分页、排序和过滤。
- `PATCH` 只表达部分更新，并定义 null、缺省和清空的差异。
- 响应字段的可空性必须明确。
- 权限失败、资源不存在和业务冲突使用一致错误结构。

## TypeScript 接口模式

输入和输出分开定义：

```typescript
type CreateTaskInput = {
  title: string;
  assigneeId?: string;
};

type TaskDto = {
  id: string;
  title: string;
  status: 'open' | 'done';
};
```

多形态返回优先用 discriminated union：

```typescript
type SaveResult =
  | { ok: true; task: TaskDto }
  | { ok: false; error: { code: string; message: string } };
```

## 变更检查

- 谁是调用方，是否已安装或发布。
- 是否破坏字段名、类型、可空性、错误码或权限。
- mock、mapper、测试和文档是否同步。
- 旧数据、旧客户端和缓存如何处理。
- 需要迁移、feature flag 或版本协商吗。

## 输出

交付接口设计时包含：

- 契约来源和范围。
- 请求、响应、错误、权限、分页和可空性。
- 兼容性说明。
- 调用方迁移或验证方式。
- 未决问题和阻塞项。
