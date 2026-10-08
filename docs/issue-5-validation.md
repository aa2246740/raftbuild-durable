# Issue #5：修复与验收

本轮以 `39b5c253df2e9bae96600b203baf12d4e7f4d6fd` 为基线，处理
[issue #5](https://github.com/aa2246740/raftbuild-durable/issues/5) 的 28 个编号项。
下面区分自动回归、实际进程/浏览器验收和未验证范围；通过数量不代表不存在其它问题。

## 行为变更

- 回环 HTTP 默认鉴权，token 持久化到 `stateDir/raftd.token`（0600）。CLI 自动读取；
  控制台启动链接使用 `#key=`，导入后清除地址栏凭据。公网监听仍要求显式 key。
- 工作区只能独占新建；删除默认保留数据。删除时归属或目录身份校验不符则保留。
  宿主内的创建/删除操作按规范化路径串行执行。
- 无 serve 的 `send` / `steer` 只入队，不执行其它会话。执行和生命周期操作要求 serve 在线。
- `send` 默认持续等待，遇到 HTTP 504 自动续等。`--timeout` 只停止等待；
  `wait <agent> <submissionId>` 可以接着查询，不重复提交。
- agent 普通回答留在本会话；回信需要显式 `send_message` 到 `reply_to`。
  默认每链最多 8 跳、每 agent 每分钟 30 条，重启和工具重放不能重置计数。
- abort 后回 idle；最终失败为 terminal，需 start/resolve/reset 后继续。
  cooldown 仅表示当前轮正在重试；最终重试成功按成功结算。

## 逐项验收对应

表中测试均已提交，除注明的部署配置检查外，不依赖真实模型密钥。

| # | 修复 | 回归与验收 |
|---|---|---|
| 1 | 去掉已移除的 Node transform flag，改为可擦除 TS，启用 `erasableSyntaxOnly` | [runtime][runtime] 验证完整 CLI 导入、shebang、pnpm 入口；CI Node 24/26 矩阵；两版完整 E2E |
| 2 | 默认 token、Host/Origin 校验、JSON 类型和 1 MiB 限制、通用 500、常数时间比较 | [HTTP][http] 实际服务：跨站、伪 Host、无/错 key、声明及分块大包均拒绝且无副作用；[浏览器][browser] 默认登录 |
| 3 | 工具执行明确关闭环境继承，仅传基础变量和白名单，按变量名排除凭据 | [core][core] 实际模型→Bash→模型链路，Bash `printenv` 不含测试的 provider/admin/internal 凭据；provider 仍使用宿主凭据 |
| 4 | 原子创建、持久归属/目录身份、共享工作区操作互斥，删除默认保留 | [core][core] 既有文件/目录/符号链接、并发创建失败、目录替换、双删除与重建屏障测试；[浏览器][browser] 删除 opt-in |
| 5 | 离线只持久入队，不调用全局 resume；危险离线生命周期命令拒绝 | [scheduling][scheduling] 中断的真实 Bash 任务跨两次离线发送不启动、不重复副作用；[CLI][cli] 实际子进程入队 |
| 6 | 系统通知使用 system 信封与 feed 身份 | [messaging][messaging] 实际提醒、失败投递进入模型和 feed；[scheduling][scheduling] 恢复审计 |
| 7 | 明确显式回信，提供 `reply_to`，同步提示词及产品文档 | [messaging][messaging] 普通回答只留本地，收件方得到正确 `reply_to`，显式发送走 durable 路由 |
| 8 | 持久链 ID/hop、每 agent 发送预算、超限通知 main 并终止本轮 | [messaging][messaging] faux ping-pong 自行停止；重开、重放、混合后续消息不绕过预算 |
| 9 | 504 续等、默认不限时、显式超时与 `wait` | [CLI][cli] 真实 CLI 进程经过两次 504 仍只提交一次；另有实际 115 秒 Bash 验收，见下文 |
| 10 | 按稳定 ID 更新 DOM、保留滚动锚点、底部跟随、401 内嵌登录并暂停轮询 | [浏览器][browser] 三轮轮询、feed 窗口移动、节点身份、登录失效和延迟快照下创建均实测 |
| 11 | 无 provider 时警告、create 错误和 FAQ 一致，并给出配置与重启步骤 | [core][core] 无默认模型时拒绝及显式已知模型的离线创建；[CLI][cli] 无密钥离线命令 |
| 12 | 按 provider 推荐默认模型，不依赖目录第一项；创建输出实际模型 | [core][core] 七种 provider 默认均在已安装目录中有效 |
| 13 | 创建/更新校验完整 `provider/modelId` 和已安装目录 | [HTTP][http] 裸名、未知 provider/model 均 400 且无记录；[core][core] 库入口同样校验 |
| 14 | abort/terminal/cooldown/start/resolve 一致，命令返回实际生命周期 | [scheduling][scheduling] 实际 abort、重试耗尽、缺模型与恢复；[HTTP][http] 生命周期返回值 |
| 15 | 以最终 submission 结果结算，保留已恢复错误的遥测 | [scheduling][scheduling] 429 后成功只产生一个 `turn_completed`，不沿用瞬时失败 |
| 16 | unreliable 立即可见；resolve 恢复投递和入队，修复丢失唤醒 | [scheduling][scheduling] 实际填满 outbox，检查 terminal、拒绝入队、resolve 后恢复 |
| 17 | 恢复记录成为持久审计事件，在恢复执行前写入并按 pending 集合去重 | [scheduling][scheduling] 多次重开不重复记录、不增加模型 submission |
| 18 | 删除 agent 同时删除其提醒；目标不存在视为永久失败 | [core][core] 其它 agent 的定时器保留；[messaging][messaging] 不存在目标的提醒停止 |
| 19 | 每次启动只对账一次，后续监听结算；feed 从尾部有界读取、ID 稳定 | [scheduling][scheduling] 2000 条历史读取计数、旧 ID 晚结算、稳定顺序；原 4095/4096/4097 迁移测试保留 |
| 20 | 先持久消息，在空闲边界后台摘要；steer/stop 不等待摘要 | [scheduling][scheduling] 阻塞实际摘要调用，确认消息已落盘且 steer/stop 可完成 |
| 21 | stopped 入队返回明确冲突 | [HTTP][http] 409；[messaging][messaging] stopped 提醒保留到 start 后处理 |
| 22 | 空 body 允许，非空非法 JSON/字段先拒绝 | [HTTP][http] 对每个生命周期 mutation 检查 400 与状态不变 |
| 23 | Unicode 信封、保留 main 大小写、拒绝名字/ID 冲突 | [messaging][messaging] 中文、空格、标点往返及实际 feed；[core][core] 名称边界与并发改名 |
| 24 | 实现 `-m` 文件、名称解析、失败摘要脱敏；补齐缺失参数校验 | [CLI][cli] UTF-8 多行原文、离线 deliveries、真实错误输出、缺参数零 HTTP 请求 |
| 25 | 严格相对时间/带时区 ISO，拒绝裸数字、过去及非法日期，显示解释时区 | [messaging][messaging] 时间语法边界与实际提醒，CLI 列表输出时区 |
| 26 | wrapper 配置白名单、拒绝 CR/LF/NUL、0600 原子写、常数时间比较；answer 给足 310 秒代理预算 | [wrapper][wrapper] 配置注入、权限、旧配置合并、无密钥日志、真实重启；尾斜杠/重复 timeout 参数、ReadTimeout 不破坏健康状态 |
| 27 | Fly 禁用自动停机，至少一台常驻 | `fly.toml` 配置核对；没有执行真实 Fly 部署 |
| 28 | PATCH 与 CLI update；按 agent 查询 usage；配置与登记表同事务 | [core][core] 更新回滚、并发更新、按会话用量；[HTTP][http] null 清空后重开持久性；[CLI][cli] 路由参数 |

交叉审查还发现并补上了：迟到的第二次删除误删新工作区、不同模型轮次复用
tool-call ID 丢消息、CLI 缺少 agent 参数误命中名为 `undefined` 的 agent、
wrapper 子进程日志泄露内部 key、创建成功被旧 UI 快照清掉选中项。
对应回归包含可控的并发屏障、跨轮同 ID 和延迟响应，不只重复正常流程。

## 本轮实际运行

Linux，Node **24.19.0 / 26.11.1**，pnpm **10.20.0**，Python 3.12，Chromium。

| 检查 | 结果与边界 |
|---|---|
| typecheck 与无密钥套件 | Node 24、26 各 **83 个 Node + 17 个 Python 测试通过**，零跳过 |
| 原完整 E2E | Node 24、26 各 **144/144**，零跳过；provider 替换成受控本地 SSE，产品 daemon/工具/持久层仍实际运行；**不是真 GLM** |
| Chromium 控制台 | **10/10**；包含真实 native 服务创建与重启；另外验证真实 wrapper 登录、创建、stop/start 和 CLI 自动发现 |
| 真实长任务 | Bash 实际 `sleep 115`；旧 CLI 约 110.60 秒遇到 504 退出 1，新 CLI 约 115.59 秒得到结果退出 0；`wait` 可接续旧 submission；每个任务只提交及执行一次 |
| Docker | 实际构建并通过 **29/29**：鉴权、模型协议、Bash 写文件、路由、提醒、CLI、子进程恢复、容器重启和 SIGTERM；镜像内全部 `src/*.ts`、agent package、wrapper 和 Python 配置共 **29/29 文件哈希一致** |

Docker 构建在本环境通过临时 Dockerfile 给下载步骤挂载代理 CA，保持 TLS 校验，
应用 COPY、依赖约束和启动命令不变；没有把环境证书写入产品 Dockerfile。
最终 wrapper 超时边界补丁已单独回归并进入上述最终镜像。
Node 24 E2E 运行期间只调整了一处登录说明文案，Node 26 使用更新文案完成整轮。

旧基线反证也实际运行：核心 14 组中的 12 组失败，HTTP 原问题 9 组中的 8 组失败，
调度 5/5、消息 4/4 复现失败；旧 UI 轮询替换节点/强制滚动、旧 CLI 长任务超时均有实际复现。
这些数据说明对应测试能识别旧缺陷，不等同于全部边界都已覆盖。

## 重跑

在仓库根运行（Python ≥ 3.11）：

```bash
npm install --global pnpm@10.20.0
pnpm install --frozen-lockfile
python3 -m pip install ./deploy
pnpm typecheck
pnpm test:reliability

python3 -m pip install playwright
python3 -m playwright install --with-deps chromium
python3 packages/agent/test-browser/console.py
```

GitHub Actions 对每个 PR 运行 Node 24/26 矩阵与独立 Chromium job。
可选的慢速验收也已入库：

```bash
node packages/agent/test-manual/long-cli.mjs
node packages/agent/test-manual/run-scripted-e2e.mjs
```

前者实际等待 115 秒；旧 CLI 对照用法见 [长任务说明](../packages/agent/test-manual/README.md)。
后者使用本地模型协议 fixture，详见 [受控 E2E 说明](../packages/agent/test-manual/SCRIPTED_E2E.md)，
运行后保留独立报告并恢复仓库原有 `e2e/report.md`。
需真实 provider 的验收可配置 README 中的模型凭据后运行 `pnpm e2e`；
本轮没有配置真实 provider，不能据此确认真实模型的回复质量、限流、计费或外部网络稳定性。

## 留待后续的 P3 项与限制

- 尚未实现 Markdown 渲染和控制台中文界面。
- transcript/交付账本轮转及 `/events` 有界读取仍待处理；本轮有界读取的是聊天 feed。
- Docker 已改为安装 `deploy/pyproject.toml` 的约束，但尚未生成精确 Python 锁文件；
  镜像仍以 root 运行，旧 volume 的非 root 权限迁移不在本轮中。
- 拆出了鉴权、CLI 参数/等待、模型策略、工具环境、入队与恢复模块，daemon 的进一步拆分仍待处理。
- 工具环境过滤不等于沙箱：没有新增文件系统或网络隔离。工作区互斥针对宿主内 API 操作，
  不隔离其它进程直接修改目录。Fly 常驻配置未经过真实部署验证。

因此本 PR 关联 issue #5，但不自动关闭整条 issue。

[runtime]: ../packages/agent/test/runtime.test.mjs
[http]: ../packages/agent/test/http.test.mjs
[core]: ../packages/agent/test/core.test.mjs
[cli]: ../packages/agent/test/cli.test.mjs
[scheduling]: ../packages/agent/test/scheduling.test.mjs
[messaging]: ../packages/agent/test/messaging.test.mjs
[browser]: ../packages/agent/test-browser/console.py
[wrapper]: ../deploy/tests/test_wrapper.py
