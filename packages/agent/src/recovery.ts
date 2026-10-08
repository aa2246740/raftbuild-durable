import { defineDocFamily } from "@earendil-works/pi-durable";

/** A recovery epoch is the durable set of unfinished submission identities.
 * Repeated restarts of that same work must not create another model turn. */
export const RecoveryEpochDoc = defineDocFamily<{ announced: boolean }, string>({
  kind: "raft.recoveryEpoch", version: 1, scope: "session", family: true,
  initial: () => ({ announced: false }),
});
