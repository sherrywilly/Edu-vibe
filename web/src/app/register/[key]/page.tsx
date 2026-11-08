"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import WhatsAppInvitation from "../../components/whatsapp-invitation";

type Option = { id: string; kind: string; name: string };
type Registration = { registrationId: string; location: { name: string; whatsappGroupUrl: string | null } };

export default function Register({ params }: { params: Promise<{ key: string }> }) {
  const { key } = use(params);
  const [location, setLocation] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [same, setSame] = useState(false);
  const [parent, setParent] = useState("");
  const [success, setSuccess] = useState<Registration | null>(null);
  const [options, setOptions] = useState<Option[]>([]);
  const [school, setSchool] = useState("");
  const [schoolSearch, setSchoolSearch] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetch(`/api/locations/${encodeURIComponent(key)}`, { signal: controller.signal }),
      fetch("/api/registration-options", { signal: controller.signal }),
    ]).then(async ([locationResponse, optionsResponse]) => {
      const data = await locationResponse.json();
      if (!locationResponse.ok) throw new Error(data.message);
      if (!optionsResponse.ok) throw new Error("Unable to load registration options.");
      const available = await optionsResponse.json();
      setOptions(available);
      setLocation(data.name);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message || "Unable to load this link. Check your connection."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
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
      setSuccess(result);
    } catch (e) { setError(e instanceof Error ? e.message : "Something went wrong."); }
    finally { setBusy(false); }
  }

  return <div className="form-wrap"><p className="eyebrow">Scholarship registration</p><h1>Let’s get started.</h1>
    {loading ? <p>Loading registration link…</p> : success ? <>
      <div className="notice" role="status"><h2>Registration successful!</h2><p>Your registration ID is <strong>{success.registrationId}</strong>. Please save it; you may need it to sign in.</p></div>
      <WhatsAppInvitation location={success.location} />
      <div className="actions"><Link className="button secondary" href="/dashboard">Continue to dashboard</Link></div>
    </> : location ? <>
      <p className="muted">Registering through <strong>{location}</strong>. Your residential locality is recorded separately.</p>
      {["district", "className", "medium", "syllabus"].some(kind => !options.some(item => item.kind === kind)) && <p className="notice error" role="alert">Registration options are not yet configured. Please contact the administrator.</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      <form onSubmit={submit}>
        <label>Student name<input name="name" required maxLength={120} autoComplete="name" /></label>
        <label>Date of birth (DD/MM/YYYY)<input name="dob" required placeholder="DD/MM/YYYY" pattern="\d{2}/\d{2}/\d{4}" inputMode="numeric" /></label>
        <fieldset><legend>School</legend>
          <label>Search schools<input value={schoolSearch} onChange={e => setSchoolSearch(e.target.value)} maxLength={120} /></label>
          {options.filter(item => item.kind === "school" && (item.name.toLowerCase().includes(schoolSearch.trim().toLowerCase()) || school === item.name)).map(item =>
            <label className="check" key={item.id}><input type="radio" name="school" value={item.name} checked={school === item.name} onChange={() => setSchool(item.name)} required />{item.name}</label>)}
          <label className="check"><input type="radio" name="school" value="__other__" checked={school === "__other__"} onChange={() => setSchool("__other__")} required />Other school</label>
          {school === "__other__" && <label>School name<input name="schoolOther" required maxLength={120} /></label>}
        </fieldset>
        {([["district", "School district"], ["className", "Class"], ["medium", "Medium of instruction"], ["syllabus", "Syllabus / education board"]] as const).map(([kind, label]) =>
          <label key={kind}>{label}<select name={kind} required defaultValue=""><option value="" disabled>Select {label.toLowerCase()}</option>{options.filter(item => item.kind === kind).map(item => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label>)}
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
