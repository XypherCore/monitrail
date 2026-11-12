"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
	AlertChannelOptions,
	type ChannelOption,
	selectedChannelIds,
} from "./alert-channel-options";

export function MonitorSubscriptions({
	monitorId,
	channels,
	selected,
}: {
	monitorId: string;
	channels: readonly ChannelOption[];
	selected: readonly string[];
}) {
	const router = useRouter();
	const request = useRef<AbortController | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const [saved, setSaved] = useState(false);
	const selectionKey = [...selected].sort().join(",");

	useEffect(() => () => request.current?.abort(), []);

	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (request.current) return;
		const controller = new AbortController();
		const channelIds = selectedChannelIds(new FormData(event.currentTarget));
		request.current = controller;
		setSaving(true);
		setError("");
		setSaved(false);
		try {
			const response = await fetch(`/api/monitors/${monitorId}/channels`, {
				method: "PUT",
				credentials: "same-origin",
				cache: "no-store",
				redirect: "error",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ channelIds }),
				signal: controller.signal,
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				const message = body?.error?.message;
				setError(
					typeof message === "string"
						? message
						: "Alert subscriptions could not be saved.",
				);
				return;
			}
			setSaved(true);
			router.refresh();
		} catch {
			if (!controller.signal.aborted)
				setError("Alert subscriptions could not be saved.");
		} finally {
			request.current = null;
			if (!controller.signal.aborted) setSaving(false);
		}
	}

	return (
		<section
			className="section-panel monitor-editor"
			aria-labelledby="monitor-alerts-heading"
		>
			<div className="panel-heading">
				<h2 id="monitor-alerts-heading">Alert subscriptions</h2>
			</div>
			{channels.length > 0 ? (
				<form
					method="post"
					className="monitor-form"
					onSubmit={save}
					aria-busy={saving}
				>
					<fieldset className="monitor-fields" disabled={saving}>
						<legend className="monitor-hint">
							Send incident alerts to these verified channels.
						</legend>
						<AlertChannelOptions
							key={selectionKey}
							channels={channels}
							selected={selected}
						/>
					</fieldset>
					{error && (
						<p className="monitor-field-error" role="alert">
							{error}
						</p>
					)}
					<div className="monitor-form-actions">
						<button className="button" type="submit" disabled={saving}>
							{saving ? "Saving…" : "Save alert subscriptions"}
						</button>
						<p className="monitor-hint" role="status">
							{saved ? "Alert subscriptions saved." : ""}
						</p>
					</div>
				</form>
			) : (
				<p className="section-description">
					<Link href="/channels">Add a verified channel</Link> to receive
					incident alerts.
				</p>
			)}
		</section>
	);
}
