import "server-only";
import { getRuntimeDatabase } from "../db/runtime.ts";
import { createInternalNonceStore } from "../services/internal-nonces.ts";
import { createDogfoodEvidenceHandler, readDogfoodExportSecret } from "./dogfood-http.ts";
import { createRollingDogfoodEvidenceCapability } from "./dogfood-service.ts";

export const dogfoodEvidenceHandler = createDogfoodEvidenceHandler({
  secret: () => readDogfoodExportSecret(process.env),
  monitorIds: () => process.env.DOGFOOD_EXPORT_MONITOR_IDS,
  consumeNonce: (nonce) => createInternalNonceStore(getRuntimeDatabase()).consume(nonce),
  capture: (ids) => createRollingDogfoodEvidenceCapability(getRuntimeDatabase()).capture(ids),
});
