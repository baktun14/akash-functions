CREATE TABLE IF NOT EXISTS "key_links" (
	"api_key_hash" text PRIMARY KEY NOT NULL,
	"wallet_address" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "functions" ADD COLUMN "wallet_address" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "functions_wallet_address_idx" ON "functions" USING btree ("wallet_address");