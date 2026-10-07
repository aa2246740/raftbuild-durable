# raftd — 打不死的 agent 宿主

单进程、单文件的 durable 多 agent 服务：每个 agent 是一条 pi-durable 会话，
状态全部先落盘再跑——`kill -9` 之后重启进程，agent 从断点原地续跑，消息一条不丢。

Raft daemon 靠监管外部 CLI 进程做长驻会话；raftd 用
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) 原语把同样的职责
重新表达了一遍，且核心场景实测更强（详见 `docs/function-map.md`）。

## 一分钟上手

```bash
pnpm install
export ZAI_CODING_CN_API_KEY=...        # GLM coding plan；也可用 $zhipu / MINIMAX_CN_API_KEY

cd packages/agent
pnpm cli serve                         # daemon + 路由 + 提醒 + Web 控制台一次起来
# → 打开 http://127.0.0.1:4777
```

控制台里：建 agent、发消息、看它实时跑工具、收它发回 "main" 的汇报、挂提醒。
命令行是同一份能力的薄客户端——serve 活着时自动走 HTTP，不会双开 storage：

```bash
pnpm cli create scout --instructions "你是侦察员，查到信息就 send_message 给 main"
pnpm cli send scout "看看今天有什么新闻"
pnpm cli main                        # 操作员收件箱：agent 发给你的消息
pnpm cli remind scout "in 30m" "汇报进展"   # durable 定时器，重启不丢
pnpm cli list / events / outbox / lifecycle / usage / inspect
```

想让 agent 互相对话？它们自带 `send_message` 工具：发给你的指令里写
「查完发给 reviewer」即可；`target:"main"` 进操作员收件箱。投递经过 durable
outbox——至少送达一次，`requestId` 去重保证恰好一次入库；不存在的目标会
弹回发件人而不是悄悄消失。

## 可靠性承诺（全部有 e2e 实测）

- **进程死了接着跑**：SIGKILL 中途，重开 stateDir 后续跑完成，结果恰好一次送达
- **恰好一次**：outbox 先写后发、单在途、精确 ack、重传退避；路由帧带 `route:<agent>:<seq>` 幂等键
- **溢出 fail-closed**：outbox 满 128 先丢最老 `turn_completed`，没得丢就标记 unreliable，人工 `resolve` 才恢复
- **双开拒绝**：`raftd.lock`（pid+token）防止第二个 serve 抢 storage；CLI 自动降级成 HTTP 薄客户端
- **工作区沙箱**：每个 agent 的工作目录被约束在 `workspaces/` 下一级
- **可打断**：`steer` 往运行中的轮次里插话；`whenBusy` 三档（steer/followUp/排队）
- **冷唤醒回收**：agent 静默超过阈值，下条消息先自动压缩上下文再跑——长驻不费 token
  （serve 默认 30m，`RAFTD_COMPACT_IDLE_MS=0` 关闭，e2e phase K 实测）

## 布局

| 路径 | 是什么 |
|---|---|
| `packages/agent/src/daemon.ts` | 核心：DurableDaemon（注册表/收发/lifecycle/路由/提醒） |
| `packages/agent/src/outbox.ts` | write-ahead 外发队列 |
| `packages/agent/src/router.ts` + `messaging.ts` | agent↔agent 路由 + `send_message` 工具 |
| `packages/agent/src/serve.ts` + `consoleHtml.ts` | HTTP API + 零构建 Web 控制台 |
| `packages/agent/src/reminders.ts` `machineLock.ts` | durable 定时器、单实例锁 |
| `packages/agent/e2e/` | 真模型端到端验证（报告写 `e2e/report.md`） |
| `reference/raft-daemon/` | 原 daemon 源码，**只读参考**（FSL-1.1-ALv2 © Botiverse） |
| `docs/function-map.md` `docs/product.md` | 功能地图（38 项对照）/ 产品决策记录 |

## 验证

```bash
pnpm typecheck && pnpm e2e    # 需要模型 key；报告写到 e2e/report.md
```

当前 e2e 覆盖：真实 GLM 问答 / bash 写文件 / SIGKILL 原地复活 / steer 插队 /
outbox 十项不变量 / agent 互发消息 / 收件箱 / 弹回 / 提醒触发 / 锁与双开 /
serve HTTP+控制台+薄 CLI / 冷唤醒压缩。

## 常见问题

- **端口被占**：`pnpm cli serve --port 4999` 换个端口。
- **"state dir already locked"**：上一任 serve 还活着（看 pid），或者它非正常死亡留下了
  `raftd.lock`——确认进程真死了就删掉 state 目录里的 `raftd.lock` 再启动。
- **agent 不回答 / `no_model`**：没设 key。`export ZAI_CODING_CN_API_KEY=...`
  （或 `export zhipu=...`），重启 serve。
- **状态在哪**：`--state` 指定目录（默认 `./.raftd`），里面有 SQLite + workspaces +
  transcripts + deliveries。备份=拷目录；删除=连目录一起 `rm -rf`。
- **CLI 报 `no remote path`**：serve 活着但这条命令只能本地跑——先停 serve 或直接开新 stateDir。

## 明确不做的

多机接管（pi-durable 一份 storage 只能一个 Harness 持有——结构性边界）、
非 pi 的外部 CLI runtime（要子进程监管，和 durable 模型冲突）、serve 集群化。
边界和理由都写在 `docs/product.md`「不做清单」。
