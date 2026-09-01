CREATE TABLE `provider_task_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text NOT NULL,
	`provider` text DEFAULT 'dataforseo' NOT NULL,
	`operation` text DEFAULT 'business_reviews' NOT NULL,
	`request_version` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`provider_tag` text NOT NULL,
	`state` text DEFAULT 'intent_created' NOT NULL,
	`provider_task_id` text,
	`provider_endpoint` text,
	`provider_path` text,
	`provider_status_code` integer,
	`returned_cost_usd` text,
	`returned_cost_microusd` integer,
	`cost_evidence` text DEFAULT 'unknown' NOT NULL,
	`post_attempt_count` integer DEFAULT 0 NOT NULL,
	`replay_count` integer DEFAULT 0 NOT NULL,
	`reconciliation_count` integer DEFAULT 0 NOT NULL,
	`last_failure_code` text,
	`operator_hold_reason` text,
	`post_attempted_at` text,
	`post_attempt_deadline_at` text,
	`provider_confirmed_at` text,
	`last_reconciled_at` text,
	`completed_at` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "provider_task_runs_provider_check" CHECK("provider_task_runs"."provider" = 'dataforseo'),
	CONSTRAINT "provider_task_runs_operation_check" CHECK("provider_task_runs"."operation" = 'business_reviews'),
	CONSTRAINT "provider_task_runs_state_check" CHECK("provider_task_runs"."state" IN ('intent_created', 'post_in_flight', 'provider_confirmed', 'collection_pending', 'completed', 'ambiguous', 'failed_unbilled', 'failed_charged')),
	CONSTRAINT "provider_task_runs_cost_evidence_check" CHECK("provider_task_runs"."cost_evidence" IN ('exact', 'zero', 'unknown')),
	CONSTRAINT "provider_task_runs_post_attempt_count_check" CHECK("provider_task_runs"."post_attempt_count" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_task_runs_organization_run_idx` ON `provider_task_runs` (`organization_id`,`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `provider_task_runs_tag_idx` ON `provider_task_runs` (`provider_tag`);--> statement-breakpoint
CREATE UNIQUE INDEX `provider_task_runs_provider_task_idx` ON `provider_task_runs` (`provider`,`provider_task_id`);--> statement-breakpoint
CREATE INDEX `provider_task_runs_state_deadline_idx` ON `provider_task_runs` (`state`,`post_attempt_deadline_at`);--> statement-breakpoint
CREATE INDEX `provider_task_runs_org_project_created_idx` ON `provider_task_runs` (`organization_id`,`project_id`,`created_at`);