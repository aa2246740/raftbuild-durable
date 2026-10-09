# Raft 平台全量功能地图（botiverse/raft-source 上游拆解）

目标：**功能完全复刻，内核建在 pi-durable 上**。
上游单体规模：server 1182 ts / web 666 ts / cli 250 ts / ~150 张表 / 60 个路由文件 / Socket.IO 实时层 / 15 个 package。

License：FSL-1.1-ALv2 source-available —— 内部使用/修改允许，不可与 Botiverse 竞争；保留 LICENSE 署名。

## 包结构（上游 15 个）

| 包 | 职责 | 规模 |
| --- | --- | --- |
| `server` | REST API + Socket.IO 实时 + Postgres 持久化 + 全部集成 | 174M·1182ts |
| `web` | React SPA 客户端（页面+组件+状态库） | 21M·666ts |
| `cli` | `raft` 命令行——agent 面向的执行/查询层（MCP-parity 命令族） | 250ts |
| `daemon` | 机器侧守护：起 agent 进程、代理凭证、outbox 回传 | 6.5M |
| `computer` | computer runtime + 安装器（自托管机器） | 2.4M |
| `raft-sdk` | 客户端 SDK | 552K |
| `shared` / `sync-core` / `trace-*` / `runtime-form` / `ui-inventory` / `desktop-contract` / `raft-event-buffer` | 契约与支撑库 | ~2M |

## 功能域拆解（按子系统）

**A. 账号/会话**：users、auth identities、session families+refresh rotation+吊销逐出、social auth、device auth、legal acceptance、email verification/password reset
**B. 服务器/成员**：servers、成员/角色/协议、加入链接/邀请、announcements、labs(实验)+feature flags（含 rollout 审计）
**C. Agent 体系**：agents、runtime profiles、migrations（跨机迁移+chunk receipts）、server membership、bootstrap tokens、scopes、credentials、provider connections/probe
**D. 频道/消息**：channels、DM identities、**joint channels**（跨 server 联合）、channel conversion jobs、channel agents/humans、messages+timeline、reactions/translations、mentions、thread follows、read cursors/inbox states、attested send（草稿见证发送）
**E. 实时**：Socket.IO、fanout、room targeting、access revocation（吊销即逐出订阅）
**F. 任务/工作流**：tasks+events、workflow templates/instances/step instances、durableTasks
**G. 通知**：notification events/recipients/deliveries/attempts、push（web+mobile+native）、inbox suppression、agent inbox push+pending acks
**H. 附件/存储**：attachment objects+artifacts、upload sessions/reservations、transfer intents、GC jobs、inventory runs、share artifacts、external assets
**I. 第三方/集成**：external app registrations+secrets+server grants、ingress endpoints、actor projections、inbound events、outbound deliveries（~20 表，完整 iPaaS 层）、oauth clients+installs+grants+tokens、webhooks、Slack bridge（独立 outbox）、managed MCP servers
**J. 计费/产品**：billing 路由+subscriptions、product events、feedback、newsletter、release notes、usage months
**K. 机器/daemon**：machines、computers、lifecycle operations+targets、upgrade requests、outage occurrences、managed MCP assignments、agent credential proxy（loopback origin-bound per-launch token）
**L. CLI 命令面**（agent-facing 契约）：message/task/channel/thread/dm/inbox/mention/reminder/agent/integration/knowledge/action/attachment/profile/server/app/manual——`raft <resource> <action>`、canonical text/--json、ref 语法 `#channel` `dm:@peer` `~agent|~human` 消歧
**M. Web 界面**：登录/设备授权/PublicServer、频道+线程+DM、任务、agent 管理、machine 管理、server 设置、成员、onboarding、搜索、embed、PWA、桌面握手

## 复刻架构决策（stakeholder 拍板）

**复用代码，替换底座。** FSL 允许内部使用/修改——逐字重写 1182 个文件是浪费：
- `server/web/cli/shared/sdk` **vendor 进本仓库**，保持行为 1:1
- **Postgres → PGlite**（嵌入式 Postgres WASM，Drizzle 原生支持，schema 不改）
- **Redis → 进程内 pubsub shim**（replicaRouter/fanout/accessRevocation 的面窄）
- **APM/machine-daemon → 我们的 raftd（pi-durable）**：实现 server 对 daemon 的全部契约（daemon.ts 路由、machine register、agent lifecycle、outcome outbox ingest、credential proxy）—— raftd 注册为一台 computer
- Socket.IO、React、CLI 不动

**验收参照**：先把上游 stack 本地跑起来（Postgres+Redis+server+web+daemon），同一组 e2e 场景在我们的版上重放。

## 阶段路线图

- **P0** 上游本地跑通（容器起 Postgres/Redis/minio）→ 录参照行为
- **P1** vendor：upstream 拷入 `upstream/`，workspace 能 install+build
- **P2** infra 替换：PGlite adapter + in-proc redis + 单进程编排（raftdev 等价物 `raftd stack`）
- **P3** daemon 桥：raftd(pi-durable) 实现 machine/daemon 契约，agent 跑在 pi-durable 会话里
- **P4** e2e 验收：登录→建频道→人↔agent 对话→任务/提醒/附件 → 录屏对比上游
- **P5** 集成层补齐：Slack bridge / oauth / joint channels / computer installer（按需排期）

风险最大：P3 契约面（daemon↔server 的全部消息格式+凭证代理+inbox/outbox 语义）与 P2 的 PG 专属 SQL 兼容。每个阶段独立 PR。
