"use client";
import { useCallback, useEffect, useState } from "react";

type Location = { id: string; key: string; name: string; active: boolean; _count: { students: number } };
export default function Admin() {
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const r = await fetch("/api/admin/locations");
    if (r.ok) setLocations(await r.json());
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function send(path: string, values: object) {
    setBusy(true); setError("");
    try {
      const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      const result = await r.json();
      if (!r.ok) throw new Error(result.message);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to connect."); }
    finally { setBusy(false); }
  }
  return <div className="form-wrap"><p className="eyebrow">Administration</p><h1>{locations ? "Registration locations" : "Admin sign in"}</h1>
    {error && <p className="notice error" role="alert">{error}</p>}
    {!locations ? <form onSubmit={e => { e.preventDefault(); void send("/api/admin/login", Object.fromEntries(new FormData(e.currentTarget))); }}>
      <label>Administrator password<input name="password" type="password" required autoComplete="current-password" /></label><button disabled={busy}>Sign in</button>
    </form> : <>
      <p className="muted">Create a unique link for each registration location.</p>
      <form onSubmit={e => { e.preventDefault(); const form = e.currentTarget; void send("/api/admin/locations", Object.fromEntries(new FormData(form))).then(() => form.reset()); }}>
        <label>Location name<input name="name" required maxLength={120} /></label><button disabled={busy}>Create location</button>
      </form>
      <h2>Locations</h2>
      {locations.length === 0 ? <p className="muted">No locations yet.</p> : <div className="list">{locations.map(location => <div className="row" key={location.id}>
        <div><strong>{location.name}</strong><br /><span className="muted">{location._count.students} registrations · {location.active ? "Active" : "Inactive"}</span><br />
          <a href={`/register/${location.key}`}>/register/{location.key}</a></div>
        <div className="actions"><button type="button" onClick={() => void navigator.clipboard.writeText(`${window.location.origin}/register/${location.key}`)}>Copy link</button>
          {location.active && <button type="button" disabled={busy} onClick={() => void send(`/api/admin/locations/${location.id}/deactivate`, {})}>Deactivate</button>}</div>
      </div>)}</div>}
    </>}
  </div>;
}
