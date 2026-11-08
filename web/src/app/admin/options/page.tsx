"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Option = { id: string; kind: string; name: string; active: boolean };
const kinds = [
  ["school", "Schools"], ["district", "Districts"], ["className", "Classes"],
  ["medium", "Mediums"], ["syllabus", "Syllabuses"],
] as const;

function OptionEditor({ item, save, busy }: { item: Option; save: (id: string, value: Record<string, unknown>) => void; busy: boolean }) {
  const [name, setName] = useState(item.name);
  useEffect(() => setName(item.name), [item.name]);
  return <form className="card" onSubmit={event => { event.preventDefault(); save(item.id, { name }); }}>
    <label>Name<input value={name} onChange={event => setName(event.target.value)} required maxLength={120} /></label>
    <p>{item.active ? "Active" : "Inactive"}</p>
    <div className="actions"><button disabled={busy || name.trim() === item.name}>Save name</button>
      <button type="button" disabled={busy} onClick={() => save(item.id, { active: !item.active })}>{item.active ? "Deactivate" : "Activate"}</button></div>
  </form>;
}

export default function OptionsPage() {
  const [items, setItems] = useState<Option[]>([]);
  const [kind, setKind] = useState<string>("school");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [canEdit, setCanEdit] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [response, session] = await Promise.all([
        fetch("/api/admin/options", { signal }),
        fetch("/api/admin/me", { signal }),
      ]);
      if (!response.ok) throw new Error(response.status === 401 ? "Please sign in as an administrator." : "Unable to load options.");
      if (!session.ok) throw new Error(session.status === 401 ? "Please sign in as an administrator." : "Unable to check your session.");
      const account = await session.json();
      setCanEdit(account.role === "super_admin" || account.role === "exam_manager");
      setItems(await response.json());
    } catch (e) { if (!signal?.aborted) setError(e instanceof Error ? e.message : "Unable to load options."); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

  async function change(path: string, value: Record<string, unknown>) {
    setBusy(true); setError("");
    try {
      const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
      const data = await response.json();
      if (!response.ok) throw new Error(response.status === 403 ? "You do not have permission to change options." : data.message || "Unable to save option.");
      setName("");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save option."); }
    finally { setBusy(false); }
  }

  return <div className="form-wrap"><p className="eyebrow">Administration</p><h1>Registration options</h1>
    <Link href="/admin">← Back to administration</Link>
    <p className="muted">Deactivated options cannot be selected in new registrations. Existing registrations retain their recorded values.</p>
    {error && <p className="notice error" role="alert">{error}</p>}
    {loading ? <p>Loading options…</p> : <>
      {canEdit && <form onSubmit={event => { event.preventDefault(); void change("/api/admin/options", { kind, name }); }}>
        <label>Option type<select value={kind} onChange={event => setKind(event.target.value)}>{kinds.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>New option<input value={name} onChange={event => setName(event.target.value)} required maxLength={120} /></label>
        <button disabled={busy}>Add option</button>
      </form>}
      {kinds.map(([value, label]) => <section key={value}><h2>{label}</h2>
        {items.filter(item => item.kind === value).length === 0 ? <p>No options configured.</p> :
          <div className="list">{items.filter(item => item.kind === value).map(item => canEdit ?
            <OptionEditor key={item.id} item={item} busy={busy} save={(id, data) => void change(`/api/admin/options/${encodeURIComponent(id)}`, data)} /> :
            <article className="card" key={item.id}>{item.name} · {item.active ? "Active" : "Inactive"}</article>)}</div>}
      </section>)}
    </>}
  </div>;
}
