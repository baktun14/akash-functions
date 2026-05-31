CREATE TABLE IF NOT EXISTS "deployment_dseqs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"dseq" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deployment_dseqs" ADD CONSTRAINT "deployment_dseqs_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "deployment_dseqs_dseq_uq" ON "deployment_dseqs" USING btree ("dseq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deployment_dseqs_deployment_idx" ON "deployment_dseqs" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deployment_dseqs_closed_at_idx" ON "deployment_dseqs" USING btree ("closed_at");