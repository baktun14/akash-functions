ALTER TABLE "function_versions" ADD COLUMN "source_ciphertext" text NOT NULL;--> statement-breakpoint
ALTER TABLE "function_versions" ADD COLUMN "source_iv" text NOT NULL;--> statement-breakpoint
ALTER TABLE "function_versions" ADD COLUMN "source_auth_tag" text NOT NULL;--> statement-breakpoint
ALTER TABLE "function_versions" ADD COLUMN "source_key_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "function_versions" DROP COLUMN IF EXISTS "source";