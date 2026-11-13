"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useRef, useState } from "react";
import type { StatusPageFields } from "../status-pages/contracts.ts";
import styles from "./status-page-editor.module.css";

type ManagedPage = StatusPageFields & { id: string; isPublished: boolean };
type Choice = { id: string; name: string };
type Feedback = { failed: boolean; message: string };

export function StatusPageEditor({
	page,
	choices,
}: {
	page?: ManagedPage;
	choices: Choice[];
}) {
	const router = useRouter();
	const dialog = useRef<HTMLDialogElement>(null);
	const [selection, setSelection] = useState(
		() =>
			new Map(
				page?.monitors.map(({ monitorId, showUrl }) => [monitorId, showUrl]),
			),
	);
	const [feedback, setFeedback] = useState<Feedback>();
	const [busy, setBusy] = useState(false);
	const active = useRef(false);
	const heading = page ? `status-page-${page.id}` : "status-page-new";
	const path = page ? `/api/status-pages/${page.id}` : "/api/status-pages";
	const publicPath = page ? `/status/${page.slug}` : "";
	const existingIds = new Set(page?.monitors.map(({ monitorId }) => monitorId));
	const orderedChoices = [
		...(page?.monitors ?? []).flatMap(({ monitorId }) =>
			choices.filter((choice) => choice.id === monitorId),
		),
		...choices.filter((choice) => !existingIds.has(choice.id)),
	];

	function setMonitor(id: string, selected: boolean, showUrl = false) {
		setSelection((current) => {
			const next = new Map(current);
			if (selected) next.set(id, showUrl);
			else next.delete(id);
			return next;
		});
	}

	async function mutate(
		method: "POST" | "PATCH" | "DELETE",
		message: string,
		body?: StatusPageFields | { isPublished: boolean },
		complete?: () => void,
	) {
		if (active.current) return;
		active.current = true;
		setBusy(true);
		setFeedback(undefined);
		try {
			const response = await fetch(path, {
				method,
				credentials: "same-origin",
				cache: "no-store",
				redirect: "error",
				headers: body ? { "content-type": "application/json" } : undefined,
				body: body ? JSON.stringify(body) : undefined,
			});
			if (!response.ok) {
				const result = await response.json().catch(() => null);
				setFeedback({
					failed: true,
					message:
						typeof result?.error?.message === "string"
							? result.error.message
							: "The status page request could not be completed.",
				});
				return;
			}
			complete?.();
			setFeedback({ failed: false, message });
			router.refresh();
		} catch {
			setFeedback({
				failed: true,
				message: "The status page request could not be completed. Try again.",
			});
		} finally {
			active.current = false;
			setBusy(false);
		}
	}

	function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = event.currentTarget;
		const data = new FormData(form);
		void mutate(
			page ? "PATCH" : "POST",
			page ? "Status page saved." : "Draft created.",
			{
				title: String(data.get("title") ?? ""),
				slug: String(data.get("slug") ?? ""),
				monitors: orderedChoices.flatMap(({ id }) =>
					selection.has(id)
						? [{ monitorId: id, showUrl: selection.get(id) === true }]
						: [],
				),
			},
			() => {
				if (!page) {
					form.reset();
					setSelection(new Map());
				}
			},
		);
	}

	async function copyPublicLink() {
		try {
			await navigator.clipboard.writeText(
				new URL(publicPath, window.location.origin).href,
			);
			setFeedback({ failed: false, message: "Public link copied." });
		} catch {
			setFeedback({
				failed: true,
				message: "Open the public page and copy its address.",
			});
		}
	}

	return (
		<section
			className={`section-panel ${styles.editor}`}
			aria-labelledby={heading}
		>
			<div className="panel-heading">
				<h2 id={heading}>{page?.title ?? "New status page"}</h2>
				{page && (
					<span className={styles.state}>
						{page.isPublished ? "Published" : "Draft"}
					</span>
				)}
			</div>
			<form className={styles.form} onSubmit={save} method="post">
				<div className={styles.fields}>
					<label>
						Page title
						<input
							className="monitor-input"
							name="title"
							defaultValue={page?.title}
							required
						/>
					</label>
					<label>
						Public slug
						<input
							className="monitor-input"
							name="slug"
							defaultValue={page?.slug}
							required
							minLength={3}
							maxLength={40}
							pattern="(?:[a-z0-9]|-){3,40}"
							autoCapitalize="none"
							spellCheck={false}
							aria-describedby={`${heading}-slug-note`}
						/>
					</label>
				</div>
				<p className="monitor-hint" id={`${heading}-slug-note`}>
					Use lowercase letters, digits, or hyphens. A slug change replaces the
					public link.
				</p>
				<fieldset className={styles.monitors}>
					<legend>Monitors</legend>
					{orderedChoices.length === 0 && (
						<p className="monitor-hint">Add a monitor before publishing.</p>
					)}
					{orderedChoices.map(({ id, name }) => (
						<div className={styles.monitor} key={id}>
							<label className={styles.check}>
								<input
									type="checkbox"
									checked={selection.has(id)}
									onChange={(event) => setMonitor(id, event.target.checked)}
								/>
								<span>{name}</span>
							</label>
							<label className={styles.check}>
								<input
									type="checkbox"
									checked={selection.get(id) === true}
									disabled={!selection.has(id)}
									aria-label={`Show URL for ${name}`}
									onChange={(event) =>
										setMonitor(id, true, event.target.checked)
									}
								/>
								<span>Show URL</span>
							</label>
						</div>
					))}
					{orderedChoices.length > 0 && (
						<p className="monitor-hint">
							When enabled, the public page shows the address and path. Query
							strings stay private.
						</p>
					)}
				</fieldset>
				<div className={styles.actions}>
					<button
						className="button button-primary"
						type="submit"
						disabled={busy}
					>
						{page ? "Save changes" : "Create draft"}
					</button>
					{page && (
						<button
							className="button"
							type="button"
							disabled={busy || (!page.isPublished && !page.monitors.length)}
							onClick={() =>
								void mutate(
									"PATCH",
									page.isPublished
										? "Status page unpublished."
										: "Status page published.",
									{ isPublished: !page.isPublished },
								)
							}
						>
							{page.isPublished ? "Unpublish" : "Publish"}
						</button>
					)}
				</div>
			</form>
			{page && (
				<div className={styles.actions}>
					{page.isPublished && (
						<>
							<a
								className="button"
								href={publicPath}
								target="_blank"
								rel="noreferrer"
							>
								Open public page
							</a>
							<button
								className="button"
								type="button"
								onClick={() => void copyPublicLink()}
							>
								Copy link
							</button>
						</>
					)}
					<button
						className="button"
						type="button"
						onClick={() => dialog.current?.showModal()}
					>
						Delete status page
					</button>
					<dialog
						ref={dialog}
						className="monitor-dialog"
						aria-labelledby={`${heading}-delete`}
					>
						<h3 id={`${heading}-delete`}>Delete status page?</h3>
						<p>This removes the public page and its monitor selections.</p>
						<div className={styles.actions}>
							<button
								className="button"
								type="button"
								onClick={() => dialog.current?.close()}
							>
								Cancel
							</button>
							<button
								className="button monitor-confirm-delete"
								type="button"
								disabled={busy}
								onClick={() =>
									void mutate("DELETE", "Status page deleted.", undefined, () =>
										dialog.current?.close(),
									)
								}
							>
								Delete status page
							</button>
						</div>
						{feedback?.failed && (
							<p className="monitor-field-error" role="alert">
								{feedback.message}
							</p>
						)}
					</dialog>
				</div>
			)}
			{feedback && (
				<p
					className={`${styles.feedback} ${feedback.failed ? "monitor-field-error" : "monitor-hint"}`}
					role={feedback.failed ? "alert" : "status"}
				>
					{feedback.message}
				</p>
			)}
		</section>
	);
}
