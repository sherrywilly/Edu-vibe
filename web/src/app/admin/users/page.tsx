"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Role = "super_admin" | "exam_manager" | "reviewer";
type Account = { id: string; username: string; role: Role; createdAt: string };
const roleLabels: Record<Role, string> = { super_admin: "Super admin", exam_manager: "Exam manager", reviewer: "Reviewer" };

async function request<T>(path: string, method = "GET", body?: object): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, body === undefined ? { method } : {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  } catch { throw new Error("Unable to connect. Check your connection and try again."); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const fallback = response.status === 401 ? "Please sign in again." :
      response.status === 403 ? "You do not have permission for this action." : "Request failed. Please try again.";
    throw new Error(typeof data.message === "string" ? data.message : fallback);
  }
  return data as T;
}

function RoleOptions() {
  return <>{(Object.keys(roleLabels) as Role[]).map(role => <option key={role} value={role}>{roleLabels[role]}</option>)}</>;
}

export default function AdminUsers() {
  const [admin, setAdmin] = useState<Account | null>(null);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const current = await request<Account>("/api/admin/me");
      setAdmin(current);
      setAccounts(current.role === "super_admin" ? await request<Account[]>("/api/admin/accounts") : null);
    } catch (e) {
      setAdmin(null); setAccounts(null);
      setError(e instanceof Error ? e.message : "Unable to connect.");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(action: () => Promise<void>, success: string) {
    setBusy(true); setError(""); setMessage("");
    try { await action(); setMessage(success); return true; }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to connect."); return false; }
    finally { setBusy(false); }
  }

  return <div className="form-wrap">
    <p className="eyebrow">Administration</p><h1>Administrator accounts</h1>
    <p><Link href="/admin">← Administration</Link></p>
    {error && <p className="notice error" role="alert">{error}</p>}
    {message && <p className="notice" role="status">{message}</p>}
    {loading ? <p>Loading…</p> : !admin ? <button type="button" onClick={() => void load()}>Try again</button> : <>
      <p>Signed in as {admin.username} ({roleLabels[admin.role]}).</p>
      <section className="card">
        <h2>Change your password</h2>
        <p>Changing your password signs you out on all devices.</p>
        <form onSubmit={event => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          if (data.get("newPassword") !== data.get("confirmPassword")) { setError("New passwords do not match."); return; }
          void run(async () => {
            await request("/api/admin/change-password", "POST", { currentPassword: data.get("currentPassword"), newPassword: data.get("newPassword") });
            form.reset(); setAdmin(null); setAccounts(null);
          }, "Password changed. Sign in again from the administration page.");
        }}>
          <label>Current password<input name="currentPassword" type="password" autoComplete="current-password" required /></label>
          <label>New password (at least 12 characters)<input name="newPassword" type="password" autoComplete="new-password" minLength={12} required /></label>
          <label>Confirm new password<input name="confirmPassword" type="password" autoComplete="new-password" minLength={12} required /></label>
          <button disabled={busy}>Change password</button>
        </form>
      </section>
      {admin.role === "super_admin" && accounts && <>
        <section className="card">
          <h2>Create account</h2>
          <p>Use a unique username. Passwords must contain at least 12 characters.</p>
          <form onSubmit={event => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            if (data.get("password") !== data.get("confirmPassword")) { setError("Passwords do not match."); return; }
            void run(async () => {
              const created = await request<Account>("/api/admin/accounts", "POST", { username: data.get("username"), password: data.get("password"), role: data.get("role") });
              form.reset();
              setAccounts(current => current ? [...current, created] : current);
            }, "Account created.");
          }}>
            <label>Username<input name="username" required minLength={3} maxLength={64} pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}" autoComplete="off" /></label>
            <label>Role<select name="role" defaultValue="reviewer"><RoleOptions /></select></label>
            <label>Initial password<input name="password" type="password" required minLength={12} autoComplete="new-password" /></label>
            <label>Confirm password<input name="confirmPassword" type="password" required minLength={12} autoComplete="new-password" /></label>
            <button disabled={busy}>Create account</button>
          </form>
        </section>
        <section><h2>Accounts</h2>
          <p>Role changes and password resets sign the affected account out on all devices.</p>
          <div className="list">{accounts.map(account => <AccountEditor key={`${account.id}:${account.role}`} account={account} currentId={admin.id} busy={busy} lastSuperAdmin={account.role === "super_admin" && accounts.filter(item => item.role === "super_admin").length === 1} onUpdate={async (body, success) => {
            if (!window.confirm(`${success === "Role updated." ? "Change the role" : "Reset the password"} for ${account.username}? Their sessions will be revoked.`)) return false;
            return run(async () => {
              const updated = await request<Account>(`/api/admin/accounts/${encodeURIComponent(account.id)}`, "PATCH", body);
              if (account.id === admin.id) { setAdmin(null); setAccounts(null); }
              else setAccounts(current => current?.map(item => item.id === updated.id ? updated : item) ?? null);
            }, account.id === admin.id ? "Role updated. Sign in again from the administration page." : success);
          }} />)}</div>
        </section>
      </>}
    </>}
  </div>;
}

function AccountEditor({ account, currentId, busy, lastSuperAdmin, onUpdate }: {
  account: Account; currentId: string; busy: boolean; lastSuperAdmin: boolean;
  onUpdate: (body: { role?: Role; password?: string }, success: string) => Promise<boolean>;
}) {
  const [role, setRole] = useState<Role>(account.role);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  return <article className="card">
    <h3>{account.username}{account.id === currentId ? " (you)" : ""}</h3>
    <p>Current role: {roleLabels[account.role]}</p>
    <form onSubmit={event => { event.preventDefault(); void onUpdate({ role }, "Role updated."); }}>
      <label>Role<select value={role} onChange={event => setRole(event.target.value as Role)}><RoleOptions /></select></label>
      {lastSuperAdmin && role !== "super_admin" && <p className="notice error">At least one super admin is required.</p>}
      <button disabled={busy || role === account.role || (lastSuperAdmin && role !== "super_admin")}>Save role</button>
    </form>
    {account.id !== currentId && <form onSubmit={event => {
      event.preventDefault();
      if (password !== confirmation) return;
      void onUpdate({ password }, "Password reset.").then(ok => { if (ok) { setPassword(""); setConfirmation(""); } });
    }}>
      <label>New password<input type="password" value={password} onChange={event => setPassword(event.target.value)} minLength={12} autoComplete="new-password" required /></label>
      <label>Confirm new password<input type="password" value={confirmation} onChange={event => setConfirmation(event.target.value)} minLength={12} autoComplete="new-password" required /></label>
      {confirmation && password !== confirmation && <p className="notice error" role="alert">Passwords do not match.</p>}
      <button disabled={busy || password !== confirmation}>Reset password</button>
    </form>}
  </article>;
}
