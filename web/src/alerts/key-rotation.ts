import { sql } from "drizzle-orm";
import type { DataExecutor } from "../data/access.ts";
import type { createChannelCipher } from "./channel-crypto.ts";
import type { ChannelIdentity } from "./contracts.ts";

type Cipher = ReturnType<typeof createChannelCipher>;
type StoredChannel = ChannelIdentity & { configEnc: string };

export async function rotateChannelKeys(db: DataExecutor, cipher: Cipher): Promise<number> {
  try {
    if (!db.transaction) throw new Error();
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
      const { rows } = await tx.execute(sql`
        SELECT id,user_id AS "userId",type,config_enc AS "configEnc"
        FROM alert_channels ORDER BY id FOR UPDATE
      `);
      let rotated = 0;
      for (const { configEnc, ...channel } of rows as StoredChannel[]) {
        const destination = cipher.decrypt(configEnc, channel);
        if (configEnc.startsWith(`v1.${cipher.activeKeyId}.`)) continue;
        const replacement = cipher.encrypt(destination, channel);
        const { rows: changed } = await tx.execute(sql`
          UPDATE alert_channels SET config_enc=${replacement}
          WHERE id=${channel.id} AND user_id=${channel.userId} AND type=${channel.type} AND config_enc=${configEnc}
          RETURNING id
        `);
        if (changed.length !== 1) throw new Error();
        rotated += 1;
      }
      return rotated;
    });
  } catch {
    throw new Error("Channel key rotation failed.");
  }
}
