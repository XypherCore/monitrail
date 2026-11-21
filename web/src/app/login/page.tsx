import Link from "next/link";
import { identity } from "../../../../shared/identity";
import { sanitizeNextPath } from "../../auth/redirect";
import { LoginButtons } from "../../components/login-buttons";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  return (
    <div className="public-page">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="public-header">
        <Link className="wordmark" href="/">
          <span className="brand-mark" aria-hidden="true">
            {identity.monogram}
          </span>
          {identity.brandName}
        </Link>
      </header>
      <main className="login-main" id="main-content">
        <div className="login-card">
          <h1>Sign in to {identity.brandName}</h1>
          <p className="login-description">Open your monitoring workspace.</p>
          <LoginButtons
            nextPath={sanitizeNextPath(params.next)}
            initialError={
              params.error === "invite" || params.error === "account_conflict"
                ? params.error
                : params.error
                  ? "oauth"
                  : null
            }
            inviteOnly={process.env.SIGNUP_MODE !== "open"}
          />
          <p className="login-note">Use your GitHub or Google account to continue.</p>
        </div>
      </main>
    </div>
  );
}
