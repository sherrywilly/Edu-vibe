"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Location = { id: string; key: string; name: string; active: boolean; opensAt: string | null; closesAt: string | null; _count: { students: number } };
export default function Admin() {
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/locations");
      if (r.ok) setLocations(await r.json());
      else if (r.status !== 401) throw new Error("Unable to load locations.");
    } catch { setError("Unable to load locations. Check your connection and try again."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function send(path: string, values: object) {
    setBusy(true); setError("");
    try {
      const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      const result = await r.json();
      if (!r.ok) throw new Error(result.message);
      await load();
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to connect."); return false; }
    finally { setBusy(false); }
  }
  return <div className="form-wrap"><p className="eyebrow">Administration</p><h1>{locations ? "Registration locations" : "Admin sign in"}</h1>
    {error && <p className="notice error" role="alert">{error}</p>}
    {loading ? <p>Loading…</p> : !locations ? <form onSubmit={e => { e.preventDefault(); void send("/api/admin/login", Object.fromEntries(new FormData(e.currentTarget))); }}>
      <label>Administrator password<input name="password" type="password" required autoComplete="current-password" /></label><button disabled={busy}>Sign in</button>
    </form> : <>
      <p className="muted">Create a unique link for each registration location.</p>
      <div className="actions"><Link className="button secondary" href="/admin/exams">Manage exams</Link><Link className="button secondary" href="/admin/students">View students</Link>
        <button type="button" disabled={busy} onClick={() => void send("/api/logout", {}).then(ok => { if (ok) { setLocations(null); } })}>Sign out</button></div>
      <form onSubmit={e => { e.preventDefault(); const form = e.currentTarget; const data = Object.fromEntries(new FormData(form));
        for (const field of ["opensAt", "closesAt"]) if (data[field]) data[field] = new Date(String(data[field])).toISOString();
        void send("/api/admin/locations", data).then(ok => { if (ok) form.reset(); }); }}>
        <label>Location name<input name="name" required maxLength={120} /></label>
        <label>Registration opens (optional, local time)<input type="datetime-local" name="opensAt" /></label>
        <label>Registration closes (optional, local time)<input type="datetime-local" name="closesAt" /></label>
        <button disabled={busy}>Create location</button>
      </form>
      <h2>Locations</h2>
      {locations.length === 0 ? <p className="muted">No locations yet.</p> : <div className="list">{locations.map(location => <div className="row" key={location.id}>
        <div><strong>{location.name}</strong><br /><span className="muted">{location._count.students} registrations · {location.active ? "Active" : "Inactive"}</span><br />
          {location.opensAt && <span>Opens: {new Date(location.opensAt).toLocaleString()}<br /></span>}
          {location.closesAt && <span>Closes: {new Date(location.closesAt).toLocaleString()}<br /></span>}
          <a href={`/register/${location.key}`}>/register/{location.key}</a></div>
        <div className="actions"><button type="button" onClick={() => void navigator.clipboard.writeText(`${window.location.origin}/register/${location.key}`).catch(() => setError("Could not copy the link. Copy it from the page instead."))}>Copy link</button>
          {location.active && <button type="button" disabled={busy} onClick={() => void send(`/api/admin/locations/${location.id}/deactivate`, {})}>Deactivate</button>}</div>
      </div>)}</div>}
    </>}
  </div>;
}
