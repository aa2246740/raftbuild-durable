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
- **server 连接不存在（第一轮）。** daemon 的 websocket/server 协议层没有对应物；
  "上游"抽象成 `OutboxTransport.send()`，默认实现是本地 JSONL 送达账本。
  → 第二轮已改为产品化 `serve`：daemon+HTTP API+Web 控制台单进程合一，
  路由回环直接消费 agent:message 帧（见下"第二轮新增"）。
- **活动追踪/telemetry 大幅精简。** 保留 token_usage 归一化（`piEventNormalizer` 同款）
  和错误指纹；不移植 OpenTelemetry 全套。

## 第二轮新增（产品化，2026-10-07）

| 新模块 | 干什么 | 怎么 durable |
|---|---|---|
| `messaging.ts` | `send_message` 工具：agent→agent/main | 工具在自己 `api.commit` 里把 `agent:message` 帧写进本人 outbox doc（write-ahead） |
| `router.ts` | 路由回环：`RoutingTransport` 拦截 `agent:message` 帧转 `routeMessage()` | `requestId = route:<agentId>:<clientSeq>` 幂等键 → 恰好一次入库；`main` → `raft.mainInbox` session doc |
| `serve.ts` + `consoleHtml.ts` | HTTP API + 零构建单文件控制台 | `POST /api/agents`、消息、events/outbox/lifecycle、answer 长轮询、`/api/state` 一把抓 |
| `reminders.ts` | durable 定时器（"in 30m"/"every 1h"/"at 14:30"/ISO） | `raft.reminders` session doc 落盘 + 进程内 setTimeout；重启重新布防，到期以 systemNotice 投递（`requestId=reminder:<id>:<dueAt>` 防重） |
| `machineLock.ts` | 单实例锁 `raftd.lock`（pid+token） | serve 启动时拿锁；第二个 serve 直接拒起；CLI 其他命令发现 `raftd.port` 就降级成 HTTP 薄客户端——两个 Harness 永不同时开一份 storage |
| 冷唤醒回收（RFC 070） | 静默超阈值→下条消息先 compact 再跑 | `compactOnWakeMs` 只看本 daemon 目击的活跃（重启不算 idle，不白烧模型调用）；compact 失败仅 `onWarn`，不挡消息。serve 默认 30m，`RAFTD_COMPACT_IDLE_MS` 覆盖 |
| `cli.ts runRemote` | 薄客户端模式 | 有 `raftd.port` 且 API 可达 → 全部命令走 HTTP |

**语义要点**：路由投递不是"尽力而为"——帧先 commit 进 outbox 才路由，路由失败
（unknown target）显式 bounce 回发件人（`route-bounce:` requestId），不会无限重传。

## 第三轮新增（评审加固，2026-10-07）

两个干净上下文的 subagent 扮用户批了 UX 和可靠性，以下修复全部按发现落地：

| 缺陷 | 修法 |
|---|---|
| **运行中创建的提醒不触发**（ReminderService 只在 start 时布防一次） | daemon `remind/reschedule/delete` 后调 `reminderHook` → `resync()` 全量对账布防，新提醒即时生效（e2e 实测） |
| `every 0s` 提交风暴把 outbox 打 unreliable | `parseWhen` 对重复提醒地板 ≥1s，直接报错拒绝 |
| setTimeout >24.8d 溢出 → 远未来提醒立即触发且被消费 | delay 钳制到 INT32_MAX、唤醒时复查 dueAt（早醒重新布防）；投递失败保留行等下次启动重试，不再静默删除 |
| **薄 CLI 静默降级**：serve 不可达时本地再开一个 Harness → 双写 SQLite → session poisoned | 有 `raftd.port` 且不可达 → 直接报错退出，绝不本地打开；`deliveries` 也补了远端路径 |
| 发给 stopped/unreliable 目标的帧永久重传、堵住发送方 outbox | `routeMessage` 把 `AgentRegistryError`/`OutboxError`/`override=stopped` 归为永久失败 → 终态 bounce（`route-bounce:`）而非无限重试 |
| `main` 收件箱无幂等：重传帧双写 | 投递用确定性 `msg-<agentId>-<clientSeq>` id 去重 |
| 双 Harness 竞发同一帧（claimed 丢失即送） | 泵的 mark-commit 返回是否真认领，非认领者跳过 send |
| `producedSubmissionIds` 环形 256 → 老 submission 驱逐后可再产帧 | 上限升 4096；幂等记忆全程 durable，仅最远尾部老化出列 |
| pump 的 `onEvent` 监听器抛异常 → CommittedWatch 静默死 | emit 对每事件 try/catch，异常走 `onWarn` |
| `attachPump` check-then-set 竞态 → 同一对话双订阅 | 同步先占位（placeholder），并发 attachPump 立即返回 |
| `produceOutcome` 对 sticky/错误 turn 编造 `turn_completed{textEvents:1}` | 如实出 `terminal_failure`（sticky/运行错误）或真 0/0 计数，绝不虚构 |
| `requeueInFlight` commit 失败静默 → in-flight 条目永久卡死 | 失败写入 `memoryUnreliable`：append/pump 立即报错，`resolve` 清除 |
| MachineLock：EPERM 判死（夺走他人进程锁）、existsSync+writeFile 竞双持、重启后 PID 复用误拒 | EPERM→alive 拒绝；O_EXCL 原子创建；存活时比对 `/proc/<pid>/stat` 内核启动时间，不一致=回收 PID→stale 接管 |
| `createAgent` 重名时先建 workspace+conversation 再撞名 | 提前 snapshot 查名 + workspace 路径强校验单层级；任何失败清理 workspace 目录 |
| `daemon.events()` 遇坏行整流断 | 逐行 try，坏行跳过 |
| serve：answer 无超时、畸形 JSON/重名/垃圾 whenBusy 全 500、裸绑 0.0.0.0 无鉴权 | answer 服务端 110s 封顶 → 504；错误映射 400/404/409/504；whenBusy 白名单；非回环无 `RAFTD_KEY` 打警告，`RAFTD_KEY` 设置后 /api/* 全要 Bearer |
| `createAgent` 删 agent 后 transcript/deliveries 文件残留 | `deleteAgent` 连带删除两文件 |
| "Session is poisoned"（评审实测遇到） | 根因是双 Harness 抢同一 SQLite → SQLITE_BUSY → commit 失败 → poison。上述"拒绝第二 Harness"+ 原子锁从根上断掉；重启 + `announceResume` 恢复 |

另：**崩溃重启现在可见**——`resume()` 时若某 agent 尚有 queued/placed 提交，会投递一条
durable systemNotice（"Host restarted — resuming N unfinished submission(s)"），控制台聊天流
和 agent 上下文里都能看见"你被中断过"。

## 建议探索顺序

1. `pnpm e2e` 一键跑端到端验证（真实 GLM 模型：问答→工具调用→崩溃恢复→steer→outbox）
2. `pnpm cli serve` 长驻守护进程；`pnpm cli send <agent> <text>` 发消息
3. 读 `src/daemon.ts` 总装 → `src/outbox.ts` 可靠性 → `src/events.ts` 事件归一化
4. 对照 `reference/raft-daemon/src/` 同名文件看移植取舍

上游示例全集在 pi 仓库 `packages/durable/test/examples/`（00–31，见 earendil-works/pi
GitHub 仓库）；本仓库内可直接跑 `pnpm example:recovery`（examples/13-recovery.ts）。
（GitHub issue #2 评审修复）

| 发现 | 修法 |
|---|---|
| MachineLock 并发/接管双竞态 | tmp 文件 + `link()` 原子创建（读者永远看不到半写锁）；接管 `rename()` 原子认领后删 |
| `markUnreliable` 持久化失败丢内存标 | 先置 `memoryUnreliable`，只有显式 `resolve` 能清 |
| 送达账本 (agentId,clientSeq) 可重复 | `JsonlDeliveryTransport` 启动回放 ledger 建 seq 集合，重复 clientSeq 直接跳过 |
| outcome 提交与 registry 投影可被崩溃拆开 | `outbox.append(frame, key, inTx)` —— 帧+幂等键+AgentsDoc 投影一个事务落；重复路径幂等修复 |
| SIGKILL 后工具孤儿进程残留 | `open()` 时扫 `/proc`：cwd 在 workspaces/ 下的进程按 pgid 整组 SIGKILL（Linux 尽力而为）；文档不再说 "no child processes" |
| "workspace 沙箱" 名不副实 | 文档改口：cwd 约定非硬隔离 |
| 非 loopback 无 RAFTD_KEY 只警告 | 拒绝启动；`RAFTD_INSECURE=1` 显式裸奔；薄 CLI 自动带 Bearer |
| `main` 可被创建但收不到路由 | createAgent 拒绝该名（保留给 operator inbox） |
| answer 路由不验归属 | 先 404 解析 agent，再校验 submission ∈ 其 conversation |
| 默认模型写死 GLM | `pickDefaultModel(providers)` 按已配置 provider 选 |
| Node ≥22.7 声明错误 | README/`engines` 改 ≥24（`node:sqlite`） |
| HTTP 校验一堆洞 | body 非 object→400、name/text/when 类型+非空→400、busy reject→409、`at 25:99`→400 |
| 提醒投递失败丢定时器 | fire 失败 → +60s 重布防；startAgent/resolveAgent 触发 resync |
| 薄 CLI remote 不一致 | create 转发 workspace/thinking；`deliveries` 无参走 `/api/deliveries`；HTTP 错误原文上抛不伪装 unreachable |
| 控制台发送失败清输入 | 成功才清空；错误横幅提示；390px 窄屏纵向布局 |
| IPv6 `--host ::1` | URL/端口文件都带 `[]` |
| 云包装层 | 认证化就绪探测、`?key=`→Bearer 注入、child 死后按需重生+503 healthz、SIGTERM 收 child、`/setup/env` 全 provider+merge 不重写 |

## issue #2 二轮复测修复（PR #3 追加）

| 发现 | 修法 |
|---|---|
| stale-lock 接管仍在 inspect→replace 窗口竞态 | 换协议：`<lock>.takeover/` mkdir 原子互斥，临界区内重新 inspect（inode 变化=让位），删锁改 unlink，link() 仍是唯一创建通道。32并发×60轮实测单持有者 |
| 孤儿清理误杀/漏杀（cwd 归属） | 台账制：`activeChildPids.add` 挂钩在 spawn 时记 {pid,内核starttime} 到 `tool-children.jsonl`（三轮改为 `serve` 拿锁后收割，见下表） |
| 升级旧状态 outcome 重复计数 | legacy 迁移：`projectedSubmissions === undefined` 的 record 由 reconcile 重建（三轮改为从 settled submissions 重算 counters/lastOutcome/terminalFailure，见下表） |

| whenBusy=reject 返回 500 | statusFor 正则放宽 `\bis busy\b`（"Conversation 2 is busy" 带 id 不再漏）→409 |
| 390px 输入栏溢出 | composer `flex-wrap` + input `order:-1 flex:1 1 100%`，窄屏两行排列 |
| wrapper 代理全 500 | httpx 0.28 没有 `request(stream=)` → `build_request`+`send(stream=True)`；响应生命周期交给 `StreamingResponse(background=BackgroundTask(aclose))`，去掉非法 `async with` |
| wrapper 公网无鉴权 | 外部 Bearer/`?key=` 先验 admin key 才放行 /api/*、`/setup/*`；admin key=RAFTD_KEY 或持久化 `STATE/admin-key`（自动生成+写日志）；child 用独立内部 key，调用者凭据不转发 |
| SIGTERM 杀 child 但父不退 | 删自定义 signal handler，child 清理挪进 FastAPI lifespan shutdown，uvicorn 退出链路完整 |
| Docker 打包过期 daemon | 删 tracked `repo.tar.gz`；Dockerfile 改从仓库根 COPY 当前源码构建；fly.toml 移到根 + `dockerfile=deploy/Dockerfile`；加 `.dockerignore` |
| wrapper 升级丢旧配置/query-key | `_load_envfile()` 合并 `STATE/child.env`→`DATA/.env`（旧 key 保留）；setup 端点恢复接受 `?key=` |

## issue #2 三轮复测修复（PR #3 追加）

| 发现 | 修法 |
|---|---|
| takeover 互斥 30s-mtime 强拆会杀掉被 SIGSTOP 冻结的活持有者 | `owner.json` 身份文件：{pid, token, startedAt, pidStart}；owner 活（含 T 态）→ 永不收割；死/僵死/pid 复用 → 立即收割；无 owner 文件才退回 30s mtime；rm 前复查 inode+owner（防收割-重建 TOCTOU） |
| 台账漏掉 leader 死后的后台进程组、pid 复用历史、缺 start 行误杀 | leader 死 → 枚举 pgrp=pid 的全部存活成员整组 SIGKILL（成员启动时间须 ≥ leader 启动时间——复核后删掉了会系统性漏杀的上界）；pid 复用不消费；缺 start 保守跳过 |
| 二次 `serve`/`open` 会在拿锁前收割活 daemon 的子进程 | 收割移出 `open()`：`serve` 在 `MachineLock.acquire` 之后才跑 `reapOrphanedToolChildren()`；一次性命令永不收割 |
| 老库丢投影被祖父条款掩盖 | 不再跳过：从 durable settled submissions 重建 runs/failures/lastOutcome/terminalFailure，幂等 |
| zombie 锁主被 kill(0) 判活 | `processAlive` 先读 /proc state（Z/X/x=死），无 /proc 才退回 kill(0)/EPERM |
| wrapper 崩溃后并发首请求 15/16×502 | `_ensure_up()` 共享 bring-up 任务，所有请求等同一个；硬拒绝显式 503（`_bring_up` 异常也归一为 False） |
| 薄 CLI 在 wrapper/Docker 里 401 | `raftd.port` 写公网入口 `127.0.0.1:$PORT`；子进程端口另存 `raftd.internal-port` |
