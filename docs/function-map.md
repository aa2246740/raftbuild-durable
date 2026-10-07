# Raft daemon 功能全图（第一性拆解）

拆解对象：`reference/raft-daemon`（约 140 个文件 / 6.2 万行 TS）。按"谁在用、解决什么"分组，
不按文件分组。每条标注本仓库移植状态：

- **已有** = 已移植且 e2e 验过或 typecheck 过
- **缺失** = 原版有、本版没有，值得做
- **超越** = 本版做得比原版强
- **不适用** = durable 模型下该机制无意义

## 一、用户对产品的感知（"我用它干什么"）

| # | 功能 | daemon 怎么做的 | 本版状态 | 备注 |
|---|---|---|---|---|
| 1 | 养一个长驻 agent | server 下发 `agent:start` → driver 拉起 CLI 进程 | **已有** | `create` → ownerless conversation，无进程 |
| 2 | 给 agent 发消息拿回复 | `agent:deliver` → inbox/wake/busy 协调 → 进程 stdin | **已有** | `postMessage` + `whenBusy`（steer/followUp/reject），e2e 实测 |
| 3 | agent 会干活（工具） | runtime 自带 CLI 工具 + managed MCP + raft CLI | **已有（部分）** | pi CodingTools 已接；managed MCP/raft CLI 工具面**缺失** |
| 4 | agent 与 agent 对话 | 消息经 server 路由到目标 agent | **缺失** | 本版最大缺口：信封有 target 语义但没有路由回环 |
| 5 | 崩溃不丢活 | daemon 重启重连仍活着的 CLI 进程 | **超越** | 状态先行落盘，`kill -9` 后原地续跑，已实测 |
| 6 | 忙时消息不丢 | parked wake / delivery debt / busy 协调器 | **已有** | `pi.inbox` + `whenBusy` 原生语义 |
| 7 | 看 agent 在干嘛 | server 上 UI（不在本仓库） | **缺失** | 本版需自带界面：CLI 有，web 控制台要做 |
| 8 | 上下文管理 | wake recycle：缓存过期+大上下文→简报新会话 | **部分** | pi-durable 自带 compaction；简报式 recycle 缺失 |
| 9 | 提醒/定时唤醒 | reminder app：到点 inbox 唤醒 agent | **缺失** | 可做：定时器→postMessage |
| 10 | 工作区隔离与种子内容 | workspaces + onboarding seed（MEMORY.md 等） | **已有** | 容器校验逐行移植，种子已做 |
| 11 | 消息信封/防伪造 | `[target=.. msg=..] @sender: body` + 续行缩进 | **已有** | runtimeInput.ts |
| 12 | 迁移（换机器搬 agent） | 工作区打包→对象存储→目标导入 | **不适用 v1** | pi-durable 单机 storage；等价物 = 复制 stateDir |

## 二、可靠性内核（出了问题会怎样）

| # | 功能 | daemon | 本版状态 | 备注 |
|---|---|---|---|---|
| 13 | 结果外发不丢 | runtimeOutcomeOutbox：write-ahead/单在途/精确 ack/重传/cap/丢策略/unreliable/人工 resolve | **已有** | 十项不变量 e2e 全验 |
| 14 | 结果恰好一次 | (agentId, clientSeq) 幂等 | **已有** | producedSubmissionIds dedupe 环 |
| 15 | 多机接管 | takeover epoch / gap·cross marker / server 协商 | **不适用** | 一个 storage 一个 Harness，机制无意义 |
| 16 | 崩溃分类与指纹 | runtimeErrorDiagnostics：scrub+fingerprint+errorAction | **已有** | outcome.ts/diagnostics.ts |
| 17 | E1/E2 证据帧 | terminal_failure / turn_completed | **已有** | 同上 |
| 18 | 生命周期投影 | queued/starting/running/idle/cooldown/stopped/terminal | **已有** | lifecycle.ts 投影 |
| 19 | 事件归一化 | 各 driver normalizer → ParsedEvent | **已有** | watchEvents → 同词汇表 |
| 20 | transcript 落盘 | sessionTranscriptReader | **已有** | transcripts/*.jsonl |
| 21 | 启动失败熔断 | spawn-fail backoff / decision error window | **缺失** | 可对 err 计数入 cooldown |
| 22 | 投递可见性账本 | agentVisibleDeliveryLedger：agent 到底"看见"了哪条消息 | **部分** | durable entry 天然可见性更强；显式账本缺失 |
| 23 | machineLock 防双开 | 锁文件+token 防两个 daemon 抢一台机 | **缺失** | 需要：双开同 stateDir 应拒绝 |
| 24 | 孤儿进程回收 | daemonOrphanReaper SIGKILL 漏网子进程 | **不适用** | 没有子进程 |

## 三、运维面（跑在客户机器上要管什么）

| # | 功能 | daemon | 本版状态 |
|---|---|---|---|
| 25 | cold-idle 自动清理 | 空闲冷进程定时 stop | **缺失**（好做：idle 超时→compact） |
| 26 | 准入/限速 | agentStartCoordinator 队列+rate limit | **缺失** |
| 27 | 用量统计 | runtimeAccountUsage 收集 provider 配额 | **部分**（usage() 已接 pi-durable 原生） |
| 28 | 模型探测 | runtime_models:detect / providerProbe | **已有**（detectEnvProviders） |
| 29 | 磁盘自洁 | raftDiskJanitor 清 daemon 自己的垃圾 | **缺失** |
| 30 | 配置/密钥 | SLOCK_HOME + api-key-file + bundledPiOAuth | **部分**（env provider 自动映射） |
| 31 | 日志/诊断上传 | feedbackTranscript/traceBundle 上传 server | **缺失**（本地 transcript 已有，上传缺） |
| 32 | 自升级 | computer:upgrade/restart 由 server 触发 | **不适用**（独立交付后可做成版本检查） |

## 四、生态/可扩展面

| # | 功能 | daemon | 本版状态 |
|---|---|---|---|
| 33 | 多 runtime | claude/codex/gemini/grok/kimi/cursor/copilot/opencode | **缺失**（结构性：外部 CLI 只能整轮续跑） |
| 34 | managed MCP 工具 | 走本地回环 HTTP 代理注入 token | **缺失**（可做成 conversation 工具） |
| 35 | 内置 app（cleaner/reminder） | typed inbox 通知 | **缺失**（reminder 值得先做） |
| 36 | skills 列表 | agent:skills:list | **缺失** |
| 37 | 消息历史/附件渲染 | historyFormatting/attachmentFormatting | **部分**（envelope 已做，附件没做） |
| 38 | agent 启动 wiki | agent:start:wiki / ensure-wiki | **缺失**（低优先） |

## 结论：产品该长什么样（下一步设计输入）

原 daemon 是"一台机器上被 server 编排的 agent 宿主"。没有 server 它什么都不是。
**本版产品 = daemon + server 合一的自包含 durable 多 agent 宿主**：一个人一条命令
跑起来，开浏览器就能用。核心卖点必须是原版做不到的：**kill -9 之后接着干活**
（原版的崩溃恢复是重连进程，本版是状态先行）。

必须补的最小闭环（按价值排序）：
1. **Web 控制台**（#7）——没有界面就不是产品
2. **agent↔agent 路由回环**（#4）——群聊是 raft 的灵魂
3. **提醒/定时唤醒**（#9）——"长驻"体验的关键差异
4. **machineLock + cold-idle + 限速**（#23/25/26）——交付级可靠性
5. **managed 工具面**（#34）——agent 能 `raft message send` 才形成闭环
6. **cold-wake 简报 recycle**（#8）——成本优化，原版 RFC 070 的精华

明确不做：多机迁移/接管、非 pi runtime、server 集群协议、自升级。
