"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type Row = { row: number; prompt: string; options: string[]; correctOption: string; errors: string[] };
type Preview = { valid: boolean; rows: Row[] };

async function post<T>(path: string, body: object): Promise<T> {
  const response = await fetch(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(typeof data?.message === "string" ? data.message : "Request failed.") as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return data as T;
}

export default function QuestionImports() {
  const [role, setRole] = useState<string | null>(null);
  const [csv, setCsv] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [valid, setValid] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [title, setTitle] = useState("");
  const [duration, setDuration] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const fileVersion = useRef(0);
  const creating = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/me", { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("Please sign in as an exam administrator.");
      const admin = await response.json();
      setRole(admin.role);
    }).catch(() => { if (!controller.signal.aborted) setError("Unable to load your account. Please sign in again."); });
    return () => controller.abort();
  }, []);

  function updateRow(index: number, patch: Partial<Row>) {
    setRows(current => current?.map((row, i) => i === index ? { ...row, ...patch, errors: [] } : row) ?? null);
    setValid(false); setReviewed(false); setError("");
  }

  async function preview(corrected: boolean) {
    setBusy(true); setError(""); setValid(false); setReviewed(false);
    try {
      const payload = corrected ? { rows: rows?.map(({ row, prompt, options, correctOption }) => ({ row, prompt, options, correctOption })) } : { csv };
      const response = await post<Preview>("/api/admin/question-imports/preview", payload);
      setRows(response.rows); setValid(response.valid);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to validate questions."); }
    finally { setBusy(false); }
  }

  async function create() {
    if (!rows || !valid || !reviewed || busy || result || uncertain || creating.current) return;
    creating.current = true;
    if (!window.confirm("Create this exam with the reviewed questions and correct answers?")) { creating.current = false; return; }
    setBusy(true); setError("");
    const questions = rows.map(row => {
      const options = [...row.options];
      while (options.length && !options[options.length - 1].trim()) options.pop();
      return { prompt: row.prompt, options, correctOption: Number(row.correctOption.trim()) - 1 };
    });
    try {
      const exam = await post<{ id: string }>("/api/admin/exams", { title, durationMinutes: Number(duration), questions });
      setResult(`Exam created (ID: ${exam.id}). Add a schedule on the exam management page.`);
    } catch (e) {
      const status = (e as Error & { status?: number }).status;
      if (!status || status >= 500) {
        setUncertain(true);
        setError("Creation may have succeeded but its response was lost. Check the exam list before attempting another import.");
      } else setError(e instanceof Error ? e.message : "Unable to create exam.");
    } finally { creating.current = false; setBusy(false); }
  }

  const canManage = role === "super_admin" || role === "exam_manager";
  const locked = busy || !!result || uncertain;
  return <div className="form-wrap">
    <p className="eyebrow">Administration</p><h1>Import exam questions</h1>
    <p><Link href="/admin/exams">← Manage exams</Link></p>
    {error && <p className="notice error" role="alert">{error}</p>}
    {result && <p className="notice" role="status">{result}</p>}
    {role && !canManage && <p>Only exam managers and super administrators can import questions.</p>}
    {canManage && <>
      <p>Choose a CSV of up to 32 KiB and 500 questions. Use headers <code>prompt,option1,option2,...,correctOption</code> with 2–10 consecutively numbered option columns. Correct option is the explicit 1-based choice number. Extra trailing options may be blank.</p>
      <label>CSV file<input type="file" accept=".csv,text/csv" disabled={locked} onChange={async event => {
        const version = ++fileVersion.current;
        const file = event.target.files?.[0];
        setCsv(""); setRows(null); setValid(false); setReviewed(false); setError("");
        if (!file) return;
        if (file.size > 32768) { setError("CSV must be at most 32 KiB."); return; }
        setBusy(true);
        try { const text = await file.text(); if (version === fileVersion.current) setCsv(text); }
        catch { if (version === fileVersion.current) setError("Unable to read the file."); }
        finally { if (version === fileVersion.current) setBusy(false); }
      }} /></label>
      <button type="button" disabled={locked || !csv} onClick={() => void preview(false)}>Preview CSV</button>
      {rows && <>
        <h2>Review and correct every question</h2>
        <p>Record numbers count CSV records including the header, not physical lines. Corrections must be validated again before confirmation.</p>
        {rows.map((row, index) => <fieldset className="card" key={row.row} disabled={locked}>
          <legend>Record {row.row}</legend>
          <label>Prompt<textarea value={row.prompt} onChange={event => updateRow(index, { prompt: event.target.value })} /></label>
          {row.options.map((option, i) => <label key={i}>Option {i + 1}<input value={option} onChange={event => updateRow(index, { options: row.options.map((value, j) => i === j ? event.target.value : value) })} /></label>)}
          <label>Correct option number<input value={row.correctOption} inputMode="numeric" onChange={event => updateRow(index, { correctOption: event.target.value })} /></label>
          {row.errors.map((message, i) => <p className="error" key={i}>{message}</p>)}
        </fieldset>)}
        <button type="button" disabled={locked} onClick={() => void preview(true)}>Validate corrections</button>
        <p role="status">{valid ? "All questions validated. Review the content and answers before creating the exam." : "Validation required; correct any errors and validate again."}</p>
        <form onSubmit={event => { event.preventDefault(); void create(); }}>
          <label>Exam title<input value={title} onChange={event => { setTitle(event.target.value); setReviewed(false); }} maxLength={200} required disabled={locked} /></label>
          <label>Time limit in minutes<input type="number" min="1" max="10080" step="1" value={duration} onChange={event => { setDuration(event.target.value); setReviewed(false); }} required disabled={locked} /></label>
          <label><input type="checkbox" checked={reviewed} disabled={locked || !valid} onChange={event => setReviewed(event.target.checked)} /> I reviewed every question and correct answer.</label>
          <button disabled={locked || !valid || !reviewed}>Create exam</button>
        </form>
      </>}
    </>}
  </div>;
}
