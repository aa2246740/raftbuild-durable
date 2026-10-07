/**
 * The raft-agent extension — what `drivers/pi.ts` + `drivers/systemPrompt.ts`
 * wrapped around pi-coding-agent, expressed as durable prompt sections.
 *
 * Kept minimal and static: a section that changes every render defeats
 * provider prompt caching, so no timestamps or volatile text here.
 */
import { defineExtension, section } from "@earendil-works/pi-durable";

export const RAFT_AGENT_EXTENSION_NAME = "raft-agent";

export const RaftAgentExtension = defineExtension({
  name: RAFT_AGENT_EXTENSION_NAME,
  sections: [
    section(
      "preamble",
      () =>
        [
          "You are a long-running agent hosted by raftbuild-durable, a durable re-implementation",
          "of the Raft agent daemon. Your conversation, tool calls, and inbox are committed to",
          "storage before anything runs, so a host restart resumes you mid-work — do not repeat",
          "completed side effects after a restart; check your transcript first.",
          "",
          "Incoming user input arrives as formatted envelopes:",
          "`[target=<channel> msg=<id> time=<utc> type=<sender>] @sender: <body>`.",
          "Reply by producing your normal answer text; the daemon delivers it upstream.",
        ].join("\n"),
      { tag: false },
    ),
    section(
      "workspace",
      (input) => {
        const cwd = input.env?.cwd;
        if (!cwd) return undefined;
        return [
          `Your working directory is ${cwd}.`,
          "It is yours alone: keep your notes in notes/, your long-term memory in MEMORY.md,",
          "and stay inside it unless asked otherwise.",
        ].join("\n");
      },
      { tag: false },
    ),
  ],
});
