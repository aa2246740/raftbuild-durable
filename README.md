# raftd — 打不死的 agent 宿主

单进程、单文件的 durable 多 agent 服务：每个 agent 是一条 pi-durable 会话，
状态全部先落盘再跑——`kill -9` 之后重启进程，agent 从断点原地续跑，消息一条不丢。

Raft daemon 靠监管外部 CLI 进程做长驻会话；raftd 用
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) 原语把同样的职责
重新表达了一遍，且核心场景实测更强（详见 `docs/function-map.md`）。

## 一分钟上手

需要 **Node ≥ 24** + **pnpm ≥ 10**（`corepack enable` 一次即可）。
（pi-durable 的 SQLite 存储用 `node:sqlite`，只有 Node 24+ 自带；Node 22.19+ 加 `--experimental-sqlite` 也能跑，但我们按 24 测试。）

```bash
pnpm install
export ZAI_CODING_CN_API_KEY=...        # GLM coding plan；也可用 $zhipu / MINIMAX_CN_API_KEY

cd packages/agent
pnpm cli serve                         # daemon + 路由 + 提醒 + Web 控制台一次起来（前台常驻）
# → 打开 http://127.0.0.1:4777
```

serve 是前台进程——**另开一个终端**（同一个 packages/agent 目录下）再敲后面的命令；
跨目录运行请先 `--state <dir>` 指到同一个状态目录。文档里的 `raftd` = `pnpm cli`
=`pnpm raftd`（真可执行：package bin + `./src/cli.ts` 带 shebang 可直接跑）。

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
- **工作区约定**（诚实说明：不是硬沙箱）：每个 agent 的工具默认在自己的 `workspaces/<agent>/` 目录里跑，创建 agent 时校验名字/路径不可逃逸；但 shell 工具按 cwd 执行，`cd ..` 之类的显式越界没有内核级隔离——别把它当安全边界，真正的边界是模型行为
- **可打断**：`steer` 往运行中的轮次里插话；`whenBusy` = `steer`（插话）/ `followUp`（跑完此轮接着跑）/ `reject`（忙则拒绝）；不给=排队
- **冷唤醒回收**：agent 静默超过阈值，下条消息先自动压缩上下文再跑——长驻不费 token
  （serve 默认 30m，`RAFTD_COMPACT_IDLE_MS=0` 关闭，e2e phase K 实测）
- **联网安全**：`--host` 绑公网地址时**必须**设 `RAFTD_KEY`——不设就拒绝启动
  （`RAFTD_INSECURE=1` 显式放弃鉴权才会放它裸奔）。薄 CLI 读同一个 `RAFTD_KEY` 发 Bearer；
  控制台在 URL 上加 `?key=` 或在页面提示框里输。名字 `main` 保留给操作员收件箱，不可创建。
- **SIGKILL 时的工具子进程**（诚实说明）：daemon 被 `kill -9` 时，工具正在跑的子进程会成孤儿。
  spawn 时会把子进程的 pid+内核启动时间记进 `tool-children.jsonl` 台账，下一次 `serve` 拿到实例锁后
  收割台账里的进程组（含 leader 已死的后台进程组）——不误伤你在 workspace 里跑的其它程序，
  进程「cd 走」也逃不掉。台账有天生盲区：spawn 与记账之间的极端窄窗（微秒级）仍会漏网，视为尽力而为而不是硬保证

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
serve HTTP+控制台+薄 CLI / 冷唤醒压缩 / 加固回归（活提醒、stopped 弹回、坏行容忍、锁竞争、
stale port 拒开、API 400/404/409）/ issue-#2 三轮边界回归（SIGSTOP 锁持有者、zombie 锁主、
后台进程组收割、丢投影重建、wrapper 16 并发共享启动、薄 CLI 经公网口、Docker 真构建+源码一致性）。

## 常见问题

- **端口被占**：`pnpm cli serve --port 4999` 换个端口。
- **"state dir already locked"**：上一任 serve 还活着（看 pid），或者它非正常死亡留下了
  `raftd.lock`——确认进程真死了就删掉 state 目录里的 `raftd.lock` 再启动。
- **agent 不回答 / `unanswered: no_model`**：一个 provider key 都没读到。
  认这些变量名：`ZAI_CODING_CN_API_KEY` / `zhipu` / `ZAI_API_KEY` /
  `MINIMAX_CN_API_KEY` / `MINIMAX_CN` / `MINIMAX_API_KEY` / `DEEPSEEK_API_KEY` /
  `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`——export 任一后重启 serve
  （启动时 0 个 provider 会直接打 warning）。
- **状态在哪**：`--state` 指定目录（默认 `./.raftd`），备份=拷目录；删除=连目录一起 `rm -rf`。布局：
  `session.sqlite`（会话+outbox+提醒 全 durable）、`workspaces/<agent>/`（约定工作区）、
  `transcripts/<agent>.events.jsonl`（事件流水）、`.deliveries/`（送达账本，`pnpm cli deliveries`）、
  `raftd.lock`/`raftd.port`（单实例锁 / 薄客户端发现文件）。
- **`<agent>` 参数**：名字和 agent-id 都行。
- **其余命令**：`show / deliveries / stop / start / abort / resolve / reset / compact / reminders`
  全在 `pnpm cli help` 里。
- **CLI 报 "Refusing to open a second local Harness"**：有 `raftd.port` 说明曾有 serve
  占着这份 state。serve 活着→CLI 自动走 HTTP 不用管；serve 死了→先 `pnpm cli serve` 重启，
  或确认没进程在跑后删掉 `raftd.port`（保留该文件是防双开写坏 SQLite）。

## 上云

`deploy/` 是给 Fly.io 准备的完整包裹：`app/main.py` 是个 FastAPI 反代——对外只有 `/healthz` 和
控制台首页公开，其余一律要 admin key（`Authorization: Bearer` 或 `?key=`）；key 取 `RAFTD_KEY`，
没设就自动生成并存进 `/data` 卷的 `admin-key` 文件（日志里也会打）。child daemon 用独立的内部 key，
你的 key 只在外层校验、不进子进程。`POST /setup/env`（同样要 key）持久化 provider key 到
`/data/.env`；旧版 `/data/raftd/child.env` 的存量配置会自动并进来，升级不丢。

`Dockerfile` 从**仓库根**用当前源码构建（不再打包仓库里的 tar 快照）：

```bash
docker build -f deploy/Dockerfile -t raftd .    # 在仓库根目录跑
fly deploy                                     # fly.toml 也在仓库根
```

状态全在 `/data` 卷里（session.sqlite / workspaces / admin-key / .env），机器回收不丢。

## 明确不做的

多机接管（pi-durable 一份 storage 只能一个 Harness 持有——结构性边界）、
非 pi 的外部 CLI runtime（要子进程监管，和 durable 模型冲突）、serve 集群化。
边界和理由都写在 `docs/product.md`「不做清单」。
