# daemon → pi-durable 移植笔记

## 对照关系（先说人话版）

Raft daemon 的方式：agent 是**外部进程**——daemon 按 runtime 类型（claude / codex / pi）
用对应的 `src/drivers/*.ts` 拉起一个 CLI 子进程，盯着它的 stdout 事件流，把状态写进自己的
数据库，进程崩了靠 `agentProcessManager` 重新拉起、从日志恢复会话。

pi-durable 的方式：agent 循环跑在**自己进程里**，但每一轮对话、每次工具调用、每个 task
checkpoint 都先落盘（SQLite/JSONL）再执行——进程死了换个 Harness 打开同一份存储就接着跑。

要"基于 pi-durable 复刻 raft build"，就是把 daemon 干的那几件事（拉起、会话状态、
崩溃恢复、结果投递）换成 durable 的原语来表达。

## 对照表

| Raft daemon（reference/raft-daemon） | pi-durable 对应物 |
|---|---|
| `src/drivers/pi.ts` —— pi-coding-agent 进程 driver | `@earendil-works/pi-durable` 的 `Harness` + conversation（durable 天然支持 pi-coding-agent，见 pi 仓库 `test/examples/26-coding-agent.ts`） |
| `src/agentProcessManager*.ts` —— 拉起/回收/唤醒 | 不需要：进程内 harness；崩溃恢复 = 新 Harness 打开同一 storage（示例 13/31） |
| `src/runtimeTurnState.ts` —— 轮次状态机 | durable task 的 `phases` + `checkpoint`（示例 13） |
| `src/runtimeOutcomeOutbox.ts` —— 结果外发 | durable 的 outbox/watch（示例 05-watches、20-inbox） |
| `src/chatBridgeRequest.ts` / apps 收件箱 | `Conversation` + inbox（示例 14-chat、20-inbox） |
| `src/workspaces.ts` —— 工作区隔离 | 示例 29 `sandbox-per-conversation` |

## 建议探索顺序

1. `packages/agent` 里先跑通 `pnpm example:recovery`（已验证可跑）
2. 读 pi 仓库 `test/examples/` 06-harness → 12-tasks → 13-recovery → 26-coding-agent
3. 读 `reference/raft-daemon/src/drivers/pi.ts` 看 raft 给 pi-coding-agent 包了什么（MCP 工具、系统提示、事件归一化 `piEventNormalizer.ts`）
4. 在 `packages/agent/src/` 里用 `Harness` 写一个最小 "daemon"：收一条消息 → durable conversation 跑 pi-coding-agent → 落盘 → 打印结果
