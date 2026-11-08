"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Location = { id: string; name: string; key: string; active: boolean; opensAt: string | null; closesAt: string | null; whatsappGroupUrl: string | null; _count: { students: number } };
type Window = { opensAt: string | null; closesAt: string | null };
type History = { id: string; action: string; actor: string; createdAt: string; details: { before: Window; after: Window } | null };

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.message === "string" ? data.message : "Unable to complete the request.");
  return data as T;
}

function localInput(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}
function display(value: string | null) { return value ? new Date(value).toLocaleString() : "Not set"; }

function LocationCard({ location, reload, canEdit }: { location: Location; reload: () => Promise<void>; canEdit: boolean }) {
  const [opensAt, setOpensAt] = useState(() => localInput(location.opensAt));
  const [closesAt, setClosesAt] = useState(() => localInput(location.closesAt));
  const [groupUrl, setGroupUrl] = useState(location.whatsappGroupUrl ?? "");
  const [history, setHistory] = useState<History[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const historyPath = `/api/admin/locations/${encodeURIComponent(location.id)}/history`;
  useEffect(() => { setOpensAt(localInput(location.opensAt)); setClosesAt(localInput(location.closesAt)); }, [location.opensAt, location.closesAt]);
  useEffect(() => { setGroupUrl(location.whatsappGroupUrl ?? ""); }, [location.whatsappGroupUrl]);

  async function loadHistory() { setHistory(await request<History[]>(historyPath)); }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      const start = opensAt ? new Date(opensAt === localInput(location.opensAt) ? location.opensAt! : opensAt) : null;
      const end = closesAt ? new Date(closesAt === localInput(location.closesAt) ? location.closesAt! : closesAt) : null;
      if ((start && !Number.isFinite(start.getTime())) || (end && !Number.isFinite(end.getTime()))) throw new Error("Enter valid dates and times.");
      if (start && end && start >= end) throw new Error("Closing time must be after opening time.");
      await request(`/api/admin/locations/${encodeURIComponent(location.id)}/window`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          opensAt: opensAt === localInput(location.opensAt) ? location.opensAt : start?.toISOString() ?? null,
          closesAt: closesAt === localInput(location.closesAt) ? location.closesAt : end?.toISOString() ?? null,
          expected: { opensAt: location.opensAt, closesAt: location.closesAt },
        }),
      });
      await reload();
      setMessage("Registration window saved.");
      if (history !== null) {
        try { await loadHistory(); } catch { setError("Window saved, but history could not be refreshed."); }
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save."); }
    finally { setBusy(false); }
  }
  async function saveGroup(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      await request(`/api/admin/locations/${encodeURIComponent(location.id)}/whatsapp-group`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ whatsappGroupUrl: groupUrl.trim() || null }),
      });
      await reload();
      setMessage("WhatsApp group invitation saved.");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save invitation."); }
    finally { setBusy(false); }
  }
  return <section className="card">
    <h2>{location.name}</h2>
    <p>{location.active ? "Active" : "Inactive"} · {location._count.students} registrations · <Link href={`/register/${location.key}`}>Registration link</Link></p>
    <p>Opening and closing times are optional and shown in your local time. An unset boundary has no time limit.</p>
    {error && <p className="notice error" role="alert">{error}</p>}
    {message && <p className="notice" role="status">{message}</p>}
    {canEdit ? <form onSubmit={event => void save(event)}>
      <label>Registration opens (local time)<input type="datetime-local" step="0.001" value={opensAt} onChange={event => setOpensAt(event.target.value)} /></label>
      <label>Registration closes (local time)<input type="datetime-local" step="0.001" value={closesAt} onChange={event => setClosesAt(event.target.value)} /></label>
      <button disabled={busy}>{busy ? "Saving…" : "Save window"}</button>
    </form> : <p>Opens: {display(location.opensAt)}<br />Closes: {display(location.closesAt)}</p>}
    {canEdit ? <form onSubmit={event => void saveGroup(event)}>
      <label>WhatsApp group invitation URL (optional)<input type="url" value={groupUrl} onChange={event => setGroupUrl(event.target.value)} placeholder="https://chat.whatsapp.com/…" /></label>
      <p>Use an official WhatsApp group invite link. Leave blank to remove it.</p>
      <button disabled={busy}>{busy ? "Saving…" : "Save group invitation"}</button>
    </form> : <p>WhatsApp group invitation: {location.whatsappGroupUrl ? "Configured" : "Not configured"}</p>}
    <button type="button" disabled={busy} onClick={() => { setError(""); void loadHistory().catch(e => setError(e instanceof Error ? e.message : "Unable to load history.")); }}>Show latest history</button>
    {history && <div><h3>Location history (latest 100)</h3>{history.length === 0 ? <p>No history available.</p> : <ul>{history.map(entry => <li key={entry.id}>
      <strong>{entry.action}</strong> · {entry.actor} · {new Date(entry.createdAt).toLocaleString()}
      {entry.details?.before && entry.details.after && <div>Before: {display(entry.details.before.opensAt)} – {display(entry.details.before.closesAt)}<br />After: {display(entry.details.after.opensAt)} – {display(entry.details.after.closesAt)}</div>}
    </li>)}</ul>}</div>}
  </section>;
}

export default function LocationsPage() {
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [error, setError] = useState("");
  const [canEdit, setCanEdit] = useState(false);
  const reload = useCallback(async () => {
    const [data, admin] = await Promise.all([
      request<Location[]>("/api/admin/locations"),
      request<{ role: string }>("/api/admin/me"),
    ]);
    setLocations(data);
    setCanEdit(admin.role === "super_admin" || admin.role === "exam_manager");
    setError("");
  }, []);
  useEffect(() => { void reload().catch(e => setError(e instanceof Error ? e.message : "Unable to load locations.")); }, [reload]);
  return <div className="form-wrap">
    <p className="eyebrow">Administration</p><h1>Location windows</h1>
    <p><Link href="/admin">← Administration</Link></p>
    {error && <p className="notice error" role="alert">{error} <Link href="/admin">Sign in</Link> or retry.</p>}
    <button type="button" onClick={() => void reload().catch(e => setError(e instanceof Error ? e.message : "Unable to load locations."))}>Reload locations</button>
    {locations === null ? <p>Locations not loaded.</p> : locations.length === 0 ? <p>No locations yet. Create one from the administration page.</p> :
      locations.map(location => <LocationCard key={location.id} location={location} reload={reload} canEdit={canEdit} />)}
  </div>;
}
