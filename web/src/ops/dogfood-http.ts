import { INTERNAL_DOGFOOD_EVIDENCE_PATH, isInternalSecret, isInternalUuid } from "../../../shared/checks/signing.ts";
import { createSignedInternalHandler, parseSignedInternalBody, type SignedInternalDependencies } from "../services/internal-http.ts";
import type { DogfoodEvidence } from "../services/dogfood-evidence.ts";

type Dependencies = SignedInternalDependencies & {
  monitorIds(): unknown;
  capture(monitorIds: string[]): Promise<DogfoodEvidence>;
};

export function readDogfoodExportSecret(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const secret = env.DOGFOOD_EXPORT_HMAC_SECRET;
  return isInternalSecret(secret) && secret !== env.INTERNAL_HMAC_SECRET ? secret : undefined;
}

/** Server-owned selection; the request cannot choose monitors or query windows. */
export function readDogfoodMonitorIds(value: unknown): string[] {
  if (typeof value !== "string") throw new Error("Dogfood evidence configuration is invalid.");
  const ids = value.split(",");
  if (ids.length !== 2 || ids.some(id => !isInternalUuid(id)) || new Set(ids).size !== 2) {
    throw new Error("Dogfood evidence configuration is invalid.");
  }
  return ids;
}

export function createDogfoodEvidenceHandler(dependencies: Dependencies) {
  return createSignedInternalHandler(dependencies, INTERNAL_DOGFOOD_EVIDENCE_PATH, async (body) => {
    parseSignedInternalBody(body, (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length) throw new Error();
    });
    return dependencies.capture(readDogfoodMonitorIds(dependencies.monitorIds()));
  });
}
