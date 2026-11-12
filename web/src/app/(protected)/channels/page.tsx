import { getCurrentDataAccess, requireUser } from "../../../auth/session";
import { ChannelsEditor } from "../../../components/channels-editor";

export default async function ChannelsPage() {
	await requireUser("/channels");
	const access = await getCurrentDataAccess();
	const channels = (await access.listChannels()).map(
		({ id, label, type, isVerified }) => ({
			id,
			label,
			type,
			isVerified,
		}),
	);
	return (
		<>
			<div className="page-heading">
				<h1>Channels</h1>
				<p>Where your incident notifications are delivered.</p>
			</div>
			<ChannelsEditor channels={channels} />
		</>
	);
}
