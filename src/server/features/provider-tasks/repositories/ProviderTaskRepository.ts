import {
  and,
  eq,
  inArray,
  lte,
  sql,
  type InferInsertModel,
  type InferSelectModel,
} from "drizzle-orm";
import { db } from "@/db";
import { providerTaskRuns } from "@/db/schema";
import { AppError } from "@/server/lib/errors";

export type ProviderTaskRun = InferSelectModel<typeof providerTaskRuns>;

type ProviderTaskInsert = InferInsertModel<typeof providerTaskRuns>;

async function findByRun(organizationId: string, runId: string) {
  const [row] = await db
    .select()
    .from(providerTaskRuns)
    .where(
      and(
        eq(providerTaskRuns.organizationId, organizationId),
        eq(providerTaskRuns.runId, runId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function createOrGetIntent(
  data: Pick<
    ProviderTaskInsert,
    | "id"
    | "organizationId"
    | "projectId"
    | "runId"
    | "requestVersion"
    | "requestFingerprint"
    | "providerTag"
  >,
): Promise<{ row: ProviderTaskRun; created: boolean }> {
  const [created] = await db
    .insert(providerTaskRuns)
    .values(data)
    .onConflictDoNothing()
    .returning();
  if (created) return { row: created, created: true };

  const existing = await findByRun(data.organizationId, data.runId);
  if (!existing) {
    throw new AppError("CONFLICT", "PROVIDER_TAG_COLLISION");
  }
  return { row: existing, created: false };
}

async function recordReplay(organizationId: string, runId: string) {
  const [row] = await db
    .update(providerTaskRuns)
    .set({
      replayCount: sql`${providerTaskRuns.replayCount} + 1`,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(providerTaskRuns.organizationId, organizationId),
        eq(providerTaskRuns.runId, runId),
      ),
    )
    .returning();
  return row ?? null;
}

async function claimPost(input: {
  organizationId: string;
  runId: string;
  requestFingerprint: string;
  attemptedAt: string;
  deadlineAt: string;
}) {
  const [row] = await db
    .update(providerTaskRuns)
    .set({
      state: "post_in_flight",
      postAttemptCount: 1,
      postAttemptedAt: input.attemptedAt,
      postAttemptDeadlineAt: input.deadlineAt,
      updatedAt: input.attemptedAt,
    })
    .where(
      and(
        eq(providerTaskRuns.organizationId, input.organizationId),
        eq(providerTaskRuns.runId, input.runId),
        eq(providerTaskRuns.requestFingerprint, input.requestFingerprint),
        eq(providerTaskRuns.state, "intent_created"),
        eq(providerTaskRuns.postAttemptCount, 0),
      ),
    )
    .returning();
  return row ?? null;
}

async function markExpiredPostAmbiguous(input: {
  organizationId: string;
  runId: string;
  now: string;
}) {
  const [row] = await db
    .update(providerTaskRuns)
    .set({ state: "ambiguous", updatedAt: input.now })
    .where(
      and(
        eq(providerTaskRuns.organizationId, input.organizationId),
        eq(providerTaskRuns.runId, input.runId),
        eq(providerTaskRuns.state, "post_in_flight"),
        lte(providerTaskRuns.postAttemptDeadlineAt, input.now),
      ),
    )
    .returning();
  return row ?? null;
}

async function recordAmbiguous(input: {
  organizationId: string;
  runId: string;
  failureCode: string;
  now: string;
}) {
  const [row] = await db
    .update(providerTaskRuns)
    .set({
      state: "ambiguous",
      lastFailureCode: input.failureCode,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(providerTaskRuns.organizationId, input.organizationId),
        eq(providerTaskRuns.runId, input.runId),
        eq(providerTaskRuns.state, "post_in_flight"),
      ),
    )
    .returning();
  return row ?? null;
}

async function recordProviderConfirmed(input: {
  organizationId: string;
  runId: string;
  providerTaskId: string;
  providerEndpoint: "reviews" | "extended_reviews";
  providerPath: string;
  providerStatusCode: number | null;
  returnedCostUsd: string | null;
  returnedCostMicrousd: number | null;
  costEvidence: "exact" | "zero" | "unknown";
  operatorHoldReason?: string | null;
  now: string;
}) {
  const [row] = await db
    .update(providerTaskRuns)
    .set({
      state: "provider_confirmed",
      providerTaskId: input.providerTaskId,
      providerEndpoint: input.providerEndpoint,
      providerPath: input.providerPath,
      providerStatusCode: input.providerStatusCode,
      returnedCostUsd: input.returnedCostUsd,
      returnedCostMicrousd: input.returnedCostMicrousd,
      costEvidence: input.costEvidence,
      operatorHoldReason: input.operatorHoldReason ?? null,
      providerConfirmedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(providerTaskRuns.organizationId, input.organizationId),
        eq(providerTaskRuns.runId, input.runId),
        inArray(providerTaskRuns.state, ["post_in_flight", "ambiguous"]),
      ),
    )
    .returning();
  return row ?? null;
}

async function recordFailure(input: {
  organizationId: string;
  runId: string;
  state: "failed_unbilled" | "failed_charged";
  providerPath: string | null;
  returnedCostUsd: string | null;
  returnedCostMicrousd: number | null;
  costEvidence: "exact" | "zero" | "unknown";
  failureCode: string;
  operatorHoldReason?: string | null;
  now: string;
}) {
  const [row] = await db
    .update(providerTaskRuns)
    .set({
      state: input.state,
      providerPath: input.providerPath,
      returnedCostUsd: input.returnedCostUsd,
      returnedCostMicrousd: input.returnedCostMicrousd,
      costEvidence: input.costEvidence,
      lastFailureCode: input.failureCode,
      operatorHoldReason: input.operatorHoldReason ?? null,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(providerTaskRuns.organizationId, input.organizationId),
        eq(providerTaskRuns.runId, input.runId),
        eq(providerTaskRuns.state, "post_in_flight"),
      ),
    )
    .returning();
  return row ?? null;
}

async function recordCollectionState(input: {
  organizationId: string;
  runId: string;
  state: "collection_pending" | "completed";
  failureCode?: string | null;
  now: string;
}) {
  const [row] = await db
    .update(providerTaskRuns)
    .set({
      state: input.state,
      lastFailureCode: input.failureCode ?? null,
      completedAt: input.state === "completed" ? input.now : undefined,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(providerTaskRuns.organizationId, input.organizationId),
        eq(providerTaskRuns.runId, input.runId),
        inArray(providerTaskRuns.state, [
          "provider_confirmed",
          "collection_pending",
          "completed",
        ]),
      ),
    )
    .returning();
  return row ?? null;
}

async function recordReconciliationNoMatch(input: {
  organizationId: string;
  runId: string;
  now: string;
}) {
  const [row] = await db
    .update(providerTaskRuns)
    .set({
      reconciliationCount: sql`${providerTaskRuns.reconciliationCount} + 1`,
      lastReconciledAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(providerTaskRuns.organizationId, input.organizationId),
        eq(providerTaskRuns.runId, input.runId),
        eq(providerTaskRuns.state, "ambiguous"),
      ),
    )
    .returning();
  return row ?? null;
}

async function recordOperatorHold(input: {
  organizationId: string;
  runId: string;
  reason: string;
  now: string;
}) {
  const [row] = await db
    .update(providerTaskRuns)
    .set({
      operatorHoldReason: input.reason,
      lastReconciledAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(providerTaskRuns.organizationId, input.organizationId),
        eq(providerTaskRuns.runId, input.runId),
      ),
    )
    .returning();
  return row ?? null;
}

export const ProviderTaskRepository = {
  findByRun,
  createOrGetIntent,
  recordReplay,
  claimPost,
  markExpiredPostAmbiguous,
  recordAmbiguous,
  recordProviderConfirmed,
  recordFailure,
  recordCollectionState,
  recordReconciliationNoMatch,
  recordOperatorHold,
} as const;
