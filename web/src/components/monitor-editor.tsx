"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
	type FormEvent,
	useEffect,
	useRef,
	useState,
	useTransition,
} from "react";
import type { MonitorDto } from "../data/access";
import {
	isMonitorId,
	MONITOR_DEFAULT_EXPECTED_STATUS,
	MONITOR_DEFAULT_INTERVAL_SECONDS,
	MONITOR_EXPECTED_STATUSES,
	MONITOR_INTERVAL_SECONDS,
	type MonitorEditFields,
	type MonitorFields,
} from "../monitors/input";

type Action = "create" | "save" | "pause" | "resume" | "delete";
type Field = keyof MonitorFields;
type Failure = { action: Action; message: string; field?: Field };

const retryMessage = "The request could not be completed. Please try again.";

function readFailure(body: unknown, action: Action): Failure {
	if (!body || typeof body !== "object" || !("error" in body)) {
		return { action, message: retryMessage };
	}
	const { error } = body;
	if (!error || typeof error !== "object")
		return { action, message: retryMessage };
	const { field, message } = error as Record<string, unknown>;
	return {
		action,
		message: typeof message === "string" ? message : retryMessage,
		field:
			field === "name" ||
			field === "url" ||
			field === "intervalSeconds" ||
			field === "expectedStatus"
				? field
				: undefined,
	};
}

export function MonitorEditor({ monitor }: { monitor?: MonitorDto }) {
	const router = useRouter();
	const dialog = useRef<HTMLDialogElement>(null);
	const replacement = useRef<HTMLInputElement>(null);
	const request = useRef<AbortController | null>(null);
	const [submitting, setSubmitting] = useState<Action | null>(null);
	const [navigating, startTransition] = useTransition();
	const [failure, setFailure] = useState<Failure | null>(null);
	const [saved, setSaved] = useState(false);
	const busy = submitting !== null || navigating;
	const blocked = monitor?.status === "blocked";
	const formFailure =
		failure?.action === "create" || failure?.action === "save" ? failure : null;

	useEffect(() => () => request.current?.abort(), []);

	async function mutate(
		action: Action,
		payload?: MonitorEditFields | { isPaused: boolean },
	) {
		if (request.current || navigating) return;
		const controller = new AbortController();
		request.current = controller;
		setSubmitting(action);
		setFailure(null);
		setSaved(false);

		try {
			const response = await fetch(
				monitor ? `/api/monitors/${monitor.id}` : "/api/monitors",
				{
					method:
						action === "create"
							? "POST"
							: action === "delete"
								? "DELETE"
								: "PATCH",
					credentials: "same-origin",
					redirect: "error",
					cache: "no-store",
					headers: payload ? { "Content-Type": "application/json" } : undefined,
					body: payload ? JSON.stringify(payload) : undefined,
					signal: controller.signal,
				},
			);
			if (!response.ok) {
				setFailure(
					readFailure(await response.json().catch(() => null), action),
				);
				return;
			}

			if (action === "create") {
				const result: unknown = await response.json();
				if (
					!result ||
					typeof result !== "object" ||
					!("id" in result) ||
					!isMonitorId(result.id)
				)
					throw new Error();
				const id = result.id;
				startTransition(() => router.push(`/monitors/${id}`));
			} else if (action === "delete") {
				dialog.current?.close();
				startTransition(() => {
					router.replace("/dashboard");
					router.refresh();
				});
			} else {
				if (action === "save") {
					if (replacement.current) replacement.current.value = "";
					setSaved(true);
				}
				startTransition(() => router.refresh());
			}
		} catch {
			if (!controller.signal.aborted)
				setFailure({ action, message: retryMessage });
		} finally {
			request.current = null;
			if (!controller.signal.aborted) setSubmitting(null);
		}
	}

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const values = new FormData(event.currentTarget);
		const url = String(values.get("url") ?? "").trim();
		const fields: MonitorEditFields = {
			name: String(values.get("name") ?? "").trim(),
			intervalSeconds: Number(
				values.get("intervalSeconds"),
			) as MonitorFields["intervalSeconds"],
			expectedStatus: String(
				values.get("expectedStatus"),
			) as MonitorFields["expectedStatus"],
		};
		if (url || !monitor) fields.url = url;
		void mutate(monitor ? "save" : "create", fields);
	}

	function fieldError(field: Field) {
		return formFailure?.field === field ? (
			<p
				className="monitor-field-error"
				id={`monitor-${field}-error`}
				role="alert"
			>
				{formFailure.message}
			</p>
		) : null;
	}

	function description(field: Field, hint?: string) {
		return (
			[
				hint,
				formFailure?.field === field ? `monitor-${field}-error` : undefined,
			]
				.filter(Boolean)
				.join(" ") || undefined
		);
	}

	return (
		<>
			<section
				className="section-panel monitor-editor"
				aria-labelledby="monitor-form-heading"
			>
				<div className="panel-heading">
					<h2 id="monitor-form-heading">Monitor settings</h2>
				</div>
				<form
					className="monitor-form"
					method="post"
					onSubmit={submit}
					aria-busy={busy}
				>
					<fieldset className="monitor-fields" disabled={busy}>
						<div className="monitor-field">
							<label htmlFor="monitor-name">Monitor name</label>
							<input
								id="monitor-name"
								name="name"
								defaultValue={monitor?.name}
								autoComplete="off"
								aria-invalid={formFailure?.field === "name"}
								aria-describedby={description("name")}
								required
							/>
							{fieldError("name")}
						</div>
						<div className="monitor-field">
							<label htmlFor="monitor-url">
								{monitor ? "Replace URL" : "URL"}
							</label>
							<input
								id="monitor-url"
								name="url"
								type="url"
								ref={replacement}
								autoComplete="off"
								autoCapitalize="none"
								spellCheck={false}
								aria-invalid={formFailure?.field === "url"}
								aria-describedby={description("url", "monitor-url-hint")}
								required={!monitor}
							/>
							<p className="monitor-hint" id="monitor-url-hint">
								{monitor && "Leave blank to keep the current URL. "}
								Use a public HTTP or HTTPS address without a username or
								password.
							</p>
							{fieldError("url")}
						</div>
						<div className="monitor-form-grid">
							<div className="monitor-field">
								<label htmlFor="monitor-interval">Check interval</label>
								<select
									id="monitor-interval"
									name="intervalSeconds"
									defaultValue={
										monitor?.intervalSeconds ?? MONITOR_DEFAULT_INTERVAL_SECONDS
									}
									aria-invalid={formFailure?.field === "intervalSeconds"}
									aria-describedby={description("intervalSeconds")}
								>
									{MONITOR_INTERVAL_SECONDS.map((seconds) => (
										<option key={seconds} value={seconds}>
											{seconds / 60} minutes
										</option>
									))}
								</select>
								{fieldError("intervalSeconds")}
							</div>
							<div className="monitor-field">
								<label htmlFor="monitor-expected-status">Expected status</label>
								<select
									id="monitor-expected-status"
									name="expectedStatus"
									defaultValue={
										monitor?.expectedStatus ?? MONITOR_DEFAULT_EXPECTED_STATUS
									}
									aria-invalid={formFailure?.field === "expectedStatus"}
									aria-describedby={description("expectedStatus")}
								>
									{MONITOR_EXPECTED_STATUSES.map((status) => (
										<option key={status} value={status}>
											{status === "2xx" ? "2xx" : "2xx or 3xx"}
										</option>
									))}
								</select>
								{fieldError("expectedStatus")}
							</div>
						</div>
					</fieldset>
					{formFailure && !formFailure.field && (
						<p className="monitor-field-error" role="alert">
							{formFailure.message}
						</p>
					)}
					<div className="monitor-form-actions">
						<button
							className="button button-primary"
							type="submit"
							disabled={busy}
						>
							{submitting === "create"
								? "Creating…"
								: submitting === "save"
									? "Saving…"
									: monitor
										? "Save changes"
										: "Create monitor"}
						</button>
						{monitor ? (
							<p className="monitor-hint" role="status">
								{saved ? "Changes saved." : ""}
							</p>
						) : (
							<Link className="button" href="/dashboard">
								Cancel
							</Link>
						)}
					</div>
				</form>
			</section>

			{monitor && (
				<section
					className="section-panel monitor-editor"
					aria-labelledby="monitor-actions-heading"
				>
					<div className="panel-heading">
						<h2 id="monitor-actions-heading">Monitor actions</h2>
					</div>
					<div className="monitor-form">
						<div className="monitor-form-actions">
							<button
								className="button"
								type="button"
								disabled={busy || blocked}
								onClick={() =>
									void mutate(monitor.isPaused ? "resume" : "pause", {
										isPaused: !monitor.isPaused,
									})
								}
							>
								{monitor.isPaused ? "Resume" : "Pause"}
							</button>
							<button
								className="button"
								type="button"
								disabled={busy}
								onClick={() => {
									setFailure(null);
									dialog.current?.showModal();
								}}
							>
								Delete monitor
							</button>
						</div>
						{blocked && (
							<p className="monitor-hint">
								Save a URL that passes validation before resuming.
							</p>
						)}
						{(failure?.action === "pause" || failure?.action === "resume") && (
							<p className="monitor-field-error" role="alert">
								{failure.message}
							</p>
						)}
					</div>
					<dialog
						className="monitor-dialog"
						ref={dialog}
						aria-labelledby="monitor-delete-heading"
						aria-describedby="monitor-delete-description"
						onCancel={(event) => {
							if (busy) event.preventDefault();
						}}
					>
						<h2 id="monitor-delete-heading">Delete monitor?</h2>
						<p id="monitor-delete-description">
							This permanently removes the monitor, its check history, incidents
							and related alert history, and links to alert channels and status
							pages.
						</p>
						{failure?.action === "delete" && (
							<p className="monitor-field-error" role="alert">
								{failure.message}
							</p>
						)}
						<div className="monitor-form-actions">
							<button
								className="button"
								type="button"
								disabled={busy}
								onClick={() => dialog.current?.close()}
							>
								Cancel
							</button>
							<button
								className="button monitor-confirm-delete"
								type="button"
								disabled={busy}
								onClick={() => void mutate("delete")}
							>
								{submitting === "delete" ? "Deleting…" : "Delete monitor"}
							</button>
						</div>
					</dialog>
				</section>
			)}
		</>
	);
}
