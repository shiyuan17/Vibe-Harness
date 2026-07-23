---
name: api-and-interface-design
description: Use for public APIs, schemas, events, config contracts, or consumed module boundaries—not private code.
---

# 设计接口契约

以现有契约和调用方为真值，先固定边界再实现。

## 执行

1. 找到契约来源、生产者、消费者和兼容窗口。
2. 明确输入、输出、错误、权限、可空性、分页及幂等语义。
3. 在外部边界校验输入，保持内部类型可信；不要臆造字段或错误码。
4. 优先做可加的兼容演进；改名、改类型或改语义时设计迁移与回滚。
5. 同步 mapper、mock、文档和两侧契约测试。
6. 用真实调用路径证明生产者与消费者一致，不以单侧测试替代。

## 交付

报告契约来源、兼容影响、迁移方式、两侧验证和剩余未决项。
