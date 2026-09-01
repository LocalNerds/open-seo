/* eslint-disable max-lines */
import type { DataforseoApiResponse } from "@/server/lib/dataforseo/envelope";
import { DataforseoChargedTaskError } from "@/server/lib/dataforseo/envelope";
import { AppError } from "@/server/lib/errors";
import {
  ProviderTaskRepository,
  type ProviderTaskRun,
} from "@/server/features/provider-tasks/repositories/ProviderTaskRepository";

const REQUEST_VERSION = "business-reviews-v1";
const PROVIDER_TAG_PREFIX = "ln-oseo-dfs-rv-v1-";
const POST_ATTEMPT_DEADLINE_MS = 90_000;
const TASKS_READY_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const RECEIPT_RETENTION_MONTHS = 13;

export type ReviewsProviderEndpoint = "reviews" | "extended_reviews";

export type BusinessReviewsPostInput = {
  keyword?: string;
  cid?: string;
  placeId?: string;
  locationCoordinate?: string;
  locationCode?: number;
  languageCode: string;
  depth: number;
  sortBy?: string;
  includeOtherSources: boolean;
};

type ReadyBusinessTask = {
  taskId: string;
  endpoint: ReviewsProviderEndpoint;
  collectionPath: string;
  datePosted: string | null;
};

export type ProviderTaskReceipt = {
  runId: string;
  requestVersion: string;
  requestFingerprint: string;
  state: ProviderTaskRun["state"];
  providerTag: string;
  providerTaskId: string | null;
  providerEndpoint: ReviewsProviderEndpoint | null;
  providerPath: string[];
  providerStatusCode: number | null;
  returnedCostUsd: number | null;
  returnedCostUsdText: string | null;
  returnedCostMicrousd: number | null;
  costEvidence: ProviderTaskRun["costEvidence"];
  paidTaskCreated: boolean | null;
  postAttemptCount: number;
  replayCount: number;
  reconciliationCount: number;
  gate4Eligible: boolean;
  lastFailureCode: string | null;
  operatorHoldReason: string | null;
  postAttemptedAt: string | null;
  providerConfirmedAt: string | null;
  completedAt: string | null;
};

type ProviderTaskDecision =
  | {
      kind: "collect";
      endpoint: ReviewsProviderEndpoint;
      taskId: string;
      receipt: ProviderTaskReceipt;
    }
  | {
      kind: "processing" | "failed" | "held";
      receipt: ProviderTaskReceipt;
    };

type Repository = typeof ProviderTaskRepository;

type ExecuteDependencies = {
  repository: Repository;
  now: () => Date;
};

const defaultDependencies: ExecuteDependencies = {
  repository: ProviderTaskRepository,
  now: () => new Date(),
};

type ExecuteBusinessReviewsProviderTaskInput = {
  organizationId: string;
  projectId: string;
  runId: string;
  endpoint: ReviewsProviderEndpoint;
  postInput: BusinessReviewsPostInput;
  postTask: (tag: string) => Promise<DataforseoApiResponse<string>>;
  findReadyTasks: (
    tag: string,
    endpoint: ReviewsProviderEndpoint,
  ) => Promise<ReadyBusinessTask[]>;
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function digest(input: string): Promise<Uint8Array> {
  const result = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return new Uint8Array(result);
}

async function sha256Hex(input: string): Promise<string> {
  return Array.from(await digest(input), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function resolveIdentifier(input: BusinessReviewsPostInput) {
  const supplied = [input.keyword, input.cid, input.placeId].filter(
    (value) => value != null,
  );
  if (supplied.length !== 1) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Provide exactly one business identifier",
    );
  }
  if (input.keyword != null) return { kind: "keyword", value: input.keyword };
  if (input.cid != null) return { kind: "cid", value: input.cid };
  if (input.placeId != null) return { kind: "placeId", value: input.placeId };
  throw new AppError("VALIDATION_ERROR", "Missing business identifier");
}

export function canonicalBusinessReviewsRequest(input: {
  organizationId: string;
  projectId: string;
  endpoint: ReviewsProviderEndpoint;
  postInput: BusinessReviewsPostInput;
}) {
  const identifier = resolveIdentifier(input.postInput);
  return {
    version: REQUEST_VERSION,
    provider: "dataforseo",
    operation: "get_business_reviews",
    organizationId: input.organizationId,
    projectId: input.projectId,
    endpoint: input.endpoint,
    identifier,
    location: {
      coordinate: input.postInput.locationCoordinate ?? null,
      code: input.postInput.locationCoordinate
        ? null
        : (input.postInput.locationCode ?? null),
    },
    languageCode: input.postInput.languageCode,
    depth: input.postInput.depth,
    sortBy:
      input.endpoint === "extended_reviews"
        ? null
        : (input.postInput.sortBy ?? "newest"),
    includeOtherSources: input.postInput.includeOtherSources,
    priority: 2,
  } as const;
}

export async function buildBusinessReviewsFingerprint(input: {
  organizationId: string;
  projectId: string;
  endpoint: ReviewsProviderEndpoint;
  postInput: BusinessReviewsPostInput;
}): Promise<string> {
  return sha256Hex(JSON.stringify(canonicalBusinessReviewsRequest(input)));
}

export async function buildBusinessReviewsProviderTag(
  organizationId: string,
  runId: string,
): Promise<string> {
  return `${PROVIDER_TAG_PREFIX}${bytesToBase64Url(
    await digest(`${organizationId}\0${runId}`),
  )}`;
}

function decimalTextFromNumber(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new AppError("INTERNAL_ERROR", "INVALID_PROVIDER_COST");
  }
  const raw = value.toString().toLowerCase();
  if (!raw.includes("e")) return raw;

  const [coefficient = "0", exponentText = "0"] = raw.split("e");
  const exponent = Number(exponentText);
  const negative = coefficient.startsWith("-");
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const digits = `${whole}${fraction}`;
  const decimalPosition = whole.length + exponent;
  const expanded =
    decimalPosition <= 0
      ? `0.${"0".repeat(-decimalPosition)}${digits}`
      : decimalPosition >= digits.length
        ? `${digits}${"0".repeat(decimalPosition - digits.length)}`
        : `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  return negative ? `-${expanded}` : expanded;
}

export function normalizeProviderCost(costUsd: number): {
  text: string;
  microusd: number | null;
  evidence: "exact" | "zero" | "unknown";
  operatorHoldReason: string | null;
} {
  const text = decimalTextFromNumber(costUsd);
  const [whole = "0", fraction = ""] = text.split(".");
  if (fraction.length > 6) {
    return {
      text,
      microusd: null,
      evidence: "unknown",
      operatorHoldReason: "unsupported_cost_precision",
    };
  }
  const microusd =
    Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0") || "0");
  if (!Number.isSafeInteger(microusd)) {
    return {
      text,
      microusd: null,
      evidence: "unknown",
      operatorHoldReason: "unsupported_cost_range",
    };
  }
  return {
    text,
    microusd,
    evidence: microusd === 0 ? "zero" : "exact",
    operatorHoldReason: null,
  };
}

function pathSegments(path: string | null): string[] {
  return path ? path.split("/").filter(Boolean) : [];
}

export function providerTaskReceipt(row: ProviderTaskRun): ProviderTaskReceipt {
  const returnedCostUsd =
    row.returnedCostUsd == null ? null : Number(row.returnedCostUsd);
  const paidTaskCreated =
    row.providerTaskId != null || row.state === "failed_charged"
      ? true
      : row.state === "failed_unbilled" || row.postAttemptCount === 0
        ? false
        : null;
  return {
    runId: row.runId,
    requestVersion: row.requestVersion,
    requestFingerprint: row.requestFingerprint,
    state: row.state,
    providerTag: row.providerTag,
    providerTaskId: row.providerTaskId,
    providerEndpoint: row.providerEndpoint,
    providerPath: pathSegments(row.providerPath),
    providerStatusCode: row.providerStatusCode,
    returnedCostUsd,
    returnedCostUsdText: row.returnedCostUsd,
    returnedCostMicrousd: row.returnedCostMicrousd,
    costEvidence: row.costEvidence,
    paidTaskCreated,
    postAttemptCount: row.postAttemptCount,
    replayCount: row.replayCount,
    reconciliationCount: row.reconciliationCount,
    gate4Eligible:
      row.providerTaskId != null &&
      (row.costEvidence === "exact" || row.costEvidence === "zero") &&
      row.operatorHoldReason == null,
    lastFailureCode: row.lastFailureCode,
    operatorHoldReason: row.operatorHoldReason,
    postAttemptedAt: row.postAttemptedAt,
    providerConfirmedAt: row.providerConfirmedAt,
    completedAt: row.completedAt,
  };
}

function decisionWithoutPost(row: ProviderTaskRun): ProviderTaskDecision {
  const receipt = providerTaskReceipt(row);
  if (
    row.providerTaskId &&
    row.providerEndpoint &&
    ["provider_confirmed", "collection_pending", "completed"].includes(
      row.state,
    )
  ) {
    return {
      kind: "collect",
      endpoint: row.providerEndpoint,
      taskId: row.providerTaskId,
      receipt,
    };
  }
  if (row.operatorHoldReason) return { kind: "held", receipt };
  if (row.state === "failed_charged" || row.state === "failed_unbilled") {
    return { kind: "failed", receipt };
  }
  return { kind: "processing", receipt };
}

function providerPostPath(endpoint: ReviewsProviderEndpoint): string {
  return `v3/business_data/google/${endpoint}/task_post`;
}

function isTasksReadyExpired(row: ProviderTaskRun, now: Date): boolean {
  if (!row.postAttemptedAt) return false;
  return (
    now.getTime() - Date.parse(row.postAttemptedAt) >= TASKS_READY_RETENTION_MS
  );
}

async function reconcileAmbiguous(
  row: ProviderTaskRun,
  input: ExecuteBusinessReviewsProviderTaskInput,
  dependencies: ExecuteDependencies,
): Promise<ProviderTaskDecision> {
  const now = dependencies.now();
  const nowIso = now.toISOString();
  if (row.operatorHoldReason) return decisionWithoutPost(row);
  if (isTasksReadyExpired(row, now)) {
    const held = await dependencies.repository.recordOperatorHold({
      organizationId: row.organizationId,
      runId: row.runId,
      reason: "tasks_ready_window_expired",
      now: nowIso,
    });
    return decisionWithoutPost(held ?? row);
  }

  const matches = await input.findReadyTasks(row.providerTag, input.endpoint);
  if (matches.length === 0) {
    const current =
      (await dependencies.repository.recordReconciliationNoMatch({
        organizationId: row.organizationId,
        runId: row.runId,
        now: nowIso,
      })) ?? row;
    return decisionWithoutPost(current);
  }
  if (matches.length > 1) {
    const held = await dependencies.repository.recordOperatorHold({
      organizationId: row.organizationId,
      runId: row.runId,
      reason: "multiple_provider_tag_matches",
      now: nowIso,
    });
    return decisionWithoutPost(held ?? row);
  }

  const match = matches[0];
  if (!match) return decisionWithoutPost(row);
  const confirmed = await dependencies.repository.recordProviderConfirmed({
    organizationId: row.organizationId,
    runId: row.runId,
    providerTaskId: match.taskId,
    providerEndpoint: match.endpoint,
    providerPath: providerPostPath(match.endpoint),
    providerStatusCode: null,
    returnedCostUsd: null,
    returnedCostMicrousd: null,
    costEvidence: "unknown",
    operatorHoldReason: "missing_exact_post_cost",
    now: nowIso,
  });
  return confirmed
    ? {
        kind: "collect",
        endpoint: match.endpoint,
        taskId: match.taskId,
        receipt: providerTaskReceipt(confirmed),
      }
    : decisionWithoutPost(row);
}

async function resolveExisting(
  row: ProviderTaskRun,
  input: ExecuteBusinessReviewsProviderTaskInput,
  dependencies: ExecuteDependencies,
): Promise<ProviderTaskDecision | null> {
  if (row.state === "intent_created") return null;
  if (row.state !== "post_in_flight") {
    return row.state === "ambiguous"
      ? reconcileAmbiguous(row, input, dependencies)
      : decisionWithoutPost(row);
  }

  const nowIso = dependencies.now().toISOString();
  if (row.postAttemptDeadlineAt && row.postAttemptDeadlineAt > nowIso) {
    return decisionWithoutPost(row);
  }
  const ambiguous =
    (await dependencies.repository.markExpiredPostAmbiguous({
      organizationId: row.organizationId,
      runId: row.runId,
      now: nowIso,
    })) ?? row;
  return ambiguous.state === "ambiguous"
    ? reconcileAmbiguous(ambiguous, input, dependencies)
    : decisionWithoutPost(ambiguous);
}

async function recordPostFailure(
  row: ProviderTaskRun,
  error: unknown,
  dependencies: ExecuteDependencies,
): Promise<ProviderTaskDecision> {
  const now = dependencies.now().toISOString();
  if (error instanceof DataforseoChargedTaskError) {
    const cost = normalizeProviderCost(error.billing.costUsd);
    const failed = await dependencies.repository.recordFailure({
      organizationId: row.organizationId,
      runId: row.runId,
      state: cost.microusd === 0 ? "failed_unbilled" : "failed_charged",
      providerPath: error.billing.path.join("/"),
      returnedCostUsd: cost.text,
      returnedCostMicrousd: cost.microusd,
      costEvidence: cost.evidence,
      failureCode: error.isInvalidField
        ? "provider_invalid_field"
        : "provider_charged_failure",
      operatorHoldReason: cost.operatorHoldReason,
      now,
    });
    return decisionWithoutPost(failed ?? row);
  }
  if (
    error instanceof AppError &&
    ["VALIDATION_ERROR", "INSUFFICIENT_CREDITS"].includes(error.code)
  ) {
    const failed = await dependencies.repository.recordFailure({
      organizationId: row.organizationId,
      runId: row.runId,
      state: "failed_unbilled",
      providerPath: null,
      returnedCostUsd: "0",
      returnedCostMicrousd: 0,
      costEvidence: "zero",
      failureCode:
        error.code === "INSUFFICIENT_CREDITS"
          ? "insufficient_credits_zero_cost"
          : "validation_error_zero_cost",
      now,
    });
    return decisionWithoutPost(failed ?? row);
  }

  const ambiguous = await dependencies.repository.recordAmbiguous({
    organizationId: row.organizationId,
    runId: row.runId,
    failureCode:
      error instanceof AppError ? error.code : "provider_post_unknown",
    now,
  });
  return decisionWithoutPost(ambiguous ?? row);
}

export async function executeBusinessReviewsProviderTask(
  input: ExecuteBusinessReviewsProviderTaskInput,
  dependencies: ExecuteDependencies = defaultDependencies,
): Promise<ProviderTaskDecision> {
  if (
    (input.endpoint === "extended_reviews") !==
    input.postInput.includeOtherSources
  ) {
    throw new AppError("VALIDATION_ERROR", "Provider endpoint mismatch");
  }
  const requestFingerprint = await buildBusinessReviewsFingerprint(input);
  const providerTag = await buildBusinessReviewsProviderTag(
    input.organizationId,
    input.runId,
  );
  const intent = await dependencies.repository.createOrGetIntent({
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    projectId: input.projectId,
    runId: input.runId,
    requestVersion: REQUEST_VERSION,
    requestFingerprint,
    providerTag,
  });
  if (
    intent.row.requestVersion !== REQUEST_VERSION ||
    intent.row.requestFingerprint !== requestFingerprint ||
    intent.row.projectId !== input.projectId ||
    intent.row.providerTag !== providerTag
  ) {
    throw new AppError("IDEMPOTENCY_CONFLICT");
  }

  let row = intent.row;
  if (!intent.created) {
    row =
      (await dependencies.repository.recordReplay(
        input.organizationId,
        input.runId,
      )) ?? row;
    const existing = await resolveExisting(row, input, dependencies);
    if (existing) return existing;
  }

  const attemptedAt = dependencies.now();
  const claimed = await dependencies.repository.claimPost({
    organizationId: input.organizationId,
    runId: input.runId,
    requestFingerprint,
    attemptedAt: attemptedAt.toISOString(),
    deadlineAt: new Date(
      attemptedAt.getTime() + POST_ATTEMPT_DEADLINE_MS,
    ).toISOString(),
  });
  if (!claimed) {
    const current = await dependencies.repository.findByRun(
      input.organizationId,
      input.runId,
    );
    if (!current) throw new AppError("INTERNAL_ERROR", "PROVIDER_TASK_MISSING");
    return (
      (await resolveExisting(current, input, dependencies)) ??
      decisionWithoutPost(current)
    );
  }

  let posted: DataforseoApiResponse<string>;
  try {
    posted = await input.postTask(claimed.providerTag);
  } catch (error) {
    return recordPostFailure(claimed, error, dependencies);
  }

  const cost = normalizeProviderCost(posted.billing.costUsd);
  try {
    const confirmed = await dependencies.repository.recordProviderConfirmed({
      organizationId: claimed.organizationId,
      runId: claimed.runId,
      providerTaskId: posted.data,
      providerEndpoint: input.endpoint,
      providerPath: posted.billing.path.join("/"),
      providerStatusCode: 20100,
      returnedCostUsd: cost.text,
      returnedCostMicrousd: cost.microusd,
      costEvidence: cost.evidence,
      operatorHoldReason: cost.operatorHoldReason,
      now: dependencies.now().toISOString(),
    });
    if (!confirmed)
      throw new AppError("INTERNAL_ERROR", "RECEIPT_WRITE_FAILED");
    return {
      kind: "collect",
      endpoint: input.endpoint,
      taskId: posted.data,
      receipt: providerTaskReceipt(confirmed),
    };
  } catch {
    const ambiguous = await dependencies.repository.recordAmbiguous({
      organizationId: claimed.organizationId,
      runId: claimed.runId,
      failureCode: "receipt_write_failed",
      now: dependencies.now().toISOString(),
    });
    return decisionWithoutPost(ambiguous ?? claimed);
  }
}

export async function recordBusinessReviewsCollection(
  input: RecordBusinessReviewsCollectionInput,
  dependencies: ExecuteDependencies = defaultDependencies,
): Promise<ProviderTaskReceipt> {
  const row = await dependencies.repository.recordCollectionState({
    ...input,
    now: dependencies.now().toISOString(),
  });
  if (!row) throw new AppError("INTERNAL_ERROR", "PROVIDER_TASK_MISSING");
  return providerTaskReceipt(row);
}

type RecordBusinessReviewsCollectionInput = {
  organizationId: string;
  runId: string;
  state: "collection_pending" | "completed";
  failureCode?: string | null;
};

export function isProviderTaskEligibleForCleanup(
  row: ProviderTaskRun,
  now: Date,
): boolean {
  if (row.operatorHoldReason) return false;
  if (!["completed", "failed_unbilled", "failed_charged"].includes(row.state)) {
    return false;
  }
  const terminalAt = row.completedAt ?? row.updatedAt;
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - RECEIPT_RETENTION_MONTHS);
  return Date.parse(terminalAt) <= cutoff.getTime();
}
