import { telegramWebhookHandler } from "../../../../alerts/runtime.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = telegramWebhookHandler;
