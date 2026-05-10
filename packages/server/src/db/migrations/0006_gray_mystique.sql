ALTER TABLE "deployments" ADD COLUMN "runner_version" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "runner_seen_at" timestamp with time zone;