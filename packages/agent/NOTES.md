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

| Raft daemon（reference/raft-daemon） | pi-durable 对应物 | 本仓库实现 |
|---|---|---|
| `src/drivers/pi.ts` —— pi-coding-agent 进程 driver | `Harness` + conversation（durable 天然支持 pi-coding-agent） | `src/daemon.ts`：每个 agent 一条 ownerless conversation，agent 配置进 `pi.agent` doc |
| `src/agentProcessManager*.ts` —— 拉起/回收/唤醒 | 不需要：进程内 harness；崩溃恢复 = 新 Harness 打开同一 storage + `harness.resume()`（示例 13/31） | `DurableDaemon.open()` 每次打开即"重启" |
| `src/agentLifecycleRecord.ts` —— queued/starting/running/idle/cooldown/terminal | 从 conversation 视图（`pi.live`、`pi.inbox`）和提交结算态投影 | `src/lifecycle.ts`：同名六种状态 + `stopped` |
| `src/runtimeTurnState.ts` —— 轮次状态机 | durable 内置 `pi.generation`/`pi.tool` task 的 checkpoint；事件层 `turn_start`/`turn_end` | `src/events.ts` 归一化时复用同样的 per-turn 计数器 |
| `src/runtimeOutcomeOutbox.ts` —— 结果外发（write-ahead、stop-and-wait、精确 ack、重传、容量、unreliable、人工恢复） | session doc `raft.outbox`（一次 commit = 一次 fsync 写盘）；投递泵在进程内 watch 驱动 | `src/outbox.ts`（见下方"如实简化的部分"） |
| `src/chatBridgeRequest.ts` / `agentAppInbox.ts` —— 收件与 busy 策略 | `submit` 的 `whenBusy: steer/followUp/reject` + `pi.inbox` | `src/daemon.ts` `postMessage()`；`src/runtimeInput.ts` 端口格式化 |
| `src/agentRuntimeInput.ts` —— 消息→agent 输入格式化 | durable 的 input submission | `src/runtimeInput.ts`：`[msg=.. seq=.. time=.. type=..] @sender: body` + 回复提示 |
| `src/workspaces.ts` —— 工作区隔离 | conversation 的 `cwd` + `HarnessOptions.env` | `src/workspaces.ts` 近乎逐行移植；env 每个 conversation 一个 `NodeExecutionEnv` |
| `src/drivers/piEventNormalizer.ts` + `drivers/types.ts` `ParsedEvent` | `watchEvents()` 已是结构化事件流 | `src/events.ts` 映射回同一套 ParsedEvent 词汇（text/thinking/tool_call/tool_output/turn_end/error/token_usage） |
| `src/runtimeErrorDiagnostics.ts` —— 错误分类+指纹 | 同左，纯函数 | `src/diagnostics.ts` 移植 scrub/fingerprint/classify |
| `src/runtimeOutcome.ts` —— E1/E2 证据帧 | 同左 | `src/outcome.ts` 移植 `turnCompletedOutcome` + 计数器 |
| `src/sessionTranscriptReader.ts` —— 会话轨迹落盘 | `watchEvents` 批事件→JSONL | `src/daemon.ts` 每个 agent 写 `transcripts/<agent>.jsonl` |

## 如实简化 / 有差异的地方（不假装 1:1）

- **进程管理整个不存在。** daemon 的大部分代码（spawn、stdin 协议、进程回收、
  machineLock、崩溃诊断）在 durable 模型里没有对应物：会话不依赖进程存活。
  等价物是"重开 storage + `harness.resume()`"，未完成的 task 自动续跑。
- **多 runtime driver → 单一 pi runtime + 多 provider。** daemon 的 driver 矩阵
  （claude/codex/grok/gemini/kimi/opencode）在 durable 下塌缩成 pi-ai 的 provider
  矩阵（`createModels` + `models.setProvider`）。e2e 用 `zai-coding-cn`（GLM）。
- **outbox 单实例。** daemon 的 gap/cross marker、takeover epoch、server capability
  协商是为"多台 daemon 机器先后接管同一 agent"设计的；一个 storage 同一时刻只有
  一个 Harness 持有（durable 明确不跨进程加锁），所以这些机制无意义。保留：
  write-ahead 提交、stop-and-wait 单在途、精确 ack 删除、重传退避(5s→5min,20%抖动)、
  容量 128 + 溢出丢最老非在途 `turn_completed`、写失败→unreliable 标记、
  人工 resolve 恢复。运输层抽象成 `OutboxTransport`（默认 JSONL 落盘，可验证）。
- **生命周期是投影不是真相。** daemon 的 lifecycle 是进程状态机；这里是从
  `pi.live`/`pi.inbox`/提交结算 + registry 记录投影出来的只读视图。
- **server 连接不存在。** daemon 的 websocket/server 协议层没有对应物；
  "上游"抽象成 `OutboxTransport.send()`，默认实现是本地 JSONL 送达账本。
- **活动追踪/telemetry 大幅精简。** 保留 token_usage 归一化（`piEventNormalizer` 同款）
  和错误指纹；不移植 OpenTelemetry 全套。

## 建议探索顺序

1. `pnpm e2e` 一键跑端到端验证（真实 GLM 模型：问答→工具调用→崩溃恢复→steer→outbox）
2. `pnpm cli serve` 长驻守护进程；`pnpm cli send <agent> <text>` 发消息
3. 读 `src/daemon.ts` 总装 → `src/outbox.ts` 可靠性 → `src/events.ts` 事件归一化
4. 对照 `reference/raft-daemon/src/` 同名文件看移植取舍

上游示例全集在 `pi` 仓库 `packages/durable/test/examples/`（00–31）。
