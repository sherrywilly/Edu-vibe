"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type QuestionDraft = { prompt: string; options: string[]; correctOption: number };
type Schedule = { locationId: string; opensAt: string; closesAt: string; location?: { name: string } };
type Exam = { id: string; title: string; durationMinutes: number; resultsPublished: boolean; schedules: Schedule[] };
type Location = { id: string; name: string; active: boolean };
const newQuestion = (): QuestionDraft => ({ prompt: "", options: ["", "", "", ""], correctOption: 0 });

async function request<T>(path: string, body?: object, method = "POST"): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.message === "string" ? data.message : "Something went wrong. Please try again.");
  return data as T;
}

export default function AdminExams() {
  const [exams, setExams] = useState<Exam[] | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [questions, setQuestions] = useState<QuestionDraft[]>([newQuestion()]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const [examData, locationData] = await Promise.all([
      request<Exam[]>("/api/admin/exams"), request<Location[]>("/api/admin/locations"),
    ]);
    setExams(examData); setLocations(locationData);
  }, []);
  useEffect(() => { void load().catch(e => setError(e instanceof Error ? e.message : "Unable to load exams.")); }, [load]);
  function updateQuestion(index: number, patch: Partial<QuestionDraft>) {
    setQuestions(current => current.map((question, i) => i === index ? { ...question, ...patch } : question));
  }
  async function run(action: () => Promise<void>, success: string) {
    setBusy(true); setError(""); setMessage("");
    try { await action(); await load(); setMessage(success); }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to connect."); }
    finally { setBusy(false); }
  }
  return <div className="form-wrap">
    <p className="eyebrow">Administration</p><h1>Manage exams</h1>
    <p><Link href="/admin">← Administration</Link></p>
    {error && <p className="notice error" role="alert">{error}</p>}
    {message && <p className="notice" role="status">{message}</p>}
    {exams === null ? <p>{error ? <>Unable to load exams. <Link href="/admin">Sign in as an administrator</Link> and try again.</> : "Loading exams…"}</p> : <>
      <section className="card">
        <h2>Create an exam</h2>
        <p>Each question has four choices and one correct answer. Check your questions before creating the exam.</p>
        <form onSubmit={event => {
          event.preventDefault();
          if (!window.confirm("Create this exam with these questions and correct answers? Check them carefully first.")) return;
          const form = event.currentTarget;
          const values = new FormData(form);
          void run(async () => {
            await request("/api/admin/exams", { title: values.get("title"), durationMinutes: Number(values.get("durationMinutes")), questions });
            form.reset(); setQuestions([newQuestion()]);
          }, "Exam created. Add a schedule below.");
        }}>
          <label>Exam title<input name="title" required maxLength={120} /></label>
          <label>Time limit in minutes<input name="durationMinutes" type="number" min="1" max="10080" required /></label>
          {questions.map((question, index) => <fieldset className="card" key={index}>
            <legend>Question {index + 1}</legend>
            <label>Question<input value={question.prompt} maxLength={5000} required onChange={e => updateQuestion(index, { prompt: e.target.value })} /></label>
            {question.options.map((option, optionIndex) => <label key={optionIndex}>Choice {optionIndex + 1}
              <input value={option} maxLength={1000} required onChange={e => updateQuestion(index, { options: question.options.map((value, i) => i === optionIndex ? e.target.value : value) })} />
            </label>)}
            <label>Correct choice<select value={question.correctOption} onChange={e => updateQuestion(index, { correctOption: Number(e.target.value) })}>
              {question.options.map((_, i) => <option value={i} key={i}>Choice {i + 1}</option>)}
            </select></label>
            {questions.length > 1 && <button type="button" onClick={() => setQuestions(current => current.filter((_, i) => i !== index))}>Remove question {index + 1}</button>}
          </fieldset>)}
          <button type="button" disabled={questions.length >= 500} onClick={() => setQuestions(current => [...current, newQuestion()])}>Add a question</button>
          <button disabled={busy}>{busy ? "Working…" : "Create exam"}</button>
        </form>
      </section>
      <section><h2>Exams and schedules</h2>
        {exams.length === 0 ? <p>No exams yet.</p> : <div className="list">{exams.map(exam => <div className="card" key={exam.id}>
          <h3>{exam.title}</h3><p>{exam.durationMinutes} minutes · Results {exam.resultsPublished ? "published" : "not published"}</p>
          {exam.schedules.length > 0 && <ul>{exam.schedules.map(schedule => <li key={schedule.locationId}>{schedule.location?.name || locations.find(l => l.id === schedule.locationId)?.name || "Location"}: {new Date(schedule.opensAt).toLocaleString()} – {new Date(schedule.closesAt).toLocaleString()}</li>)}</ul>}
          <p>Each location can be scheduled once per exam.</p><form onSubmit={event => {
            event.preventDefault(); const values = new FormData(event.currentTarget);
            const opensAt = new Date(String(values.get("opensAt"))); const closesAt = new Date(String(values.get("closesAt")));
            if (closesAt <= opensAt) { setError("Closing time must be after opening time."); return; }
            void run(async () => { await request(`/api/admin/exams/${exam.id}/schedules`, { locationId: values.get("locationId"), opensAt: opensAt.toISOString(), closesAt: closesAt.toISOString() }); }, "Schedule saved.");
          }}>
            <label>Location<select name="locationId" required defaultValue=""><option value="" disabled>Choose a location</option>{locations.filter(location => location.active).map(location => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>
            <label>Opens (your local time)<input type="datetime-local" name="opensAt" required /></label>
            <label>Closes (your local time)<input type="datetime-local" name="closesAt" required /></label>
            <button disabled={busy || !locations.some(location => location.active)}>Add schedule</button>
          </form>
          {!exam.resultsPublished && <div className="actions"><button type="button" disabled={busy} onClick={() => {
            if (window.confirm("Publish results for this exam? Students will be able to see their scores.")) void run(async () => { await request(`/api/admin/exams/${exam.id}/results`, { published: true }, "PATCH"); }, "Results published.");
          }}>Publish results</button></div>}
        </div>)}</div>}
      </section>
    </>}
  </div>;
}
