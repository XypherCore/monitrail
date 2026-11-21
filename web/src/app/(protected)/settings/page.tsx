import { requireUser } from "../../../auth/session";
import { DeleteAccount } from "../../../components/delete-account";

export default async function SettingsPage() {
	const user = await requireUser("/settings");
	return (
		<>
			<div className="page-heading">
				<h1>Settings</h1>
				<p>Your signed-in account.</p>
			</div>
			<section className="section-panel" aria-labelledby="account-heading">
				<div className="panel-heading">
					<h2 id="account-heading">Account</h2>
				</div>
				<dl className="account-details">
					<div className="account-field">
						<dt>Name</dt>
						<dd>{user.name}</dd>
					</div>
					<div className="account-field">
						<dt>Email</dt>
						<dd>{user.email ?? "Not provided"}</dd>
					</div>
				</dl>
			</section>
			<DeleteAccount />
		</>
	);
}
