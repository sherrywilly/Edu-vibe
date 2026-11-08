"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Location = { id: string; key: string; name: string; active: boolean; opensAt: string | null; closesAt: string | null; _count: { students: number } };
type AdminAccount = { id: string; username: string; role: "super_admin" | "exam_manager" | "reviewer" };
export default function Admin() {
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [admin, setAdmin] = useState<AdminAccount | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setLoadFailed(false); setError("");
    try {
      const session = await fetch("/api/admin/me");
      if (session.status === 401) { setAdmin(null); setLocations(null); return; }
      if (!session.ok) throw new Error("Unable to check your session. Please try again.");
      const account: AdminAccount = await session.json();
      setAdmin(account);
      const r = await fetch("/api/admin/locations");
      if (r.ok) setLocations(await r.json());
      else if (r.status === 401) { setAdmin(null); setLocations(null); }
      else throw new Error("Unable to load locations. Please try again.");
    } catch (e) { setLoadFailed(true); setError(e instanceof Error ? e.message : "Unable to connect."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function send(path: string, values: object) {
    setBusy(true); setError("");
    try {
      const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      const result = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof result.message === "string" ? result.message : "Request failed. Please try again.");
      if (path === "/api/logout") { setAdmin(null); setLocations(null); }
      else await load();
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to connect."); return false; }
    finally { setBusy(false); }
  }
  const canManageLocations = admin?.role === "super_admin" || admin?.role === "exam_manager";
  return <div className="form-wrap"><p className="eyebrow">Administration</p><h1>{admin ? "Registration locations" : "Admin sign in"}</h1>
    {error && <p className="notice error" role="alert">{error}</p>}
    {loading ? <p>Loading…</p> : loadFailed ? <button type="button" onClick={() => void load()}>Try again</button> : !admin ? <form onSubmit={e => { e.preventDefault(); void send("/api/admin/login", Object.fromEntries(new FormData(e.currentTarget))); }}>
      <label>Username<input name="username" required autoComplete="username" /></label>
      <label>Password<input name="password" type="password" required autoComplete="current-password" /></label><button disabled={busy}>Sign in</button>
    </form> : locations && <>
      <p className="muted">Signed in as {admin.username} ({admin.role.replace("_", " ")}).</p>
      {canManageLocations && <p className="muted">Create a unique link for each registration location.</p>}
      <div className="actions"><Link className="button secondary" href="/admin/exams">{canManageLocations ? "Manage exams" : "View exams"}</Link><Link className="button secondary" href="/admin/students">View students</Link>
        <Link className="button secondary" href="/admin/locations">Registration windows</Link>
        <Link className="button secondary" href="/admin/options">Registration options</Link>
        {admin.role === "super_admin" && <Link className="button secondary" href="/admin/imports">Import students</Link>}
        <Link className="button secondary" href="/admin/users">{admin.role === "super_admin" ? "Manage accounts" : "Change password"}</Link>
        <button type="button" disabled={busy} onClick={() => void send("/api/logout", {})}>Sign out</button></div>
      {canManageLocations && <form onSubmit={e => { e.preventDefault(); const form = e.currentTarget; const data = Object.fromEntries(new FormData(form));
        for (const field of ["opensAt", "closesAt"]) if (data[field]) data[field] = new Date(String(data[field])).toISOString();
        void send("/api/admin/locations", data).then(ok => { if (ok) form.reset(); }); }}>
        <label>Location name<input name="name" required maxLength={120} /></label>
        <label>Registration opens (optional, local time)<input type="datetime-local" name="opensAt" /></label>
        <label>Registration closes (optional, local time)<input type="datetime-local" name="closesAt" /></label>
        <button disabled={busy}>Create location</button>
      </form>}
      <h2>Locations</h2>
      {locations.length === 0 ? <p className="muted">No locations yet.</p> : <div className="list">{locations.map(location => <div className="row" key={location.id}>
        <div><strong>{location.name}</strong><br /><span className="muted">{location._count.students} registrations · {location.active ? "Active" : "Inactive"}</span><br />
          {location.opensAt && <span>Opens: {new Date(location.opensAt).toLocaleString()}<br /></span>}
          {location.closesAt && <span>Closes: {new Date(location.closesAt).toLocaleString()}<br /></span>}
          <a href={`/register/${location.key}`}>/register/{location.key}</a></div>
        <div className="actions"><button type="button" onClick={() => void navigator.clipboard.writeText(`${window.location.origin}/register/${location.key}`).catch(() => setError("Could not copy the link. Copy it from the page instead."))}>Copy link</button>
          {canManageLocations && location.active && <button type="button" disabled={busy} onClick={() => void send(`/api/admin/locations/${location.id}/deactivate`, {})}>Deactivate</button>}</div>
      </div>)}</div>}
    </>}
  </div>;
}
