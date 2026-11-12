import type { ChannelDto } from "../data/access";
import styles from "./alert-channels.module.css";

export const channelTypeNames = {
	telegram: "Telegram",
	webhook: "Webhook",
	discord: "Discord",
	slack: "Slack",
} satisfies Record<ChannelDto["type"], string>;

export type ChannelOption = Pick<ChannelDto, "id" | "label" | "type">;

export function AlertChannelOptions({
	channels,
	selected,
}: {
	channels: readonly ChannelOption[];
	selected: readonly string[];
}) {
	return (
		<div className={styles.options}>
			{channels.map((channel) => (
				<label className={styles.option} key={channel.id}>
					<input
						type="checkbox"
						name="channelIds"
						value={channel.id}
						defaultChecked={selected.includes(channel.id)}
					/>
					<span>
						{channel.label}
						<span className={styles.secondary}>
							{channelTypeNames[channel.type]}
						</span>
					</span>
				</label>
			))}
		</div>
	);
}

export function selectedChannelIds(form: FormData): string[] {
	return form
		.getAll("channelIds")
		.filter((id): id is string => typeof id === "string");
}
