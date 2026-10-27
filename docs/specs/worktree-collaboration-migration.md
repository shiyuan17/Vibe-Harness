# Worktree 协作协议迁移

本次保留 stage → publish。普通本地反馈仍可请求 quick；交付 Planner
另行选择必需检查，高风险至少契约/集成，生命周期影响追加 smoke，
unknown/lower-bound 扩大范围。CI 使用同一选择，PR/main/定时/手动触发不变。
develop 成功仅表示本地必要验证和精确远端确认。

## 接口与配置

```json
{
  "worktree": {
    "dependencyMode": "isolated",
    "provision": {
      "candidateSetupCommands": ["node tools/environment.mjs setup"],
      "candidateTeardownCommands": ["node tools/environment.mjs teardown"]
    }
  },
  "validationCommands": {
    "checks": [
      {
        "id": "integration",
        "command": "node tools/test-database.mjs",
        "resources": ["database:integration"],
        "deterministic": false,
        "writesDependencies": false
      }
    ]
  }
}
```

项目命令获得 `VIBE_HARNESS_WORKSPACE_ID`、`VIBE_HARNESS_RESOURCE_NAMESPACE`、
`VIBE_HARNESS_CACHE_DIR`、声明的端口变量，以及 setup/teardown 的
`VIBE_HARNESS_RESOURCE_STEP`。命令由安全分词器执行，不经任意 shell。
凭据不写入事务；凭据使用仍须遵守项目授权。

setup/teardown 成对声明；同资源/步骤重复执行必须幂等，先读取外部当前
状态再补缺失动作。运行时保存成功步骤下标；动作成功但落盘前崩溃时会重放
相同步骤键，项目据此识别已完成动作。不能证明停止时保留资源。
旧 setupCommands 继续用于源工作区准备。

依赖策略为 `shared-immutable` 或 `isolated`。共享策略只适合不写依赖的
命令，无法证明共享目录不可变时不授予跨工作区复用。依赖锁文件变化、
候选 setup 或 writesDependencies 检查触发独立目录，下载 store 可共享。
项目负责按候选 lockfile 执行 frozen 安装和环境健康核对。

`resources` 是具体共享资源名称，多个名称按固定顺序锁定，检查结束释放。
未声明不加仓库全局锁。`repo-heavy` 不是锁名。

## 清理与恢复

```sh
node .agents/runtime/commands/run.mjs worktree cleanup --project . --batch <id>
node .agents/runtime/commands/run.mjs worktree cleanup --project . --batch <id> --write
pnpm task-dag check --file <dag.json> --node <id> --json
```

未确认集成的事务拒绝 batch cleanup。已确认事务的 publish 重试只清理。
Git common dir 的资源日志保留身份、归属与步骤进度；终态事务保留精简
摘要。dirty 源、漂移 HEAD、未知资源和活服务保留为 integrated_cleanup_pending。
Linear Done 回写失败只记录同步待处理；重读后补缺失转换，不重推。

缓存 v6 的旧记录只用于历史展示，不自动命中。事务 v1–v4 继续可读，
缺候选环境或有效证明时重新建立精确对象验证；无法证明资源停止时阻塞相关
清理。更新时同步 runtime、安装映射和 `.agents/runtime`，不要仅替换 Hook。

受管 Hook 收到的环境变量只是证明 ID。证明经过本机用户密钥认证并绑定
精确对象和输入。Windows Git shell 的变量大小写、已知 PATH 前缀转换
被规范化；其他环境变化失效。普通 push 对每个 SHA 在干净临时工作区验证，
同 SHA 多 ref 去重，删除 ref 不运行代码检查。

签发前再次对照原验证收据的完整执行与环境指纹；不能把检查结束后变化的
依赖或环境签成新证明。证明消费与验证器共用工具版本、配置和依赖指纹。
旧收据缺少这些字段时按 miss 处理。

## 启用与回滚

main required checks 已只读核对为 product 与 merge-gate，develop ruleset
disabled；本次均保留，未改服务器配置。其他安装项目应自行核对 required
checks 是否引用已退出的 job，迁移前不可删除服务器仍等待的检查名称。

本仓库 `verification.reuse.enabled` 保持 false，短检查性能样本未证明总耗时
收益。其他项目启用前也应运行相同 fixture 的前后比较；少跑命令不代表更快。
将该开关或检查的 deterministic 设为 false 可关闭复用；publish 在 FIFO 外真实
验证后生成仅供本次尝试的证明。资源异常只暂停相关检查并保留日志。
有活动 v5 事务时不能直接用旧 runtime 处理；先完成或保留实例再回滚。
不恢复源端口复制、无关候选取消、空 affected 范围或环境失败额外 merge。

本地 Windows 回归不等于 Unix 原生链接行为、远端 CI 和线上 Linear 回写
已验证；最终交付记录逐项列出实际证据与缺口。
