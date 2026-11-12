"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { channelTypeNames, type ChannelOption } from "./alert-channel-options";
import styles from "./alert-channels.module.css";
import { MonitorRefresh } from "./monitor-refresh";

type ListedChannel = ChannelOption & { isVerified: boolean };
type Feedback = { area: string; message: string; failed: boolean };
type TelegramLink = { url: string; expires: number };

const retryMessage = "The channel request could not be completed. Try again.";
const expiryTime = new Intl.DateTimeFormat("en", {
	timeStyle: "short",
	timeZone: "UTC",
});

function telegramLinkFrom(value: unknown): TelegramLink | null {
	if (
		typeof value !== "object" ||
		value === null ||
		!("url" in value) ||
		!("expiresAt" in value)
	)
		return null;
	if (typeof value.url !== "string" || typeof value.expiresAt !== "string")
		return null;
	try {
		const url = new URL(value.url);
		const expires = Date.parse(value.expiresAt);
		if (
			url.origin !== "https://t.me" ||
			url.username ||
			url.password ||
			url.hash ||
			!/^\/[a-zA-Z0-9_]+$/.test(url.pathname) ||
			url.searchParams.size !== 1 ||
			!/^[-_a-zA-Z0-9]+$/.test(url.searchParams.get("start") ?? "") ||
			!Number.isFinite(expires) ||
			expires <= Date.now()
		)
			return null;
		return { url: url.href, expires };
	} catch {
		return null;
	}
}

function ChannelFeedback({
	feedback,
	area,
}: {
	feedback: Feedback | null;
	area: string;
}) {
	const message = feedback?.area === area ? feedback : null;
	if (!message) return null;
	return message.failed ? (
		<p className="monitor-field-error" role="alert">
			{message.message}
		</p>
	) : (
		<p className="monitor-hint" role="status">
			{message.message}
		</p>
	);
}

export function ChannelsEditor({
	channels,
}: {
	channels: readonly ListedChannel[];
}) {
	const router = useRouter();
	const request = useRef<AbortController | null>(null);
	const deleteDialog = useRef<HTMLDialogElement>(null);
	const [removing, setRemoving] = useState<ListedChannel | null>(null);
	const [renaming, setRenaming] = useState<string>();
	const [telegramLink, setTelegramLink] = useState<TelegramLink | null>(null);
	const [feedback, setFeedback] = useState<Feedback | null>(null);
	const [busy, setBusy] = useState<string>();

	useEffect(() => () => request.current?.abort(), []);
	useEffect(() => {
		if (!telegramLink) return;
		const timeout = setTimeout(
			() => {
				setTelegramLink(null);
				setFeedback((current) =>
					current?.area === "telegram"
						? {
								area: "telegram",
								message: "The link expired. Create another to continue.",
								failed: false,
							}
						: current,
				);
			},
			Math.max(0, telegramLink.expires - Date.now()),
		);
		return () => clearTimeout(timeout);
	}, [telegramLink]);

	async function perform(
		area: string,
		method: "POST" | "PATCH" | "DELETE",
		path: string,
		complete: (data: unknown) => string,
		payload?: Record<string, string>,
	) {
		if (request.current) return;
		const controller = new AbortController();
		request.current = controller;
		setBusy(area);
		setFeedback(null);
		try {
			const response = await fetch(path, {
				method,
				credentials: "same-origin",
				cache: "no-store",
				redirect: "error",
				headers: payload ? { "Content-Type": "application/json" } : undefined,
				body: payload ? JSON.stringify(payload) : undefined,
				signal: controller.signal,
			});
			const data = await response.json().catch(() => null);
			if (!response.ok) {
				const message = data?.error?.message;
				setFeedback({
					area,
					message: typeof message === "string" ? message : retryMessage,
					failed: true,
				});
				return;
			}
			setFeedback({ area, message: complete(data), failed: false });
			router.refresh();
		} catch {
			if (!controller.signal.aborted)
				setFeedback({ area, message: retryMessage, failed: true });
		} finally {
			request.current = null;
			if (!controller.signal.aborted) setBusy(undefined);
		}
	}

	function addWebhook(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = event.currentTarget;
		const input = new FormData(form);
		void perform(
			"webhook",
			"POST",
			"/api/channels",
			() => {
				form.reset();
				return "Channel added. Send a test alert to verify it.";
			},
			{
				type: String(input.get("type") ?? ""),
				label: String(input.get("label") ?? ""),
				url: String(input.get("url") ?? ""),
			},
		);
	}

	function rename(event: FormEvent<HTMLFormElement>, channelId: string) {
		event.preventDefault();
		const input = new FormData(event.currentTarget);
		void perform(
			channelId,
			"PATCH",
			`/api/channels/${channelId}`,
			() => {
				setRenaming(undefined);
				return "Channel renamed.";
			},
			{ label: String(input.get("label") ?? "") },
		);
	}

	function linkTelegram() {
		void perform("telegram", "POST", "/api/channels/telegram", (data) => {
			const link = telegramLinkFrom(data);
			if (!link) throw new Error();
			setTelegramLink(link);
			return "Link ready.";
		});
	}

	function remove() {
		if (!removing) return;
		void perform("delete", "DELETE", `/api/channels/${removing.id}`, () => {
			deleteDialog.current?.close();
			return "Channel deleted.";
		});
	}

	return (
		<div className={styles.layout}>
			<section className="section-panel" aria-labelledby="channels-heading">
				<div className="panel-heading">
					<h2 id="channels-heading">Alert channels</h2>
				</div>
				{channels.length ? (
					<ul className={styles.channelList}>
						{channels.map((channel) => (
							<li
								key={channel.id}
								className={styles.channel}
								aria-labelledby={`channel-${channel.id}`}
							>
								<div className={styles.channelSummary}>
									<div className={styles.channelIdentity}>
										<h3 id={`channel-${channel.id}`}>{channel.label}</h3>
										<p className="monitor-hint">
											{channelTypeNames[channel.type]}
										</p>
									</div>
									<span className={styles.badge}>
										{channel.isVerified ? "Verified" : "Unverified"}
									</span>
								</div>
								<div className="monitor-form-actions">
									<button
										className="button"
										type="button"
										disabled={!!busy}
										onClick={() =>
											void perform(
												channel.id,
												"POST",
												`/api/channels/${channel.id}/test`,
												() => "Test alert sent.",
											)
										}
									>
										Send test alert
									</button>
									<button
										className="button"
										type="button"
										disabled={!!busy}
										aria-expanded={renaming === channel.id}
										onClick={() =>
											setRenaming(
												renaming === channel.id ? undefined : channel.id,
											)
										}
									>
										Rename
									</button>
									<button
										className="button"
										type="button"
										disabled={!!busy}
										onClick={() => {
											setFeedback(null);
											setRemoving(channel);
											deleteDialog.current?.showModal();
										}}
									>
										Delete channel
									</button>
								</div>
								{renaming === channel.id && (
									<form
										method="post"
										className={styles.rename}
										onSubmit={(event) => rename(event, channel.id)}
									>
										<div className="monitor-field">
											<label htmlFor={`channel-label-${channel.id}`}>
												Channel label
											</label>
											<input
												id={`channel-label-${channel.id}`}
												name="label"
												defaultValue={channel.label}
												required
												disabled={!!busy}
											/>
										</div>
										<button className="button" type="submit" disabled={!!busy}>
											Save label
										</button>
									</form>
								)}
								<ChannelFeedback feedback={feedback} area={channel.id} />
							</li>
						))}
					</ul>
				) : (
					<p className="section-description">
						Add a channel below to start receiving incident alerts.
					</p>
				)}
				{feedback?.area === "delete" && !feedback.failed && (
					<p className="section-description" role="status">
						{feedback.message}
					</p>
				)}
			</section>
			<section className="section-panel" aria-labelledby="add-channel-heading">
				<div className="panel-heading">
					<h2 id="add-channel-heading">Add a webhook channel</h2>
				</div>
				<form
					method="post"
					className="monitor-form"
					onSubmit={addWebhook}
					aria-busy={busy === "webhook"}
				>
					<fieldset className="monitor-fields" disabled={!!busy}>
						<div className="monitor-field">
							<label htmlFor="new-channel-type">Channel type</label>
							<select id="new-channel-type" name="type">
								<option value="webhook">Generic webhook</option>
								<option value="discord">Discord</option>
								<option value="slack">Slack</option>
							</select>
						</div>
						<div className="monitor-field">
							<label htmlFor="new-channel-label">Channel label</label>
							<input id="new-channel-label" name="label" required />
						</div>
						<div className="monitor-field">
							<label htmlFor="new-channel-url">Webhook URL</label>
							<input
								id="new-channel-url"
								name="url"
								type="password"
								inputMode="url"
								autoComplete="off"
								autoCapitalize="none"
								spellCheck={false}
								aria-describedby="new-channel-hint"
								required
							/>
							<p className="monitor-hint" id="new-channel-hint">
								Use a public HTTPS URL. For Discord and Slack, use the webhook
								URL provided by that service.
							</p>
						</div>
					</fieldset>
					<ChannelFeedback feedback={feedback} area="webhook" />
					<div className="monitor-form-actions">
						<button
							className="button button-primary"
							type="submit"
							disabled={!!busy}
						>
							{busy === "webhook" ? "Adding…" : "Add channel"}
						</button>
					</div>
				</form>
			</section>
			<section className="section-panel" aria-labelledby="telegram-heading">
				<div className="panel-heading">
					<h2 id="telegram-heading">Connect Telegram</h2>
				</div>
				<div className="monitor-form" aria-busy={busy === "telegram"}>
					<p className="monitor-hint">
						Open the one-time link and press Start in your private chat with the
						bot.
					</p>
					{telegramLink ? (
						<>
							<MonitorRefresh />
							<div className="monitor-form-actions">
								<a
									className="button"
									href={telegramLink.url}
									target="_blank"
									rel="noopener noreferrer"
								>
									Open Telegram
								</a>
								<button
									className="button"
									type="button"
									onClick={() => router.refresh()}
								>
									Refresh channels
								</button>
								<button
									className="button"
									type="button"
									onClick={() => {
										setTelegramLink(null);
										setFeedback((current) =>
											current?.area === "telegram" ? null : current,
										);
									}}
								>
									Dismiss link
								</button>
							</div>
							<p className="monitor-hint">
								Expires at{" "}
								<time dateTime={new Date(telegramLink.expires).toISOString()}>
									{expiryTime.format(telegramLink.expires)} UTC
								</time>
								.
							</p>
						</>
					) : (
						<div className="monitor-form-actions">
							<button
								className="button"
								type="button"
								onClick={linkTelegram}
								disabled={!!busy}
							>
								{busy === "telegram"
									? "Creating link…"
									: "Create Telegram link"}
							</button>
						</div>
					)}
					<ChannelFeedback feedback={feedback} area="telegram" />
				</div>
			</section>
			<dialog
				className="monitor-dialog"
				ref={deleteDialog}
				aria-labelledby="channel-delete-title"
				aria-describedby="channel-delete-details"
				onCancel={(event) => {
					if (busy === "delete") event.preventDefault();
				}}
			>
				<h2 id="channel-delete-title">Delete channel?</h2>
				<p className={styles.channelIdentity} id="channel-delete-details">
					This removes {removing?.label || "the channel"}, its monitor
					subscriptions, and its alert delivery history.
				</p>
				{feedback?.failed && (
					<ChannelFeedback feedback={feedback} area="delete" />
				)}
				<div className="monitor-form-actions">
					<button
						className="button"
						type="button"
						onClick={() => deleteDialog.current?.close()}
						disabled={busy === "delete"}
					>
						Cancel
					</button>
					<button
						className="button monitor-confirm-delete"
						type="button"
						onClick={remove}
						disabled={!!busy}
					>
						{busy === "delete" ? "Deleting…" : "Delete channel"}
					</button>
				</div>
			</dialog>
		</div>
	);
}
