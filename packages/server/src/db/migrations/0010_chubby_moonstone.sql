ALTER TABLE "deployments" ADD COLUMN "gpu_vendor" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "gpu_model" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "gpu_attempt" integer DEFAULT 0 NOT NULL;