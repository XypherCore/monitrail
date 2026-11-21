import { deleteAccountHandler } from "../../../account/runtime.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = deleteAccountHandler;
export { DELETE as GET, DELETE as HEAD, DELETE as OPTIONS, DELETE as PATCH, DELETE as POST, DELETE as PUT };
