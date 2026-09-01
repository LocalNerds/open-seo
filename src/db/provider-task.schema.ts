import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { projects } from "./app.schema";
import { organization } from "./better-auth-schema";

export const providerTaskRuns = sqliteTable(
  "provider_task_runs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    provider: text("provider").notNull().default("dataforseo"),
    operation: text("operation").notNull().default("business_reviews"),
    requestVersion: text("request_version").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    providerTag: text("provider_tag").notNull(),
    state: text("state", {
      enum: [
        "intent_created",
        "post_in_flight",
        "provider_confirmed",
        "collection_pending",
        "completed",
        "ambiguous",
        "failed_unbilled",
        "failed_charged",
      ],
    })
      .notNull()
      .default("intent_created"),
    providerTaskId: text("provider_task_id"),
    providerEndpoint: text("provider_endpoint", {
      enum: ["reviews", "extended_reviews"],
    }),
    providerPath: text("provider_path"),
    providerStatusCode: integer("provider_status_code"),
    returnedCostUsd: text("returned_cost_usd"),
    returnedCostMicrousd: integer("returned_cost_microusd"),
    costEvidence: text("cost_evidence", {
      enum: ["exact", "zero", "unknown"],
    })
      .notNull()
      .default("unknown"),
    postAttemptCount: integer("post_attempt_count").notNull().default(0),
    replayCount: integer("replay_count").notNull().default(0),
    reconciliationCount: integer("reconciliation_count").notNull().default(0),
    lastFailureCode: text("last_failure_code"),
    operatorHoldReason: text("operator_hold_reason"),
    postAttemptedAt: text("post_attempted_at"),
    postAttemptDeadlineAt: text("post_attempt_deadline_at"),
    providerConfirmedAt: text("provider_confirmed_at"),
    lastReconciledAt: text("last_reconciled_at"),
    completedAt: text("completed_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("provider_task_runs_organization_run_idx").on(
      table.organizationId,
      table.runId,
    ),
    uniqueIndex("provider_task_runs_tag_idx").on(table.providerTag),
    uniqueIndex("provider_task_runs_provider_task_idx").on(
      table.provider,
      table.providerTaskId,
    ),
    index("provider_task_runs_state_deadline_idx").on(
      table.state,
      table.postAttemptDeadlineAt,
    ),
    index("provider_task_runs_org_project_created_idx").on(
      table.organizationId,
      table.projectId,
      table.createdAt,
    ),
    check(
      "provider_task_runs_provider_check",
      sql`${table.provider} = 'dataforseo'`,
    ),
    check(
      "provider_task_runs_operation_check",
      sql`${table.operation} = 'business_reviews'`,
    ),
    check(
      "provider_task_runs_state_check",
      sql`${table.state} IN ('intent_created', 'post_in_flight', 'provider_confirmed', 'collection_pending', 'completed', 'ambiguous', 'failed_unbilled', 'failed_charged')`,
    ),
    check(
      "provider_task_runs_cost_evidence_check",
      sql`${table.costEvidence} IN ('exact', 'zero', 'unknown')`,
    ),
    check(
      "provider_task_runs_post_attempt_count_check",
      sql`${table.postAttemptCount} IN (0, 1)`,
    ),
  ],
);
