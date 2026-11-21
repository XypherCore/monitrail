"use client";

import { useRef, useState } from "react";

export function DeleteAccount() {
  const dialog = useRef<HTMLDialogElement>(null);
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function remove() {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/account", {
        method: "DELETE",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        setError(typeof result?.error?.message === "string"
          ? result.error.message : "Account deletion failed. Try again.");
        return;
      }
      // A full navigation discards cached private screens after session revocation.
      window.location.replace("/?account=deleted");
    } catch {
      setError("Account deletion failed. Try again.");
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="section-panel" aria-labelledby="delete-account-heading">
      <div className="panel-heading">
        <h2 id="delete-account-heading">Delete account</h2>
      </div>
      <div className="monitor-form">
        <p>Permanently remove your account and its data.</p>
        <div className="monitor-form-actions">
          <button className="button" type="button" disabled={busy}
            onClick={() => { setError(""); dialog.current?.showModal(); }}>
            Delete account
          </button>
        </div>
      </div>
      <dialog ref={dialog} className="monitor-dialog" aria-labelledby="delete-account-confirm"
        aria-describedby="delete-account-description" aria-busy={busy}
        onCancel={(event) => { if (busy) event.preventDefault(); }}>
        <h3 id="delete-account-confirm">Delete account?</h3>
        <p id="delete-account-description">
          This removes your account, monitors, check history, incidents, alert channels and public status
          pages, and signs you out on every device. This action cannot be undone.
        </p>
        <div className="monitor-form-actions">
          <button className="button" type="button" disabled={busy} onClick={() => dialog.current?.close()}>
            Cancel
          </button>
          <button className="button monitor-confirm-delete" type="button" disabled={busy} onClick={() => void remove()}>
            {busy ? "Deleting…" : "Delete account"}
          </button>
        </div>
        {error && <p className="monitor-field-error" role="alert">{error}</p>}
      </dialog>
    </section>
  );
}
