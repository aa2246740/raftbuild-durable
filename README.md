# raftd — 打不死的 agent 宿主

单机 durable 多 agent 服务：每个 agent 是一条 pi-durable 会话，
状态全部先落盘再跑——`kill -9` 之后重启进程，agent 从断点原地续跑，消息一条不丢。

Raft daemon 靠监管外部 CLI 进程做长驻会话；raftd 用
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) 原语把同样的职责
重新表达了一遍，且核心场景实测更强（详见 `docs/function-map.md`）。

## 一分钟上手

需要 **Node 24 或 26** + **pnpm 10.20.0**；CI 覆盖这两个 Node 主版本。
直接运行 TypeScript，使用原生类型剥除和 `node:sqlite`，不需要实验启动参数。
Node 26 不内置 Corepack，可用 `npm install --global pnpm@10.20.0` 安装。

```bash
pnpm install
export ZAI_CODING_CN_API_KEY=...        # GLM coding plan；也可用 $zhipu / MINIMAX_CN_API_KEY

cd packages/agent
pnpm cli serve                         # daemon + 路由 + 提醒 + Web 控制台一次起来（前台常驻）
# → 打开启动日志中带 #key= 的控制台链接（本地也默认鉴权）
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
pnpm cli list
pnpm cli events scout
pnpm cli usage scout
pnpm cli update scout --name researcher
pnpm cli inspect
```

想让 agent 互相对话？它们自带 `send_message` 工具：发给你的指令里写
「查完发给 reviewer」即可；`target:"main"` 进操作员收件箱。投递经过 durable
outbox——至少送达一次，`requestId` 去重保证恰好一次入库；不存在的目标会
弹回发件人而不是悄悄消失。**普通回答只保存在当前 agent 会话**；回信必须显式
`send_message` 到信封里的 `reply_to`，向操作者汇报必须显式发到 `main`。
同一消息链默认最多 8 跳，每 agent 默认每分钟最多 30 条；超限停止转发并通知 main。
可用 `RAFTD_MESSAGE_MAX_HOPS` / `RAFTD_MESSAGE_RATE_PER_MINUTE` 调整。

没有 serve 时，`send` / `steer` 只持久入队，不执行任何 agent；启动 serve 后处理队列。
在线等待默认不限时，HTTP 等待窗口超时会自动续等：

```bash
pnpm cli send researcher -m task.txt --timeout 5m
pnpm cli wait researcher <submissionId> --timeout 10m
```

超时不取消后台任务，CLI 会给出继续查询命令。`abort` / `stop` / `start` / `resolve` /
`reset` / `compact` / `delete` 需要正在运行的 serve，以免一次性命令唤醒并截断其它工作。

## 行为与边界

本轮修复、测试入口和未覆盖项见 [issue #5 验收记录](docs/issue-5-validation.md)。

- **进程死了接着跑**：SIGKILL 中途，重开 stateDir 后续跑完成，结果恰好一次送达
- **恰好一次**：outbox 先写后发、单在途、精确 ack、重传退避；路由帧带 `route:<agent>:<seq>` 幂等键
- **溢出 fail-closed**：outbox 满 128 先丢最老 `turn_completed`，没得丢就标记 unreliable，人工 `resolve` 才恢复
- **双开拒绝**：`raftd.lock.sqlite` 的持久连接写事务保证单实例；进程退出由操作系统释放，暂停仍持锁。CLI 在打开 storage 前拿锁，已有 serve 时走 HTTP 薄客户端
- **工作区约定**（诚实说明：不是硬沙箱）：每个 agent 的工具默认在自己的 `workspaces/<agent>/` 目录里跑，创建时拒绝已有目录、文件和符号链接，只初始化并登记本次独占的工作区；但 shell 工具按 cwd 执行，`cd ..` 之类的显式越界没有内核级隔离——别把它当安全边界，真正的边界是模型行为
- **可打断**：`steer` 往运行中的轮次里插话；`whenBusy` = `steer`（插话）/ `followUp`（跑完此轮接着跑）/ `reject`（忙则拒绝）；不给=排队
- **冷唤醒回收**：agent 静默超过阈值，消息先持久入队，在空闲边界异步压缩上下文；steer 不等待维护任务
  （serve 默认 30m，`RAFTD_COMPACT_IDLE_MS=0` 关闭，e2e phase K 实测）
- **联网安全**：`--host` 绑公网地址时**必须**设 `RAFTD_KEY`——不设就拒绝启动
  （`RAFTD_INSECURE=1` 显式放弃鉴权才会放它裸奔）。回环监听默认生成 0600 的 `raftd.token`；薄 CLI 自动读取，或优先使用 `RAFTD_KEY`。
  控制台接受启动链接 `#key=`，导入后立即清除地址栏凭据；401 显示登录表单并暂停轮询。
  mutation 只接受 JSON，请求体最多 1 MiB，Host/Origin 必须匹配。自定义域名加入
  `RAFTD_ALLOWED_HOSTS`（逗号分隔、不含端口，仅为同一 HTTP 监听端口的域名别名）；HTTPS 反代通过 wrapper。`main` 大小写不敏感保留。
- **SIGKILL 时的工具子进程**（诚实说明）：daemon 被 `kill -9` 时，工具正在跑的子进程会成孤儿。
  spawn 时会把子进程的 pid+内核启动时间记进 `tool-children.jsonl` 台账，下一次 `serve` 拿到实例锁后
  收割台账里的进程组（含 leader 已死的后台进程组）——不误伤你在 workspace 里跑的其它程序，
  进程「cd 走」也逃不掉。台账有天生盲区：spawn 与记账之间的极端窄窗（微秒级）仍会漏网，视为尽力而为而不是硬保证

- **工作区删除**：默认保留。显式删除也必须通过创建时记录的归属和目录身份校验；旧版本没有归属记录的目录保守保留。创建失败不会删除原有数据。
- **工具环境**：shell 不继承宿主全部环境。保留基础 PATH/HOME/LANG/TERM 等，额外变量通过 `RAFTD_TOOL_ENV_ALLOW` 指定；provider key、宿主凭据和 token 始终排除。这不提供文件系统或网络沙箱。
- **生命周期**：abort 后回 idle；最终失败为 terminal，需要 start/resolve/reset 后继续；cooldown 只表示当前轮内的重试。unreliable 直接可见并要求 resolve；最终成功不会沿用之前的瞬时错误作为失败结果。
- **提醒**：只接受 `in 30m`、`every 1h`、`at 14:30` 或带时区的严格 ISO 时间，拒绝过去时间。命令显示解释时间所用的时区；Fly 默认保留常驻机器使提醒和长任务继续运行。

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
python3 -m pip install ./deploy      # Python ≥ 3.11；wrapper 的 FastAPI / Uvicorn / HTTPX
pnpm typecheck && pnpm test:reliability  # 无模型 key：官方 faux provider、真实 HTTP/CLI/工具进程和 wrapper
pnpm typecheck && pnpm e2e    # 需要模型 key；报告写到 e2e/report.md
```

`test:reliability` 覆盖跨进程锁竞争、暂停/崩溃、发布失败、4095/4096/4097 条历史、
迁移中断恢复、默认入口、HTTP 对抗校验、工作区归属、工具环境、路由/提醒、CLI 等待及 wrapper。
浏览器回归：`python3 -m pip install playwright`、`python3 -m playwright install chromium`，再运行
`python3 packages/agent/test-browser/console.py`。完整故障套件在 Linux 上运行；
Node 锁测试中依赖 Linux `/proc` 的场景在其他平台明确跳过。
GitHub Actions 在每个 PR 和 main 推送时运行 Node 24/26 回归，以及独立 Chromium 控制台验收。
Docker 自验使用真实 `/data/raftd`，先从 HTTP 创建 agent，再要求 CLI 读到同一个 agent 并拒绝错误 key。

当前 e2e 覆盖：真实 GLM 问答 / bash 写文件 / SIGKILL 原地复活 / steer 插队 /
outbox 十项不变量 / agent 互发消息 / 收件箱 / 弹回 / 提醒触发 / 锁与双开 /
serve HTTP+控制台+薄 CLI / 冷唤醒压缩 / 加固回归（活提醒、stopped 弹回、坏行容忍、锁竞争、
stale port 拒开、API 400/404/409）/ issue-#2 三轮边界回归（SIGSTOP 锁持有者、zombie 锁主、
后台进程组收割、丢投影重建、wrapper 16 并发共享启动、薄 CLI 经公网口、Docker 真构建+源码一致性）。

## 常见问题

- **端口被占**：`pnpm cli serve --port 4999` 换个端口。
- **"state dir already locked"**：同一 state 已有持锁进程，暂停进程也仍持锁；异常退出会自动释放。
  `raftd.lock` 仅记录 pid/token 供诊断，不能靠删文件解锁。`raftd.lock.sqlite` 和
  宿主发现锁 `raftd.wrapper.sqlite` 必须保留，
  运行时不可删除、替换或通过普通文件读写操作打开它。锁依赖本地文件系统的 SQLite 锁语义；
  升级前先停止旧 daemon，不同时运行使用旧目录锁协议的二进制。
- **agent 不回答 / `unanswered: no_model`**：一个 provider key 都没读到。
  认这些变量名：`ZAI_CODING_CN_API_KEY` / `zhipu` / `ZAI_API_KEY` /
  `MINIMAX_CN_API_KEY` / `MINIMAX_CN` / `MINIMAX_API_KEY` / `DEEPSEEK_API_KEY` /
  `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`——export 任一后重启 serve。
  没有 provider 时默认 create 也会失败；可以显式 `--model zai-coding-cn/glm-5.3-flash` 创建离线配置，
  但执行仍需设置对应 key 并重启 serve。模型必须是已知的 `provider/modelId`；不会把裸模型名静默换成默认值。
- **状态在哪**：`--state` 指定目录（默认 `./.raftd`），备份=拷目录；删除=连目录一起 `rm -rf`。布局：
  `session.sqlite`（会话+outbox+提醒 全 durable）、`workspaces/<agent>/`（约定工作区）、
  `transcripts/<agent>.events.jsonl`（事件流水）、`.deliveries/`（送达账本，`pnpm cli deliveries`）、
  `raftd.lock.sqlite`（系统锁）、`raftd.wrapper.sqlite`（宿主发现锁）、
  `raftd.lock`（诊断元数据）、`raftd.port`（薄客户端发现）、`raftd.token`（本地/API 凭据，0600）。
- **长历史升级**：每条 outcome 的产帧/投影标记与 frame 和计数原子提交，超过 4096 条不会忘记。
  老版本迁移会参考旧去重表、待发队列和默认 `.deliveries` 账本；使用自定义 transport 且老记录已被
  环形表遗忘、又没有交付账本时，无法确认是否发过，只能按至少一次语义保守补发一次。
  慢/失败 consumer 下仍保留 128 条 outbox 的 fail-closed 规则。
- **`<agent>` 参数**：名字和 agent-id 都行。
- **其余命令**：`show / deliveries / wait / update / stop / start / abort / resolve / reset / compact / reminders`
  全在 `pnpm cli help` 里。
- **CLI 报 "Refusing to open a second local Harness"**：有 `raftd.port` 说明曾有 serve
  占着这份 state。serve 活着→CLI 自动走 HTTP 不用管；serve 死了→先 `pnpm cli serve` 重启，
  或确认没进程在跑后删掉 `raftd.port`（保留该文件是防双开写坏 SQLite）。

## 上云

`deploy/` 是给 Fly.io 准备的完整包裹：`app/main.py` 是个 FastAPI 反代——对外只有 `/healthz` 和
控制台首页公开，其余一律要 admin key（`Authorization: Bearer` 或 `?key=`）；key 取 `RAFTD_KEY`，
没设就自动生成并存进 `/data/raftd/admin-key`（日志只提示文件位置）。公开 key 同步到
`raftd.token` 供薄 CLI 自动读取；这些凭据文件均为 0600。child daemon 用独立的内部 key，
你的 key 只在外层校验、不进子进程。`POST /setup/env`（同样要 key）持久化 provider key 到
`/data/.env`；旧版 `/data/raftd/child.env` 中受支持的 provider 配置会自动并进来。配置拒绝换行/NUL，
凭据文件以 0600 原子写入；任意环境变量不会从配置文件注入 child。

`Dockerfile` 从**仓库根**用当前源码构建（不再打包仓库里的 tar 快照）：

```bash
docker build -f deploy/Dockerfile -t raftd .    # 在仓库根目录跑
fly deploy                                     # fly.toml 也在仓库根
```

状态保存在 `/data` 卷（agent 数据位于 `/data/raftd`，provider 配置为 `/data/.env`）。
Fly 默认至少一台机器常驻并关闭空闲自动停机；进程内提醒需要宿主持续运行。

## 明确不做的

多机接管（pi-durable 一份 storage 只能一个 Harness 持有——结构性边界）、
非 pi 的外部 CLI runtime（要子进程监管，和 durable 模型冲突）、serve 集群化。
边界和理由都写在 `docs/product.md`「不做清单」。
