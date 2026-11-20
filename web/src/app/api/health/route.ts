import { getRuntimeDatabase } from "../../../db/runtime.ts";
import { createHealthHandler, readHealth } from "../../../services/health.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createHealthHandler(() => readHealth(getRuntimeDatabase()));
