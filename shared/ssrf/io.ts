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

export async function discardBody(response: Response, signal: AbortSignal): Promise<void> {
  if (!response.body) return;
  // Reject transports without byte readers. A default reader can deliver an
  // arbitrarily large chunk regardless of the remaining budget.
  const reader = response.body.getReader({ mode: "byob" });
  let total = 0;
  try {
    while (total < 65536) {
      const chunk = await awaitSignal(
        reader.read(new Uint8Array(Math.min(8192, 65536 - total))),
        signal,
      );
      if (chunk.done) return;
      if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength === 0)
        throw new Error("Invalid response stream.");
      const length = chunk.value.byteLength;
      // Target bytes are counted and discarded, never parsed or returned.
      total += length;
    }
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
