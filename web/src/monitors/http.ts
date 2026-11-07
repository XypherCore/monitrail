import { awaitSignal } from "../../../shared/ssrf/io.ts";
import {
  isMonitorId,
  type MonitorEditFields,
  type MonitorField,
  type MonitorFields,
  parseMonitorFields,
  parseMonitorUpdate,
} from "./input.ts";

export type MonitorHttpAccess = {
  createMonitor(fields: MonitorFields): Promise<{ id: string }>;
  editMonitor(id: string, fields: MonitorEditFields): Promise<boolean>;
  setMonitorPaused(id: string, isPaused: boolean): Promise<boolean>;
  deleteMonitor(id: string): Promise<boolean>;
};

type MonitorApiError = {
  status: number;
  message: string;
  field?: MonitorField;
  retryAfterSeconds?: number;
};
type Dependencies = {
  origin(): string;
  authenticate(request: Request, origin: string): Promise<MonitorHttpAccess | null>;
  mapError(error: unknown): MonitorApiError | null;
};

const privateHeaders = {
  "cache-control": "no-store, max-age=0",
  pragma: "no-cache",
  vary: "Cookie",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const bodyLimit = 8192;
const uploadTimeoutMs = 10000;

function failure(status: number, message: string, field?: MonitorField) {
  return Response.json({ error: { message, field } }, { status, headers: privateHeaders });
}

function success(id: string, status = 200) {
  return Response.json({ id }, { status, headers: privateHeaders });
}

const missingMonitor = () => failure(404, "Monitor not found.");
const unavailable = () => failure(503, "Monitors are temporarily unavailable. Try again.");

class RequestBodyError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  const encoding = request.headers.get("content-encoding") ?? "identity";
  if (
    !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(contentType) ||
    encoding.toLowerCase() !== "identity"
  ) {
    throw new RequestBodyError(415, "Send the monitor settings as UTF-8 JSON.");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared))
      throw new RequestBodyError(400, "The request body length is invalid.");
    if (Number(declared) > bodyLimit)
      throw new RequestBodyError(413, "The monitor settings are too large.");
  }
  if (!request.body) throw new RequestBodyError(400, "Send the monitor settings as a JSON object.");

  const reader = request.body.getReader();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), uploadTimeoutMs);
  try {
    const bytes = new Uint8Array(bodyLimit);
    let used = 0;
    for (;;) {
      const chunk = await awaitSignal(reader.read(), controller.signal);
      if (chunk.done) break;
      if (chunk.value.byteLength > bodyLimit - used)
        throw new RequestBodyError(413, "The monitor settings are too large.");
      bytes.set(chunk.value, used);
      used += chunk.value.byteLength;
    }
    if (declared !== null && Number(declared) !== used)
      throw new RequestBodyError(400, "The request body length is invalid.");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)));
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    if (controller.signal.aborted)
      throw new RequestBodyError(408, "The upload timed out. Try again.");
    throw new RequestBodyError(400, "Send the monitor settings as a JSON object.");
  } finally {
    clearTimeout(timer);
    // A stalled stream's cancellation must not extend the request deadline.
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      /* A canceled read may still be settling. */
    }
  }
}

type Operation = (access: MonitorHttpAccess) => Response | Promise<Response>;

export function createMonitorHandlers(dependencies: Dependencies) {
  async function run(
    request: Request,
    method: "POST" | "PATCH" | "DELETE",
    perform: Operation,
  ): Promise<Response> {
    if (request.method !== method) {
      const response = failure(405, "Unsupported request method.");
      response.headers.set("allow", method);
      return response;
    }
    try {
      const origin = dependencies.origin();
      if (request.headers.get("origin") !== origin)
        return failure(403, "This request must come from the app.");
      const access = await dependencies.authenticate(request, origin);
      if (!access) return failure(401, "Sign in to manage monitors.");
      return await perform(access);
    } catch (error) {
      if (error instanceof RequestBodyError) return failure(error.status, error.message);
      try {
        const known = dependencies.mapError(error);
        if (!known) return unavailable();
        const response = failure(known.status, known.message, known.field);
        if (known.retryAfterSeconds !== undefined)
          response.headers.set("retry-after", String(known.retryAfterSeconds));
        return response;
      } catch {
        return unavailable();
      }
    }
  }

  return {
    create(request: Request) {
      return run(request, "POST", async (access) => {
        const fields = parseMonitorFields(await readJson(request), "create");
        const { id } = await access.createMonitor(fields);
        return success(id, 201);
      });
    },
    update(request: Request, id: string) {
      return run(request, "PATCH", async (access) => {
        if (!isMonitorId(id)) return missingMonitor();
        const change = parseMonitorUpdate(await readJson(request));
        const updated =
          change.kind === "edit"
            ? await access.editMonitor(id, change.fields)
            : await access.setMonitorPaused(id, change.isPaused);
        return updated ? success(id) : missingMonitor();
      });
    },
    delete(request: Request, id: string) {
      return run(request, "DELETE", async (access) =>
        isMonitorId(id) && (await access.deleteMonitor(id)) ? success(id) : missingMonitor(),
      );
    },
  };
}
