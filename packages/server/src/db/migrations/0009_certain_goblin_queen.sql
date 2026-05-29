CREATE TABLE IF NOT EXISTS "run_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"deployment_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"stream" text NOT NULL,
	"chunk" text NOT NULL,
	"shard_index" integer DEFAULT 0 NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_console_keys" (
	"wallet_address" text PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "function_variables" DROP CONSTRAINT "function_variables_key_not_reserved";--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "run_kind" text DEFAULT 'service' NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "run_outcome" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "exit_code" integer;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "max_duration_ms" integer;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "teardown_state" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "teardown_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "functions" ADD COLUMN "execution_kind" text DEFAULT 'service' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_logs" ADD CONSTRAINT "run_logs_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_logs_deployment_seq_idx" ON "run_logs" USING btree ("deployment_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "run_logs_deployment_shard_seq_uq" ON "run_logs" USING btree ("deployment_id","shard_index","seq");--> statement-breakpoint
ALTER TABLE "function_variables" ADD CONSTRAINT "function_variables_key_not_reserved" CHECK ("function_variables"."key" NOT IN ('FUNCTION_ID','INITIAL_VERSION_ID','BACKEND_BASE_URL','RUNNER_TOKEN','POLL_INTERVAL_MS','PORT','EXECUTION_KIND','DEPLOYMENT_ID'));