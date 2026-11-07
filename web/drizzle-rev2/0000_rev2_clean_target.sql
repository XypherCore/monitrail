CREATE TYPE "public"."alert_kind" AS ENUM('down', 'up');--> statement-breakpoint
CREATE TYPE "public"."channel_type" AS ENUM('telegram', 'webhook', 'discord', 'slack');--> statement-breakpoint
CREATE TYPE "public"."check_error" AS ENUM('dns', 'timeout', 'tls', 'connect', 'bad_status', 'blocked', 'other');--> statement-breakpoint
CREATE TABLE "accounts" (
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "alert_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "channel_type" NOT NULL,
	"label" text NOT NULL,
	"config_enc" text NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_channels_id_owner_unique" UNIQUE("id","user_id")
);
--> statement-breakpoint
CREATE TABLE "alert_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "alert_kind" NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_until" timestamp with time zone,
	"last_error_category" "check_error",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "alert_outbox_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "alert_outbox_dedupe_valid" CHECK ("alert_outbox"."dedupe_key" = "alert_outbox"."incident_id"::text || ':' || "alert_outbox"."channel_id"::text || ':' || "alert_outbox"."kind"::text),
	CONSTRAINT "alert_outbox_status_valid" CHECK ("alert_outbox"."status" IN ('pending','sending','sent','failed')),
	CONSTRAINT "alert_outbox_attempts_nonnegative" CHECK ("alert_outbox"."attempts" >= 0),
	CONSTRAINT "alert_outbox_payload_object" CHECK (jsonb_typeof("alert_outbox"."payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "blocked_hosts" (
	"host" text PRIMARY KEY NOT NULL,
	"include_subdomains" boolean DEFAULT true NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocked_hosts_host_shape" CHECK ("blocked_hosts"."host" <> '' AND "blocked_hosts"."host" = lower("blocked_hosts"."host") AND right("blocked_hosts"."host",1) <> '.')
);
--> statement-breakpoint
CREATE TABLE "check_attempts" (
	"attempt_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monitor_id" uuid NOT NULL,
	"config_rev" integer NOT NULL,
	"expected_status" text NOT NULL,
	"state" text DEFAULT 'claimed' NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "check_attempts_revision_positive" CHECK ("check_attempts"."config_rev" > 0),
	CONSTRAINT "check_attempts_expected_status_valid" CHECK ("check_attempts"."expected_status" IN ('2xx','2xx_3xx')),
	CONSTRAINT "check_attempts_state_valid" CHECK ("check_attempts"."state" IN ('claimed','done','dropped','expired')),
	CONSTRAINT "check_attempts_terminal_consistent" CHECK (("check_attempts"."state" = 'claimed') = ("check_attempts"."terminal_at" IS NULL)),
	CONSTRAINT "check_attempts_time_order" CHECK ("check_attempts"."expires_at" > "check_attempts"."claimed_at" AND ("check_attempts"."terminal_at" IS NULL OR "check_attempts"."terminal_at" >= "check_attempts"."claimed_at"))
);
--> statement-breakpoint
CREATE TABLE "checks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"config_rev" integer NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"ok" boolean NOT NULL,
	"status_code" integer,
	"response_ms" integer,
	"error_type" "check_error",
	"redirect_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "checks_attempt_id_unique" UNIQUE("attempt_id"),
	CONSTRAINT "checks_revision_positive" CHECK ("checks"."config_rev" > 0),
	CONSTRAINT "checks_status_code_valid" CHECK ("checks"."status_code" BETWEEN 100 AND 599),
	CONSTRAINT "checks_latency_nonnegative" CHECK ("checks"."response_ms" >= 0),
	CONSTRAINT "checks_redirect_count_valid" CHECK ("checks"."redirect_count" BETWEEN 0 AND 2)
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monitor_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_confirmed_at" timestamp with time zone,
	"resolved_reason" text,
	"cause" "check_error" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incidents_id_owner_unique" UNIQUE("id","user_id"),
	CONSTRAINT "incidents_reason_valid" CHECK ("incidents"."resolved_reason" IN ('recovered','paused','config_changed','blocked')),
	CONSTRAINT "incidents_confirmation_order" CHECK ("incidents"."confirmed_at" >= "incidents"."started_at"),
	CONSTRAINT "incidents_resolution_consistent" CHECK (("incidents"."resolved_at" IS NULL) = ("incidents"."resolved_reason" IS NULL)),
	CONSTRAINT "incidents_resolution_order" CHECK ("incidents"."resolved_at" IS NULL OR "incidents"."resolved_at" >= "incidents"."started_at"),
	CONSTRAINT "incidents_recovery_confirmation" CHECK (("incidents"."resolved_confirmed_at" IS NULL OR ("incidents"."resolved_at" IS NOT NULL AND "incidents"."resolved_confirmed_at" >= "incidents"."resolved_at")) AND ("incidents"."resolved_reason" IS DISTINCT FROM 'recovered' OR "incidents"."resolved_confirmed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_by" uuid,
	"used_at" timestamp with time zone,
	CONSTRAINT "invites_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "invites_consumption_valid" CHECK ("invites"."used_by" IS NULL OR "invites"."used_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "monitor_alert_channels" (
	"monitor_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "monitor_alert_channels_monitor_id_channel_id_pk" PRIMARY KEY("monitor_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "monitor_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monitor_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitor_events_kind_valid" CHECK ("monitor_events"."kind" IN ('created','paused','resumed','config_changed','blocked'))
);
--> statement-breakpoint
CREATE TABLE "monitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"host" text NOT NULL,
	"interval_seconds" integer DEFAULT 300 NOT NULL,
	"expected_status" text DEFAULT '2xx' NOT NULL,
	"is_paused" boolean DEFAULT false NOT NULL,
	"pause_reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"config_rev" integer DEFAULT 1 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"successes" integer DEFAULT 0 NOT NULL,
	"streak_started_at" timestamp with time zone,
	"streak_first_error" "check_error",
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone,
	"lease_id" uuid,
	"lease_until" timestamp with time zone,
	"dns_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitors_id_owner_unique" UNIQUE("id","user_id"),
	CONSTRAINT "monitors_interval_valid" CHECK ("monitors"."interval_seconds" IN (300,600,900,1800,3600)),
	CONSTRAINT "monitors_expected_status_valid" CHECK ("monitors"."expected_status" IN ('2xx','2xx_3xx')),
	CONSTRAINT "monitors_status_valid" CHECK ("monitors"."status" IN ('pending','up','down')),
	CONSTRAINT "monitors_pause_reason_valid" CHECK ("monitors"."pause_reason" IN ('user','blocked_host')),
	CONSTRAINT "monitors_pause_consistent" CHECK ("monitors"."is_paused" = ("monitors"."pause_reason" IS NOT NULL)),
	CONSTRAINT "monitors_revision_positive" CHECK ("monitors"."config_rev" > 0),
	CONSTRAINT "monitors_counters_nonnegative" CHECK ("monitors"."failures" >= 0 AND "monitors"."successes" >= 0),
	CONSTRAINT "monitors_lease_consistent" CHECK (("monitors"."lease_id" IS NULL) = ("monitors"."lease_until" IS NULL)),
	CONSTRAINT "monitors_host_shape" CHECK ("monitors"."host" <> '' AND "monitors"."host" = lower("monitors"."host") AND right("monitors"."host",1) <> '.')
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "rate_limits_key_window_start_pk" PRIMARY KEY("key","window_start"),
	CONSTRAINT "rate_limits_count_nonnegative" CHECK ("rate_limits"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slug_tombstones" (
	"slug" text PRIMARY KEY NOT NULL,
	"released_at" timestamp with time zone NOT NULL,
	CONSTRAINT "slug_tombstones_slug_valid" CHECK ("slug_tombstones"."slug" ~ '^[a-z0-9-]{3,40}$')
);
--> statement-breakpoint
CREATE TABLE "status_page_monitors" (
	"status_page_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"show_url" boolean DEFAULT false NOT NULL,
	CONSTRAINT "status_page_monitors_status_page_id_monitor_id_pk" PRIMARY KEY("status_page_id","monitor_id")
);
--> statement-breakpoint
CREATE TABLE "status_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"is_published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_pages_id_owner_unique" UNIQUE("id","user_id"),
	CONSTRAINT "status_pages_slug_valid" CHECK ("status_pages"."slug" ~ '^[a-z0-9-]{3,40}$')
);
--> statement-breakpoint
CREATE TABLE "system_heartbeat" (
	"name" text PRIMARY KEY NOT NULL,
	"last_tick_at" timestamp with time zone NOT NULL,
	"last_claimed" integer DEFAULT 0 NOT NULL,
	"last_ingested" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "system_heartbeat_counts_nonnegative" CHECK ("system_heartbeat"."last_claimed" >= 0 AND "system_heartbeat"."last_ingested" >= 0)
);
--> statement-breakpoint
CREATE TABLE "telegram_link_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_channels" ADD CONSTRAINT "alert_channels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_outbox" ADD CONSTRAINT "alert_outbox_incident_owner_fk" FOREIGN KEY ("incident_id","user_id") REFERENCES "public"."incidents"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_outbox" ADD CONSTRAINT "alert_outbox_channel_owner_fk" FOREIGN KEY ("channel_id","user_id") REFERENCES "public"."alert_channels"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_attempts" ADD CONSTRAINT "check_attempts_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checks" ADD CONSTRAINT "checks_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_monitor_owner_fk" FOREIGN KEY ("monitor_id","user_id") REFERENCES "public"."monitors"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_used_by_users_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_alert_channels" ADD CONSTRAINT "monitor_channels_monitor_owner_fk" FOREIGN KEY ("monitor_id","user_id") REFERENCES "public"."monitors"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_alert_channels" ADD CONSTRAINT "monitor_channels_channel_owner_fk" FOREIGN KEY ("channel_id","user_id") REFERENCES "public"."alert_channels"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_events" ADD CONSTRAINT "monitor_events_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page_monitors" ADD CONSTRAINT "page_monitors_page_owner_fk" FOREIGN KEY ("status_page_id","user_id") REFERENCES "public"."status_pages"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page_monitors" ADD CONSTRAINT "page_monitors_monitor_owner_fk" FOREIGN KEY ("monitor_id","user_id") REFERENCES "public"."monitors"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_pages" ADD CONSTRAINT "status_pages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_link_codes" ADD CONSTRAINT "telegram_link_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "alert_channels_user_idx" ON "alert_channels" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "alert_outbox_channel_idx" ON "alert_outbox" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "check_attempts_monitor_idx" ON "check_attempts" USING btree ("monitor_id");--> statement-breakpoint
CREATE INDEX "checks_monitor_time_idx" ON "checks" USING btree ("monitor_id","checked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_one_open_per_monitor" ON "incidents" USING btree ("monitor_id") WHERE "incidents"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "incidents_monitor_time_idx" ON "incidents" USING btree ("monitor_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "monitor_channels_channel_idx" ON "monitor_alert_channels" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "monitor_events_monitor_time_idx" ON "monitor_events" USING btree ("monitor_id","at");--> statement-breakpoint
CREATE INDEX "monitors_user_idx" ON "monitors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "monitors_host_idx" ON "monitors" USING btree ("host");--> statement-breakpoint
CREATE INDEX "monitors_due_idx" ON "monitors" USING btree ("next_check_at") WHERE "monitors"."is_paused" = false;--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "page_monitors_monitor_idx" ON "status_page_monitors" USING btree ("monitor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "status_pages_slug_unique" ON "status_pages" USING btree (lower("slug"));--> statement-breakpoint
CREATE INDEX "status_pages_user_idx" ON "status_pages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "telegram_link_codes_user_idx" ON "telegram_link_codes" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree (lower("email")) WHERE "users"."email" IS NOT NULL;