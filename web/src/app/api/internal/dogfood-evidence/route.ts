import { dogfoodEvidenceHandler } from "../../../../ops/dogfood-runtime.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = dogfoodEvidenceHandler;
export { POST as DELETE, POST as GET, POST as HEAD, POST as OPTIONS, POST as PATCH, POST as PUT };
