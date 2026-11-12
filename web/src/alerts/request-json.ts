import { awaitSignal } from "../../../shared/ssrf/io.ts";

export class AlertRequestError extends Error {
	readonly status: number;

	constructor(status: number) {
		super("Invalid alert request.");
		this.status = status;
	}
}

const bodyLimit = 8192;
const uploadTimeoutMs = 10_000;

export async function readAlertJson(request: Request): Promise<unknown> {
	const type = request.headers.get("content-type") ?? "";
	const encoding = request.headers.get("content-encoding") ?? "identity";
	if (
		!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(
			type,
		) ||
		encoding.toLowerCase() !== "identity"
	)
		throw new AlertRequestError(415);
	const declared = request.headers.get("content-length");
	if (declared !== null) {
		if (!/^(?:0|[1-9]\d*)$/.test(declared)) throw new AlertRequestError(400);
		if (Number(declared) > bodyLimit) throw new AlertRequestError(413);
	}
	if (!request.body) throw new AlertRequestError(400);
	const reader = request.body.getReader();
	const timeout = AbortSignal.timeout(uploadTimeoutMs);
	const signal = AbortSignal.any([request.signal, timeout]);
	try {
		const bytes = new Uint8Array(bodyLimit);
		let used = 0;
		for (;;) {
			const chunk = await awaitSignal(reader.read(), signal);
			if (chunk.done) break;
			if (chunk.value.length > bodyLimit - used)
				throw new AlertRequestError(413);
			bytes.set(chunk.value, used);
			used += chunk.value.length;
		}
		if (declared !== null && Number(declared) !== used)
			throw new AlertRequestError(400);
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)),
		);
	} catch (error) {
		if (error instanceof AlertRequestError) throw error;
		throw new AlertRequestError(timeout.aborted ? 408 : 400);
	} finally {
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

export const alertPrivateHeaders = {
	"cache-control": "no-store, max-age=0",
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
};
