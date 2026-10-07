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
pnpm example:recovery   # 崩溃→恢复演示：checkpoint 落盘，重开后接着跑
```

上游示例全集在 `pi` 仓库 `packages/durable/test/examples/`（00–31）。

## 状态

- [x] 骨架 + daemon 参考拷贝 + 可跑的 recovery 示例
- [ ] `src/index.ts`：最小 durable agent 会话循环（收消息 → durable conversation → 落盘 → 输出）
- [ ] 对照 `drivers/pi.ts` 补齐 MCP 工具/系统提示
