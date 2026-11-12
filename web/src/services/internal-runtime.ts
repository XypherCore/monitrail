import "server-only";
import { after } from "next/server";
import { createChannelCipher } from "../alerts/channel-crypto.ts";
import { createRuntimeAlertSender } from "../alerts/delivery-runtime.ts";
import { getRuntimeDatabase } from "../db/runtime.ts";
import { createOutboxCapability } from "./alert-outbox.ts";
import { createCheckCapabilities } from "./checks.ts";
import { createInternalHandlers } from "./internal-http.ts";
import { createInternalNonceStore } from "./internal-nonces.ts";

export const internalCheckHandlers = createInternalHandlers({
  secret: () => process.env.INTERNAL_HMAC_SECRET,
  checks: () => createCheckCapabilities(getRuntimeDatabase()),
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
