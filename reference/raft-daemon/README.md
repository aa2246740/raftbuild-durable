# reference/raft-daemon — 只读参考

这是 [botiverse/raft-source](https://github.com/botiverse/raft-source) `packages/daemon` 的**原样拷贝**（快照 commit `26f77ef`，Release v1.21.2-source.1）。

- 用途：阅读参考 —— Raft 的 daemon 怎么把各家 agent CLI（claude / codex / pi…）包成受监管的长驻 agent 进程。
- 许可以 `LICENSE`（FSL-1.1-ALv2，© Botiverse）为准：可读、可改、可跑；不用于与其竞争的产品。
- **不参与构建**：它依赖 raft 的 workspace 内部包（`@botiverse/raft-shared` 等），单独跑不起来。真正的移植代码在 `packages/agent`。
- 重点看：
  - `src/drivers/` —— 每种 agent 运行时一个 driver（`pi.ts` 就是 pi-coding-agent 的接入点），这是 daemon 的"运行时抽象层"
  - `src/agentProcessManager*.ts` —— 进程拉起、回收、唤醒
  - `src/runtimeTurnState.ts` / `src/runtimeOutcomeOutbox.ts` —— 会话状态与结果投递
