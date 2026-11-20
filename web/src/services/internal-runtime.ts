import "server-only";
import { after } from "next/server";
import { createChannelCipher } from "../alerts/channel-crypto.ts";
import { createRuntimeAlertSender } from "../alerts/delivery-runtime.ts";
import { getRuntimeDatabase } from "../db/runtime.ts";
import { readAuthConfig } from "../auth/config.ts";
import { createWebGuard } from "../security/web-ssrf.ts";
import { invalidateStatusSlugs } from "../status-pages/public-runtime.ts";
import { createMaintenanceCapability } from "./maintenance.ts";
import { createOutboxCapability } from "./alert-outbox.ts";
import { createCheckCapabilities } from "./checks.ts";
import { createInternalHandlers } from "./internal-http.ts";
import { createInternalNonceStore } from "./internal-nonces.ts";

export const internalCheckHandlers = createInternalHandlers({
  secret: () => process.env.INTERNAL_HMAC_SECRET,
  checks: () => createCheckCapabilities(getRuntimeDatabase(), invalidateStatusSlugs),
  maintenance: () => createMaintenanceCapability(getRuntimeDatabase(), {
    validateMonitor: createWebGuard({
      appUrl: readAuthConfig(process.env, process.env.NODE_ENV === "production").baseURL,
      // The maintenance service applies its canonical blocklist before DNS work.
      isBlockedHost: async () => false,
    }).validateMonitor,
    invalidateStatus: invalidateStatusSlugs,
    log: (summary) => console.log("maintenance", summary),
  }),
  consumeNonce: (nonce) => createInternalNonceStore(getRuntimeDatabase()).consume(nonce),
  delivery: {
    afterResponse: after,
    run: () => {
      // Configuration failure must leave delivery attempts unclaimed.
      createChannelCipher();
      const database = getRuntimeDatabase();
      return createOutboxCapability(database, createRuntimeAlertSender(database)).deliverOutbox();
    },
  },
});
