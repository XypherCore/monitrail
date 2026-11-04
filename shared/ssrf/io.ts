export type Transport = (
  input: string,
  init: RequestInit & { credentials: "omit" },
) => Promise<Response>;

/** Await a dependency without letting an ignored AbortSignal defeat the caller's deadline. */
export function awaitSignal<T>(task: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new Error("Operation aborted."));
    if (signal.aborted) {
      Promise.resolve(task).catch(() => {});
      aborted();
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(task).then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

export function cancelBody(response: Response): void {
  // Cleanup must not extend the deadline or surface dependency exceptions.
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    /* A reader or transport may already have canceled the body. */
  }
}

async function readBody(
  response: Response,
  signal: AbortSignal,
  limit: number,
  collect: boolean,
): Promise<Uint8Array[]> {
  if (!response.body) return [];
  // Reject transports without byte readers. A default reader can deliver an
  // arbitrarily large chunk regardless of the remaining budget.
  const reader = response.body.getReader({ mode: "byob" });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const chunk = await awaitSignal(
        reader.read(new Uint8Array(Math.min(8192, limit - total))),
        signal,
      );
      if (chunk.done) return chunks;
      if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength === 0)
        throw new Error("Invalid response stream.");
      const length = chunk.value.byteLength;
      if (collect && total + length >= limit) throw new Error("Resolver response limit exceeded.");
      // Target bytes are counted and discarded, never parsed or returned.
      total += length;
      if (collect) chunks.push(chunk.value);
    }
    return chunks;
  } finally {
    try {
      void reader.cancel().catch(() => {});
    } catch {
      /* Cancellation is best effort; the request signal is also aborted. */
    }
    try {
      reader.releaseLock();
    } catch {
      /* A canceled reader may still be finishing a pending read. */
    }
  }
}

export async function discardBody(response: Response, signal: AbortSignal): Promise<void> {
  await readBody(response, signal, 65536, false);
}

/** Resolver JSON must finish below the bound; a truncated valid prefix is never accepted. */
export async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
  limit = 65536,
): Promise<unknown> {
  const chunks = await readBody(response, signal, limit, true);
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
}
