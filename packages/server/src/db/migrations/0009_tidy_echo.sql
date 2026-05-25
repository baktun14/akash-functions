CREATE TABLE IF NOT EXISTS "function_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"project" text NOT NULL,
	"route" text NOT NULL,
	"route_kind" text NOT NULL,
	"function_id" uuid NOT NULL,
	"exposure" text DEFAULT 'vercel-rewrite' NOT NULL,
	"origin_token_hash" text NOT NULL,
	"origin_token_ciphertext" text NOT NULL,
	"origin_token_iv" text NOT NULL,
	"origin_token_auth_tag" text NOT NULL,
	"origin_token_key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "function_aliases_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "function_aliases" ADD CONSTRAINT "function_aliases_function_id_functions_id_fk" FOREIGN KEY ("function_id") REFERENCES "public"."functions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "function_aliases_wallet_address_idx" ON "function_aliases" USING btree ("wallet_address");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "function_aliases_function_id_idx" ON "function_aliases" USING btree ("function_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "function_aliases_wallet_project_route_idx" ON "function_aliases" USING btree ("wallet_address","project","route");
