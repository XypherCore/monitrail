import "server-only";
import { getRuntimeDatabase } from "../db/runtime.ts";
import { createCheckCapabilities } from "./checks.ts";
import { createInternalHandlers } from "./internal-http.ts";
import { createInternalNonceStore } from "./internal-nonces.ts";

export const internalCheckHandlers = createInternalHandlers({
  secret: () => process.env.INTERNAL_HMAC_SECRET,
  checks: () => createCheckCapabilities(getRuntimeDatabase()),
  consumeNonce: (nonce) => createInternalNonceStore(getRuntimeDatabase()).consume(nonce),
});
