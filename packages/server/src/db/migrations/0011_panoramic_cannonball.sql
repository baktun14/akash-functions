ALTER TABLE "deployments" ADD COLUMN "wait_for_capacity" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "max_wait_ms" integer;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "waiting_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "burst_started_at" timestamp with time zone;