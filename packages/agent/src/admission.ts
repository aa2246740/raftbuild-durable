/** Offline admission using pi-durable's public transaction surface. Never
 * calls submit/wait/resume, all of which start its session-wide scheduler. */
import {
  ConversationBusy, GenerationTask, InboxDoc, LiveDoc, UserEntry,
  type ConversationId, type Harness, type SubmissionId,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

export async function enqueueInput(
  harness: Harness,
  conversationId: ConversationId,
  content: string,
  options: { requestId?: string; whenBusy?: "steer" | "followUp" | "reject" },
): Promise<SubmissionId> {
  return harness.commit(async (tx) => {
    if (options.requestId !== undefined) {
      const previous = await tx.submissionByRequest(conversationId, options.requestId);
      if (previous) {
        if (previous.type !== "input") throw new Error("requestId already identifies a non-input submission");
        return previous.id;
      }
    }
    const live = await tx.doc(LiveDoc, conversationId);
    const inbox = await tx.doc(InboxDoc, conversationId);
    if (live.run) {
      if (options.whenBusy === "reject") throw new ConversationBusy(conversationId);
      const submission = await tx.createSubmission({
        conversationId, type: "input", status: "queued",
        ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
      });
      inbox.items.push({ id: submission.id, mode: options.whenBusy === "steer" ? "steer" : "followUp", content });
      return submission.id;
    }
    // A normal closed/crashed generation keeps live.run until recovery. An
    // idle inbox without a run needs pi-durable's full boundary machinery;
    // refuse instead of reordering passive writes or silently waking peers.
    if (inbox.items.length > 0) throw new Error("pending conversation maintenance requires raftd serve before offline send");
    const entry = await tx.appendEntry(UserEntry, conversationId, {
      model: [{ role: "user", content, timestamp: Date.now() }],
    });
    const submission = await tx.createSubmission({
      conversationId, type: "input", status: "placed", entry: entry.id,
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
    });
    live.run = {
      taskId: await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" }, conversationId }),
      inputs: [submission.id],
    };
    return submission.id;
  }, BACKGROUND_CONTEXT);
}
