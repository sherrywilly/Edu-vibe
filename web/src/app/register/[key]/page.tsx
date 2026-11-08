"use client";

import { use, useEffect, useState } from "react";

export default function Register({ params }: { params: Promise<{ key: string }> }) {
  const { key } = use(params);
  const [location, setLocation] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [same, setSame] = useState(false);
  const [parent, setParent] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    fetch(`/api/locations/${encodeURIComponent(key)}`).then(async r => {
      const data = await r.json();
      if (!r.ok) throw new Error(data.message);
      setLocation(data.name);
    }).catch(e => setError(e.message || "Unable to load this link. Check your connection.")).finally(() => setLoading(false));
  }, [key]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    const data = new FormData(event.currentTarget);
    const values = Object.fromEntries(data.entries());
    try {
      const r = await fetch(`/api/register/${encodeURIComponent(key)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, whatsappPhone: same ? parent : values.whatsappPhone, guardianConsent: data.has("guardianConsent"), whatsappConsent: data.has("whatsappConsent") }),
      });
      const result = await r.json();
      if (!r.ok) throw new Error(result.message);
      setSuccess(result.registrationId);
    } catch (e) { setError(e instanceof Error ? e.message : "Something went wrong."); }
    finally { setBusy(false); }
  }

  return <div className="form-wrap"><p className="eyebrow">Scholarship registration</p><h1>Let’s get started.</h1>
    {loading ? <p>Loading registration link…</p> : success ? <div className="notice" role="status"><h2>Registration received!</h2><p>Your registration ID is <strong>{success}</strong>. Please save it; you may need it to sign in.</p></div> : location ? <>
      <p className="muted">Registering through <strong>{location}</strong>. Your residential locality is recorded separately.</p>
      {error && <p className="notice error" role="alert">{error}</p>}
      <form onSubmit={submit}>
        <label>Student name<input name="name" required maxLength={120} autoComplete="name" /></label>
        <label>Date of birth (DD/MM/YYYY)<input name="dob" required placeholder="DD/MM/YYYY" pattern="\d{2}/\d{2}/\d{4}" inputMode="numeric" /></label>
        <label>School name<input name="school" required maxLength={120} /></label>
        <label>School district<input name="district" required maxLength={120} /></label>
        <label>Class<select name="className" required defaultValue="Standard 4"><option>Standard 4</option></select></label>
        <label>Medium of instruction<input name="medium" required maxLength={120} /></label>
        <label>Syllabus / education board<input name="syllabus" required maxLength={120} /></label>
        <label>Parent’s mobile number<input name="parentPhone" value={parent} onChange={e => setParent(e.target.value)} required placeholder="+91" type="tel" /></label>
        <label className="check"><input type="checkbox" checked={same} onChange={e => setSame(e.target.checked)} />Same as parent’s mobile number</label>
        {!same && <label>WhatsApp contact number<input name="whatsappPhone" required placeholder="+91" type="tel" /></label>}
        <label>Student’s place / locality<input name="locality" required maxLength={120} /></label>
        <label className="check"><input name="guardianConsent" type="checkbox" required />I am the guardian and consent to the collection and use of these details for registration and the scholarship examination (version 1).</label>
        <label className="check"><input name="whatsappConsent" type="checkbox" />I agree to receive scholarship-related messages on WhatsApp (optional, version 1).</label>
        <button disabled={busy}>{busy ? "Submitting…" : "Submit registration"}</button>
      </form>
    </> : <p className="notice error" role="alert">{error || "This link is unavailable."}</p>}
  </div>;
}
