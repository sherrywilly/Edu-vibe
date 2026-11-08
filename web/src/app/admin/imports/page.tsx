"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type Location = { id: string; name: string };
type Preview = { digest: string; valid: boolean; rows: { row: number; name: string; errors: string[]; duplicate: boolean }[] };

export default function Imports() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState("");
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const fileVersion = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/locations", { signal: controller.signal }).then(r => {
      if (!r.ok) throw new Error("Unable to load locations. Sign in as an administrator.");
      return r.json();
    }).then(setLocations).catch(() => { if (!controller.signal.aborted) setError("Unable to load locations. Sign in as an administrator."); });
    return () => controller.abort();
  }, []);

  async function send(confirm: boolean) {
    setBusy(true); setError(""); setMessage("");
    try {
      let payload: object = { locationId, csv };
      if (confirm && preview) {
        const storageKey = `student-import:${preview.digest}`;
        let idempotencyKey = sessionStorage.getItem(storageKey);
        if (!idempotencyKey) {
          idempotencyKey = crypto.randomUUID();
          sessionStorage.setItem(storageKey, idempotencyKey);
        }
        payload = { ...payload, digest: preview.digest, idempotencyKey };
      }
      const response = await fetch(`/api/admin/imports/${confirm ? "confirm" : "preview"}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.message === "string" ? result.message : "Import request failed.");
      if (confirm) setMessage(`${result.imported} students imported${result.replayed ? " (already confirmed)" : ""}.`);
      else { setPreview(result); setCanRetry(!!sessionStorage.getItem(`student-import:${result.digest}`)); }
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to connect."); }
    finally { setBusy(false); }
  }

  return <div className="form-wrap">
    <p className="eyebrow">Administration</p><h1>Import students</h1>
    <Link href="/admin">← Back to administration</Link>
    <p>Super administrators can preview and import up to 200 rows (64 KiB). Select the students&apos; registration location.</p>
    <p>CSV headers, in order: <code>name,dob,school,district,className,medium,syllabus,parentPhone,whatsappPhone,locality,guardianConsentAt,guardianConsentVersion,whatsappConsentAt,whatsappConsentVersion</code></p>
    <p>Use DD/MM/YYYY for date of birth. Consent timestamps must be recorded timestamps with a timezone (for example 2024-01-01T10:00:00Z), not the import time. Guardian consent and its version are required; WhatsApp consent timestamp and version must both be present or both blank. Do not import without evidence of consent.</p>
    <label>Location<select value={locationId} disabled={busy} onChange={e => { setLocationId(e.target.value); setPreview(null); setMessage(""); }}>
      <option value="">Select a location</option>{locations.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}
    </select></label>
    <label>CSV file<input type="file" accept=".csv,text/csv" disabled={busy} onChange={async e => {
      const version = ++fileVersion.current;
      setPreview(null); setCsv(""); setMessage(""); setError("");
      const file = e.target.files?.[0];
      if (!file) return;
      if (file.size > 65536) { setError("CSV must be at most 64 KiB."); return; }
      try { const text = await file.text(); if (version === fileVersion.current) setCsv(text); }
      catch { if (version === fileVersion.current) setError("Unable to read the file."); }
    }} /></label>
    <button type="button" disabled={busy || !csv || !locationId} onClick={() => void send(false)}>Preview and validate</button>
    {error && <p className="notice error" role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {preview && <>
      <h2>Preview</h2><p>Rows flagged as possible duplicates share a parent phone and date of birth with another row or existing student. Resolve them before importing; this match does not prove they are duplicates.</p>
      <div className="list">{preview.rows.map(row => <div className="card" key={row.row}>
        <strong>Row {row.row}: {row.name || "(no name)"}</strong>
        {row.duplicate && <p>Possible duplicate</p>}
        {row.errors.map((error, i) => <p key={i}>{error}</p>)}
        {!row.duplicate && !row.errors.length && <p>Ready</p>}
      </div>)}</div>
      <button type="button" disabled={busy || (!preview.valid && !canRetry) || !!message} onClick={() => void send(true)}>{canRetry && !preview.valid ? "Retry previous confirmation" : "Confirm import"}</button>
      <p>If confirmation fails or its response is lost, retry without changing the file or location. Do not close this tab until confirmation succeeds.</p>
    </>}
  </div>;
}
