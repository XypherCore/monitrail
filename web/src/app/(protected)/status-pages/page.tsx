import { getCurrentDataAccess, requireUser } from "../../../auth/session";
import { StatusPageEditor } from "../../../components/status-page-editor";

export default async function StatusPagesPage() {
	await requireUser("/status-pages");
	const access = await getCurrentDataAccess();
	const [pages, monitors] = await Promise.all([
		access.listStatusPages(),
		access.listMonitors(),
	]);
	const choices = monitors.map(({ id, name }) => ({ id, name }));
	const selections = await Promise.all(
		pages.map(({ id }) => access.listPageMonitors(id)),
	);
	return (
		<>
			<div className="page-heading">
				<h1>Status pages</h1>
				<p>A public view of the monitors you choose to share.</p>
			</div>
			{pages.map((page, index) => (
				<StatusPageEditor
					key={page.id}
					page={{
						id: page.id,
						title: page.title,
						slug: page.slug,
						isPublished: page.isPublished,
						monitors: selections[index].map(({ monitorId, showUrl }) => ({
							monitorId,
							showUrl,
						})),
					}}
					choices={choices}
				/>
			))}
			<StatusPageEditor choices={choices} />
		</>
	);
}
