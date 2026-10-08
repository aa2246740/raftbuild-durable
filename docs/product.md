# raftd — 产品设计（第一性原理）

## 一句话
**一条命令跑起来的 durable 多 agent 宿主**：agent 长驻、可互相说话、人通过 web/CLI 对话；
进程被 `kill -9` 之后原地复活接着干活。daemon 与 server 合一，单机即完整产品。

## 目标客户与核心场景
个人/小团队，想要"几个一直在的 AI 同事"：跑在自己机器或一台云主机上，
开个页面就能给它们派活，它们互相协作，机器重启了接着来。

核心场景（必须端到端可用）：
1. `raftd serve` 起服务 → 浏览器打开控制台 → 创建 agent → 发消息 → 看到回复
2. 给 agent A 说"让 B 做 X"→ A 用工具把消息发给 B → B 回复到 main → 控制台可见
3. "两小时后提醒我跟进 X"→ 到点 agent 被唤醒执行
4. `kill -9 raftd`（或机器重启）→ 重启后所有 agent 接着跑，不丢消息不丢结果

## 架构

```
┌───────────── raftd serve ─────────────────────────┐
│  HTTP API + Web 控制台 (内嵌, 无构建步骤)            │
│  Router: outbox 帧 → 目标 agent / main inbox        │
│  Reminders: durable 定时器 → postMessage            │
│  machineLock: 单实例锁                               │
│  ┌─────────── DurableDaemon ────────────┐          │
│  │ pi-durable Harness                    │          │
│  │  · ownerless conversations (agents)   │          │
│  │  · session docs: registry/outbox/      │          │
│  │    mainInbox/timers                    │          │
│  │  · CodingTools + send_message 工具      │          │
│  └──────────────────────────────────────┘          │
│  SQLite stateDir (session.sqlite)                  │
└────────────────────────────────────────────────────┘
raftd CLI → 同一份 stateDir
```

## 关键决策（stakeholder 拍板记录）

1. **路由走 outbox，不走后门**。agent 的 `send_message` 工具写入 outbox 帧
   （`agent:message`），路由泵消费后投递——崩溃恢复与恰好一次白拿。
   dedupe key = tool callId，重试不双发。
2. **`target=main` = 人类控制台**。agent 发 main → 进 `raft.mainInbox` session doc，
   web 控制台展示。人发 agent → postMessage 信封 `@operator`。
3. **不造 runtime**。只 pi+pi-ai；别的 CLI 结构性降级，不做。
4. **Web 控制台单文件 HTML**，serve 内嵌，零构建依赖。
5. **提醒 = durable timers doc + 重启重装 setTimeout**。不引入 cron 依赖。
6. **machineLock 抄语义**：锁文件 {pid, token, startedAt, pidStart}，活锁拒绝，死锁接管（接管互斥目录有 owner.json 身份，活持有者——含被 SIGSTOP 冻结的——永不被强占）。
7. **cold-idle → compact**：空闲超时调 pi-durable compaction（若有 API）；
   没有就冻结 pump，保留 e2e 可验的简单行为。
8. 不做：多机接管/迁移、server 集群、自升级、外部 CLI runtime。

## 超越原版的卖点
- **崩溃即恢复是默认体验**：kill -9 → 继续跑，不需要任何 attach 运气
- **一条命令完整平台**：原版要 raft server，本版单机全链路
- **agent 群聊带恰好一次送达**：outbox 纪律用在每条消息上
- **控制台内置**：原版 UI 在 server 端

## 交付清单（Done 的定义）
- [x] `pnpm cli serve` 起全套（路由+提醒+HTTP+UI+锁）
- [x] 浏览器控制台：agent 列表/创建/发消息/看回复/事件流/outbox/生命周期
- [x] agent↔agent 消息实测（工具调用触发真实投递）
- [x] 提醒到点唤醒实测
- [x] 双开拒绝实测（machineLock）
- [x] e2e 全绿（含新 phase），report.md 更新
- [x] README 面向客户重写（安装/启动/使用）
- [x] PR 开出来（#1）
- [ ] 部署到云（deploy/ 已备好，待批准后上线）
