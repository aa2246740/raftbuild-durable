# raftbuild-durable

个人探索仓库：参考 Raft（botiverse/raft-source）的 daemon，把「长驻 agent 服务」
重新实现在 [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) 上。

一句话：Raft daemon 靠监管外部 agent CLI 进程来做长驻会话；pi-durable 把会话状态
全部先落盘，进程死了原地复活接着跑。这个仓库就是把前者的职责用后者的原语重新表达一遍。

## 布局

| 路径 | 是什么 |
|---|---|
| `reference/raft-daemon/` | raft `packages/daemon` 原样拷贝，**只读参考**，不参与构建（FSL-1.1-ALv2 © Botiverse） |
| `packages/agent/` | 移植目标：基于 pi-durable 的最小 durable agent |
| `packages/agent/examples/` | 可直接跑的 pi-durable 示例副本 |
| `packages/agent/NOTES.md` | daemon 概念 ↔ pi-durable 原语的对照笔记，先读这个 |

## 快速开始

```bash
pnpm install
cd packages/agent

# 真实模型端到端验证（需要 zhipu 或 ZAI_CODING_CN_API_KEY；GLM 模型）
pnpm e2e                # 44 项检查：问答→工具→SIGKILL 崩溃恢复→steer→outbox 不变量
                        # 报告写到 packages/agent/e2e/report.md

# 守护进程 CLI
pnpm cli serve --state .raftd            # 长驻模式：打开即恢复所有 agent
pnpm cli create demo                     # 新建 agent（工作区自动隔离）
pnpm cli send demo "hello"               # 发消息
pnpm cli lifecycle                       # 生命周期投影
pnpm cli outbox demo                     # 查看 durable outbox
pnpm cli events demo                     # 事件流
pnpm cli inspect                         # harness 内部状态

# 上游示例副本（崩溃→恢复演示）
pnpm example:recovery
```

上游示例全集在 `pi` 仓库 `packages/durable/test/examples/`（00–31）。

## 状态

- [x] 骨架 + daemon 参考拷贝 + 可跑的 recovery 示例
- [x] `src/` 完整移植：registry / lifecycle / runtimeInput / outbox / events / workspaces / outcome / diagnostics / daemon / cli
- [x] `pnpm e2e` 真实模型端到端验证 44/44（GLM `glm-5.3-flash`，含 `kill -9` 原地复活）
- [ ] 对照 `drivers/pi.ts` 补齐 MCP 工具/系统提示
