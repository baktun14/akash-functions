CREATE TABLE IF NOT EXISTS "function_variables" (
	"function_id" uuid NOT NULL,
	"key" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "function_variables_function_id_key_pk" PRIMARY KEY("function_id","key"),
	CONSTRAINT "function_variables_key_shape" CHECK ("function_variables"."key" ~ '^[A-Z][A-Z0-9_]{0,127}$'),
	CONSTRAINT "function_variables_key_not_reserved" CHECK ("function_variables"."key" NOT IN ('FUNCTION_ID','INITIAL_VERSION_ID','BACKEND_BASE_URL','RUNNER_TOKEN','POLL_INTERVAL_MS','PORT'))
);
--> statement-breakpoint
ALTER TABLE "functions" ADD COLUMN "variables_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "function_variables" ADD CONSTRAINT "function_variables_function_id_functions_id_fk" FOREIGN KEY ("function_id") REFERENCES "public"."functions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
