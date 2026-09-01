/* eslint-disable max-lines */
import { describe, expect, it, vi, type Mocked } from "vitest";
import type {
  ProviderTaskRepository,
  ProviderTaskRun,
} from "@/server/features/provider-tasks/repositories/ProviderTaskRepository";
import {
  buildBusinessReviewsFingerprint,
  buildBusinessReviewsProviderTag,
  canonicalBusinessReviewsRequest,
  executeBusinessReviewsProviderTask,
  isProviderTaskEligibleForCleanup,
  normalizeProviderCost,
  providerTaskReceipt,
  type BusinessReviewsPostInput,
} from "@/server/features/provider-tasks/services/ProviderTaskService";
import { DataforseoChargedTaskError } from "@/server/lib/dataforseo/envelope";
import { AppError } from "@/server/lib/errors";

vi.mock(
  "@/server/features/provider-tasks/repositories/ProviderTaskRepository",
  () => ({ ProviderTaskRepository: {} }),
);

const NOW = new Date("2026-08-31T18:00:00.000Z");
const RUN_ID = "11111111-1111-4111-8111-111111111111";

const postInput: BusinessReviewsPostInput = {
  cid: "123",
  locationCode: 2840,
  languageCode: "en",
  depth: 20,
  sortBy: "newest",
  includeOtherSources: false,
};

function row(overrides: Partial<ProviderTaskRun> = {}): ProviderTaskRun {
  return {
    id: "row-1",
    organizationId: "org-1",
    projectId: "project-1",
    runId: RUN_ID,
    provider: "dataforseo",
    operation: "business_reviews",
    requestVersion: "business-reviews-v1",
    requestFingerprint: "fingerprint",
    providerTag: "provider-tag",
    state: "intent_created",
    providerTaskId: null,
    providerEndpoint: null,
    providerPath: null,
    providerStatusCode: null,
    returnedCostUsd: null,
    returnedCostMicrousd: null,
    costEvidence: "unknown",
    postAttemptCount: 0,
    replayCount: 0,
    reconciliationCount: 0,
    lastFailureCode: null,
    operatorHoldReason: null,
    postAttemptedAt: null,
    postAttemptDeadlineAt: null,
    providerConfirmedAt: null,
    lastReconciledAt: null,
    completedAt: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

type RepositoryMock = Mocked<typeof ProviderTaskRepository>;

function repositoryMock(): RepositoryMock {
  return {
    findByRun: vi.fn(),
    createOrGetIntent: vi.fn(),
    recordReplay: vi.fn(),
    claimPost: vi.fn(),
    markExpiredPostAmbiguous: vi.fn(),
    recordAmbiguous: vi.fn(),
    recordProviderConfirmed: vi.fn(),
    recordFailure: vi.fn(),
    recordCollectionState: vi.fn(),
    recordReconciliationNoMatch: vi.fn(),
    recordOperatorHold: vi.fn(),
  };
}

function dependencies(repository = repositoryMock()) {
  return {
    repository,
    now: () => new Date(NOW),
  };
}

function executionInput(
  overrides: Partial<
    Parameters<typeof executeBusinessReviewsProviderTask>[0]
  > = {},
) {
  return {
    organizationId: "org-1",
    projectId: "project-1",
    runId: RUN_ID,
    endpoint: "reviews" as const,
    postInput,
    postTask: vi.fn().mockResolvedValue({
      data: "task-1",
      billing: {
        costUsd: 0.002,
        path: ["v3", "business_data", "google", "reviews", "task_post"],
      },
    }),
    findReadyTasks: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

async function preparedIntent() {
  const requestFingerprint = await buildBusinessReviewsFingerprint({
    organizationId: "org-1",
    projectId: "project-1",
    endpoint: "reviews",
    postInput,
  });
  const providerTag = await buildBusinessReviewsProviderTag("org-1", RUN_ID);
  return row({ requestFingerprint, providerTag });
}

describe("business reviews request identity", () => {
  it("builds a stable allowlisted fingerprint", async () => {
    const canonical = canonicalBusinessReviewsRequest({
      organizationId: "org-1",
      projectId: "project-1",
      endpoint: "reviews",
      postInput,
    });
    const first = await buildBusinessReviewsFingerprint({
      organizationId: "org-1",
      projectId: "project-1",
      endpoint: "reviews",
      postInput,
    });
    const second = await buildBusinessReviewsFingerprint({
      organizationId: "org-1",
      projectId: "project-1",
      endpoint: "reviews",
      postInput: { ...postInput },
    });

    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).toBe(first);
    expect(canonical).toEqual({
      version: "business-reviews-v1",
      provider: "dataforseo",
      operation: "get_business_reviews",
      organizationId: "org-1",
      projectId: "project-1",
      endpoint: "reviews",
      identifier: { kind: "cid", value: "123" },
      location: { coordinate: null, code: 2840 },
      languageCode: "en",
      depth: 20,
      sortBy: "newest",
      includeOtherSources: false,
      priority: 2,
    });
    expect(JSON.stringify(canonical)).not.toMatch(
      /authorization|cookie|password|secret|token/iu,
    );
  });

  it("ignores sort for extended reviews and keeps the endpoint distinct", async () => {
    const first = await buildBusinessReviewsFingerprint({
      organizationId: "org-1",
      projectId: "project-1",
      endpoint: "extended_reviews",
      postInput,
    });
    const second = await buildBusinessReviewsFingerprint({
      organizationId: "org-1",
      projectId: "project-1",
      endpoint: "extended_reviews",
      postInput: { ...postInput, sortBy: "lowest_rating" },
    });
    const regular = await buildBusinessReviewsFingerprint({
      organizationId: "org-1",
      projectId: "project-1",
      endpoint: "reviews",
      postInput,
    });

    expect(second).toBe(first);
    expect(regular).not.toBe(first);
  });

  it("builds a deterministic opaque full-digest provider tag", async () => {
    const tag = await buildBusinessReviewsProviderTag("org-1", RUN_ID);
    expect(tag).toMatch(/^ln-oseo-dfs-rv-v1-[A-Za-z0-9_-]{43}$/u);
    expect(tag).not.toContain("org-1");
    expect(tag).not.toContain(RUN_ID);
    expect(await buildBusinessReviewsProviderTag("org-1", RUN_ID)).toBe(tag);
  });

  it("rejects ambiguous identifiers and endpoint mismatches before storage", async () => {
    const repository = repositoryMock();
    const input = executionInput({
      postInput: { ...postInput, keyword: "Acme" },
    });
    await expect(
      executeBusinessReviewsProviderTask(input, dependencies(repository)),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await expect(
      executeBusinessReviewsProviderTask(
        executionInput({ endpoint: "extended_reviews" }),
        dependencies(repository),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(repository.createOrGetIntent).not.toHaveBeenCalled();
  });
});

describe("provider cost normalization", () => {
  it("preserves exact decimal text and micro-USD without rounding", () => {
    expect(normalizeProviderCost(0.00375)).toEqual({
      text: "0.00375",
      microusd: 3750,
      evidence: "exact",
      operatorHoldReason: null,
    });
    expect(normalizeProviderCost(0)).toEqual({
      text: "0",
      microusd: 0,
      evidence: "zero",
      operatorHoldReason: null,
    });
    expect(normalizeProviderCost(1e-7)).toMatchObject({
      text: "0.0000001",
      microusd: null,
      evidence: "unknown",
      operatorHoldReason: "unsupported_cost_precision",
    });
  });
});

describe("first post claim", () => {
  it("persists the atomic claim before creating the provider callback", async () => {
    const intent = await preparedIntent();
    const claimed = row({
      ...intent,
      state: "post_in_flight",
      postAttemptCount: 1,
      postAttemptedAt: NOW.toISOString(),
      postAttemptDeadlineAt: "2026-08-31T18:01:30.000Z",
    });
    const confirmed = row({
      ...claimed,
      state: "provider_confirmed",
      providerTaskId: "task-1",
      providerEndpoint: "reviews",
      providerPath: "v3/business_data/google/reviews/task_post",
      providerStatusCode: 20100,
      returnedCostUsd: "0.002",
      returnedCostMicrousd: 2000,
      costEvidence: "exact",
    });
    const repository = repositoryMock();
    const events: string[] = [];
    repository.createOrGetIntent.mockResolvedValue({
      row: intent,
      created: true,
    });
    repository.claimPost.mockImplementation(() => {
      events.push("claim");
      return Promise.resolve(claimed);
    });
    repository.recordProviderConfirmed.mockResolvedValue(confirmed);
    const postTask = vi.fn().mockImplementation(() => {
      events.push("post");
      return Promise.resolve({
        data: "task-1",
        billing: {
          costUsd: 0.002,
          path: ["v3", "business_data", "google", "reviews", "task_post"],
        },
      });
    });

    const result = await executeBusinessReviewsProviderTask(
      executionInput({ postTask }),
      dependencies(repository),
    );

    expect(events).toEqual(["claim", "post"]);
    expect(postTask).toHaveBeenCalledOnce();
    expect(postTask).toHaveBeenCalledWith(intent.providerTag);
    expect(result).toMatchObject({
      kind: "collect",
      taskId: "task-1",
      receipt: {
        state: "provider_confirmed",
        providerStatusCode: 20100,
        returnedCostUsdText: "0.002",
        returnedCostMicrousd: 2000,
        gate4Eligible: true,
      },
    });
  });

  it("returns an idempotency conflict before provider access", async () => {
    const intent = await preparedIntent();
    const repository = repositoryMock();
    repository.createOrGetIntent.mockResolvedValue({
      row: { ...intent, requestFingerprint: "different" },
      created: false,
    });
    const input = executionInput();

    await expect(
      executeBusinessReviewsProviderTask(input, dependencies(repository)),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(input.postTask).not.toHaveBeenCalled();
    expect(input.findReadyTasks).not.toHaveBeenCalled();
    expect(repository.claimPost).not.toHaveBeenCalled();
  });

  it("allows only one post across concurrent identical calls", async () => {
    const intent = await preparedIntent();
    const inFlight = row({
      ...intent,
      state: "post_in_flight",
      postAttemptCount: 1,
      postAttemptedAt: NOW.toISOString(),
      postAttemptDeadlineAt: "2026-08-31T18:01:30.000Z",
    });
    const confirmed = row({
      ...inFlight,
      state: "provider_confirmed",
      providerTaskId: "task-1",
      providerEndpoint: "reviews",
      returnedCostUsd: "0.002",
      returnedCostMicrousd: 2000,
      costEvidence: "exact",
    });
    const repository = repositoryMock();
    repository.createOrGetIntent
      .mockResolvedValueOnce({ row: intent, created: true })
      .mockResolvedValueOnce({ row: inFlight, created: false });
    repository.recordReplay.mockResolvedValue(inFlight);
    repository.claimPost.mockResolvedValueOnce(inFlight);
    repository.recordProviderConfirmed.mockResolvedValue(confirmed);
    const postTask = vi.fn().mockResolvedValue({
      data: "task-1",
      billing: { costUsd: 0.002, path: ["v3", "task_post"] },
    });
    const input = executionInput({ postTask });

    const [first, second] = await Promise.all([
      executeBusinessReviewsProviderTask(input, dependencies(repository)),
      executeBusinessReviewsProviderTask(input, dependencies(repository)),
    ]);

    expect(postTask).toHaveBeenCalledOnce();
    expect([first.kind, second.kind].toSorted()).toEqual([
      "collect",
      "processing",
    ]);
  });
});

describe("fail-closed post outcomes", () => {
  async function runPostError(error: unknown) {
    const intent = await preparedIntent();
    const inFlight = row({
      ...intent,
      state: "post_in_flight",
      postAttemptCount: 1,
      postAttemptedAt: NOW.toISOString(),
      postAttemptDeadlineAt: "2026-08-31T18:01:30.000Z",
    });
    const repository = repositoryMock();
    repository.createOrGetIntent.mockResolvedValue({
      row: intent,
      created: true,
    });
    repository.claimPost.mockResolvedValue(inFlight);
    const input = executionInput({
      postTask: vi.fn().mockRejectedValue(error),
    });
    return { repository, input, inFlight };
  }

  it.each([
    new AppError("UPSTREAM_UNAVAILABLE"),
    new AppError("DATAFORSEO_AUTH_FAILED"),
    new Error("transport reset"),
  ])("marks uncertain dispatch errors ambiguous", async (error) => {
    const { repository, input, inFlight } = await runPostError(error);
    repository.recordAmbiguous.mockResolvedValue(
      row({ ...inFlight, state: "ambiguous" }),
    );

    const result = await executeBusinessReviewsProviderTask(
      input,
      dependencies(repository),
    );

    expect(result).toMatchObject({
      kind: "processing",
      receipt: { state: "ambiguous", paidTaskCreated: null },
    });
    expect(input.postTask).toHaveBeenCalledOnce();
  });

  it("records an exact zero-cost failure as failed_unbilled", async () => {
    const error = new DataforseoChargedTaskError(
      "Invalid Field",
      { costUsd: 0, path: ["v3", "task_post"] },
      true,
    );
    const { repository, input, inFlight } = await runPostError(error);
    repository.recordFailure.mockResolvedValue(
      row({
        ...inFlight,
        state: "failed_unbilled",
        returnedCostUsd: "0",
        returnedCostMicrousd: 0,
        costEvidence: "zero",
      }),
    );

    const result = await executeBusinessReviewsProviderTask(
      input,
      dependencies(repository),
    );
    expect(result).toMatchObject({
      kind: "failed",
      receipt: {
        state: "failed_unbilled",
        costEvidence: "zero",
        paidTaskCreated: false,
      },
    });
  });

  it("records the pre-provider credit gate as failed and unbilled", async () => {
    const intent = await preparedIntent();
    const repository = repositoryMock();
    repository.createOrGetIntent.mockResolvedValue({
      row: intent,
      created: true,
    });
    repository.claimPost.mockResolvedValue(
      row({ ...intent, state: "post_in_flight", postAttemptCount: 1 }),
    );
    repository.recordFailure.mockResolvedValue(
      row({
        ...intent,
        state: "failed_unbilled",
        returnedCostUsd: "0",
        returnedCostMicrousd: 0,
        costEvidence: "zero",
      }),
    );
    const input = executionInput({
      postTask: vi.fn().mockRejectedValue(new AppError("INSUFFICIENT_CREDITS")),
    });

    const result = await executeBusinessReviewsProviderTask(
      input,
      dependencies(repository),
    );

    expect(result).toMatchObject({
      kind: "failed",
      receipt: {
        state: "failed_unbilled",
        returnedCostMicrousd: 0,
        costEvidence: "zero",
      },
    });
    expect(repository.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        failureCode: "insufficient_credits_zero_cost",
      }),
    );
  });

  it("records an exact charged failure without allowing replay", async () => {
    const error = new DataforseoChargedTaskError("charged", {
      costUsd: 0.00375,
      path: ["v3", "task_post"],
    });
    const { repository, input, inFlight } = await runPostError(error);
    repository.recordFailure.mockResolvedValue(
      row({
        ...inFlight,
        state: "failed_charged",
        returnedCostUsd: "0.00375",
        returnedCostMicrousd: 3750,
        costEvidence: "exact",
      }),
    );

    const result = await executeBusinessReviewsProviderTask(
      input,
      dependencies(repository),
    );
    expect(result).toMatchObject({
      kind: "failed",
      receipt: {
        state: "failed_charged",
        returnedCostUsdText: "0.00375",
        returnedCostMicrousd: 3750,
        paidTaskCreated: true,
      },
    });
  });

  it("turns a receipt-write failure into an ambiguous durable hold", async () => {
    const intent = await preparedIntent();
    const inFlight = row({
      ...intent,
      state: "post_in_flight",
      postAttemptCount: 1,
    });
    const repository = repositoryMock();
    repository.createOrGetIntent.mockResolvedValue({
      row: intent,
      created: true,
    });
    repository.claimPost.mockResolvedValue(inFlight);
    repository.recordProviderConfirmed.mockRejectedValue(
      new Error("write failed"),
    );
    repository.recordAmbiguous.mockResolvedValue(
      row({
        ...inFlight,
        state: "ambiguous",
        lastFailureCode: "receipt_write_failed",
      }),
    );
    const input = executionInput();

    const result = await executeBusinessReviewsProviderTask(
      input,
      dependencies(repository),
    );
    expect(result).toMatchObject({
      kind: "processing",
      receipt: {
        state: "ambiguous",
        lastFailureCode: "receipt_write_failed",
      },
    });
    expect(input.postTask).toHaveBeenCalledOnce();
  });
});

describe("replay and tasks-ready reconciliation", () => {
  async function ambiguousReplay(overrides: Partial<ProviderTaskRun> = {}) {
    const intent = await preparedIntent();
    const ambiguous = row({
      ...intent,
      state: "ambiguous",
      postAttemptCount: 1,
      postAttemptedAt: "2026-08-31T17:00:00.000Z",
      postAttemptDeadlineAt: "2026-08-31T17:01:30.000Z",
      ...overrides,
    });
    const repository = repositoryMock();
    repository.createOrGetIntent.mockResolvedValue({
      row: ambiguous,
      created: false,
    });
    repository.recordReplay.mockResolvedValue(ambiguous);
    return { repository, ambiguous };
  }

  it("moves an expired in-flight claim to ambiguous and never reposts", async () => {
    const intent = await preparedIntent();
    const inFlight = row({
      ...intent,
      state: "post_in_flight",
      postAttemptCount: 1,
      postAttemptedAt: "2026-08-31T17:00:00.000Z",
      postAttemptDeadlineAt: "2026-08-31T17:01:30.000Z",
    });
    const ambiguous = row({ ...inFlight, state: "ambiguous" });
    const repository = repositoryMock();
    repository.createOrGetIntent.mockResolvedValue({
      row: inFlight,
      created: false,
    });
    repository.recordReplay.mockResolvedValue(inFlight);
    repository.markExpiredPostAmbiguous.mockResolvedValue(ambiguous);
    repository.recordReconciliationNoMatch.mockResolvedValue(ambiguous);
    const input = executionInput();

    const result = await executeBusinessReviewsProviderTask(
      input,
      dependencies(repository),
    );

    expect(result).toMatchObject({
      kind: "processing",
      receipt: { state: "ambiguous" },
    });
    expect(input.findReadyTasks).toHaveBeenCalledOnce();
    expect(input.postTask).not.toHaveBeenCalled();
  });

  it("preserves the exact confirmed receipt on same-run replay", async () => {
    const identity = await preparedIntent();
    const confirmed = row({
      ...identity,
      state: "provider_confirmed",
      providerTaskId: "task-1",
      providerEndpoint: "reviews",
      providerPath: "v3/business_data/google/reviews/task_post",
      providerStatusCode: 20100,
      returnedCostUsd: "0.00375",
      returnedCostMicrousd: 3750,
      costEvidence: "exact",
      postAttemptCount: 1,
      replayCount: 1,
    });
    const repository = repositoryMock();
    repository.createOrGetIntent.mockResolvedValue({
      row: confirmed,
      created: false,
    });
    repository.recordReplay.mockResolvedValue(confirmed);
    const input = executionInput();

    const result = await executeBusinessReviewsProviderTask(
      input,
      dependencies(repository),
    );

    expect(result).toMatchObject({
      kind: "collect",
      taskId: "task-1",
      receipt: {
        runId: RUN_ID,
        requestFingerprint: identity.requestFingerprint,
        providerTaskId: "task-1",
        providerPath: ["v3", "business_data", "google", "reviews", "task_post"],
        providerStatusCode: 20100,
        returnedCostUsdText: "0.00375",
        returnedCostMicrousd: 3750,
        replayCount: 1,
      },
    });
    expect(input.postTask).not.toHaveBeenCalled();
    expect(input.findReadyTasks).not.toHaveBeenCalled();
  });

  it("allows free collection of a recovered task while Gate 4 stays held", async () => {
    const identity = await preparedIntent();
    const recovered = row({
      ...identity,
      state: "collection_pending",
      providerTaskId: "task-recovered",
      providerEndpoint: "reviews",
      costEvidence: "unknown",
      operatorHoldReason: "missing_exact_post_cost",
      postAttemptCount: 1,
    });
    const repository = repositoryMock();
    repository.createOrGetIntent.mockResolvedValue({
      row: recovered,
      created: false,
    });
    repository.recordReplay.mockResolvedValue(recovered);
    const input = executionInput();

    const result = await executeBusinessReviewsProviderTask(
      input,
      dependencies(repository),
    );

    expect(result).toMatchObject({
      kind: "collect",
      taskId: "task-recovered",
      receipt: {
        gate4Eligible: false,
        operatorHoldReason: "missing_exact_post_cost",
      },
    });
    expect(input.postTask).not.toHaveBeenCalled();
  });

  it("keeps zero exact-tag matches ambiguous without reposting", async () => {
    const { repository, ambiguous } = await ambiguousReplay();
    repository.recordReconciliationNoMatch.mockResolvedValue(
      row({ ...ambiguous, reconciliationCount: 1 }),
    );
    const input = executionInput();

    const result = await executeBusinessReviewsProviderTask(
      input,
      dependencies(repository),
    );
    expect(result).toMatchObject({
      kind: "processing",
      receipt: { state: "ambiguous", reconciliationCount: 1 },
    });
    expect(input.findReadyTasks).toHaveBeenCalledWith(
      ambiguous.providerTag,
      "reviews",
    );
    expect(input.postTask).not.toHaveBeenCalled();
  });

  it("recovers one exact-tag task but never invents its post cost", async () => {
    const { repository, ambiguous } = await ambiguousReplay();
    const recovered = row({
      ...ambiguous,
      state: "provider_confirmed",
      providerTaskId: "recovered-task",
      providerEndpoint: "reviews",
      providerPath: "v3/business_data/google/reviews/task_post",
      costEvidence: "unknown",
      operatorHoldReason: "missing_exact_post_cost",
    });
    repository.recordProviderConfirmed.mockResolvedValue(recovered);
    const input = executionInput({
      findReadyTasks: vi.fn().mockResolvedValue([
        {
          taskId: "recovered-task",
          endpoint: "reviews",
          collectionPath:
            "/v3/business_data/google/reviews/task_get/recovered-task",
          datePosted: "2026-08-31 17:00:00 +00:00",
        },
      ]),
    });

    const result = await executeBusinessReviewsProviderTask(
      input,
      dependencies(repository),
    );
    expect(result).toMatchObject({
      kind: "collect",
      taskId: "recovered-task",
      receipt: {
        returnedCostUsd: null,
        costEvidence: "unknown",
        operatorHoldReason: "missing_exact_post_cost",
        gate4Eligible: false,
      },
    });
    expect(input.postTask).not.toHaveBeenCalled();
  });

  it("holds multiple exact-tag matches and never chooses one", async () => {
    const { repository, ambiguous } = await ambiguousReplay();
    repository.recordOperatorHold.mockResolvedValue(
      row({
        ...ambiguous,
        operatorHoldReason: "multiple_provider_tag_matches",
      }),
    );
    const input = executionInput({
      findReadyTasks: vi.fn().mockResolvedValue([
        {
          taskId: "task-1",
          endpoint: "reviews",
          collectionPath: "/task-1",
          datePosted: null,
        },
        {
          taskId: "task-2",
          endpoint: "reviews",
          collectionPath: "/task-2",
          datePosted: null,
        },
      ]),
    });

    const result = await executeBusinessReviewsProviderTask(
      input,
      dependencies(repository),
    );
    expect(result).toMatchObject({
      kind: "held",
      receipt: { operatorHoldReason: "multiple_provider_tag_matches" },
    });
    expect(repository.recordProviderConfirmed).not.toHaveBeenCalled();
    expect(input.postTask).not.toHaveBeenCalled();
  });

  it("sets a permanent hold after the three-day recovery boundary", async () => {
    const { repository, ambiguous } = await ambiguousReplay({
      postAttemptedAt: "2026-08-27T17:00:00.000Z",
    });
    repository.recordOperatorHold.mockResolvedValue(
      row({
        ...ambiguous,
        operatorHoldReason: "tasks_ready_window_expired",
      }),
    );
    const input = executionInput();

    const result = await executeBusinessReviewsProviderTask(
      input,
      dependencies(repository),
    );
    expect(result).toMatchObject({
      kind: "held",
      receipt: { operatorHoldReason: "tasks_ready_window_expired" },
    });
    expect(input.findReadyTasks).not.toHaveBeenCalled();
    expect(input.postTask).not.toHaveBeenCalled();
  });

  it.each([
    row({
      state: "post_in_flight",
      postAttemptCount: 1,
      postAttemptDeadlineAt: "2026-08-31T18:01:30.000Z",
    }),
    row({
      state: "provider_confirmed",
      postAttemptCount: 1,
      providerTaskId: "task-1",
      providerEndpoint: "reviews",
    }),
    row({
      state: "collection_pending",
      postAttemptCount: 1,
      providerTaskId: "task-1",
      providerEndpoint: "reviews",
    }),
    row({
      state: "completed",
      postAttemptCount: 1,
      providerTaskId: "task-1",
      providerEndpoint: "reviews",
    }),
    row({ state: "failed_unbilled", postAttemptCount: 1 }),
    row({ state: "failed_charged", postAttemptCount: 1 }),
  ])("never posts from replay state $state", async (existing) => {
    const identity = await preparedIntent();
    const current = {
      ...existing,
      requestFingerprint: identity.requestFingerprint,
      providerTag: identity.providerTag,
    };
    const repository = repositoryMock();
    repository.createOrGetIntent.mockResolvedValue({
      row: current,
      created: false,
    });
    repository.recordReplay.mockResolvedValue(current);
    const input = executionInput();

    await executeBusinessReviewsProviderTask(input, dependencies(repository));
    expect(input.postTask).not.toHaveBeenCalled();
  });
});

describe("receipt privacy and retention", () => {
  it("exposes only the sanitized receipt contract", () => {
    const receipt = providerTaskReceipt(
      row({
        state: "provider_confirmed",
        providerTaskId: "task-1",
        providerEndpoint: "reviews",
        providerPath: "v3/business_data/google/reviews/task_post",
        returnedCostUsd: "0.002",
        returnedCostMicrousd: 2000,
        costEvidence: "exact",
      }),
    );
    expect(Object.keys(receipt).toSorted()).toEqual([
      "completedAt",
      "costEvidence",
      "gate4Eligible",
      "lastFailureCode",
      "operatorHoldReason",
      "paidTaskCreated",
      "postAttemptCount",
      "postAttemptedAt",
      "providerConfirmedAt",
      "providerEndpoint",
      "providerPath",
      "providerStatusCode",
      "providerTag",
      "providerTaskId",
      "reconciliationCount",
      "replayCount",
      "requestFingerprint",
      "requestVersion",
      "returnedCostMicrousd",
      "returnedCostUsd",
      "returnedCostUsdText",
      "runId",
      "state",
    ]);
    expect(JSON.stringify(receipt)).not.toMatch(
      /authorization|businessName|cookie|email|password|review_text|secret|token/iu,
    );
  });

  it("makes only old terminal rows cleanup-eligible", () => {
    const old = "2025-07-30T00:00:00.000Z";
    expect(
      isProviderTaskEligibleForCleanup(
        row({ state: "completed", completedAt: old, updatedAt: old }),
        NOW,
      ),
    ).toBe(true);
    expect(
      isProviderTaskEligibleForCleanup(
        row({ state: "ambiguous", updatedAt: old }),
        NOW,
      ),
    ).toBe(false);
    expect(
      isProviderTaskEligibleForCleanup(
        row({
          state: "failed_charged",
          updatedAt: old,
          operatorHoldReason: "missing_exact_post_cost",
        }),
        NOW,
      ),
    ).toBe(false);
    expect(
      isProviderTaskEligibleForCleanup(
        row({
          state: "completed",
          completedAt: "2026-08-01T00:00:00.000Z",
        }),
        NOW,
      ),
    ).toBe(false);
  });
});
