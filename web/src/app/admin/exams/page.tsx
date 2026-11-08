"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type QuestionDraft = { prompt: string; options: string[]; correctOption: number };
type Schedule = { locationId: string; opensAt: string; closesAt: string; location?: { name: string } };
type Exam = { id: string; title: string; durationMinutes: number; resultsPublished: boolean; schedules: Schedule[] };
type Location = { id: string; name: string; active: boolean };
type AdminAccount = { role: "super_admin" | "exam_manager" | "reviewer" };
const newQuestion = (): QuestionDraft => ({ prompt: "", options: ["", "", "", ""], correctOption: 0 });

class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function request<T>(path: string, body?: object, method = "POST"): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, body === undefined ? undefined : {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  } catch { throw new Error("Unable to connect. Check your connection and try again."); }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const fallback = response.status === 401 ? "Please sign in again." :
      response.status === 403 ? "You do not have permission for this action." : "Something went wrong. Please try again.";
    const detail = data && typeof data === "object" ? data.message : undefined;
    const message = typeof detail === "string" && detail ? detail :
      Array.isArray(detail) && detail.every(item => typeof item === "string") && detail.length ? detail.join(" ") : fallback;
    throw new RequestError(message, response.status);
  }
  return data as T;
}

export default function AdminExams() {
  const [admin, setAdmin] = useState<AdminAccount | null>(null);
  const [exams, setExams] = useState<Exam[] | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [questions, setQuestions] = useState<QuestionDraft[]>([newQuestion()]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    const current = await request<AdminAccount>("/api/admin/me");
    const [examData, locationData] = await Promise.all([
      request<Exam[]>("/api/admin/exams"), request<Location[]>("/api/admin/locations"),
    ]);
    setAdmin(current); setExams(examData); setLocations(locationData);
  }, []);
  const initialLoad = useCallback(async () => {
    setLoading(true); setError("");
    try { await load(); }
    catch (e) {
      setAdmin(null); setExams(null);
      setError(e instanceof Error ? e.message : "Unable to load exams.");
    } finally { setLoading(false); }
  }, [load]);
  useEffect(() => { void initialLoad(); }, [initialLoad]);
  function updateQuestion(index: number, patch: Partial<QuestionDraft>) {
    setQuestions(current => current.map((question, i) => i === index ? { ...question, ...patch } : question));
  }
  async function run(action: () => Promise<void>, success: string) {
    setBusy(true); setError(""); setMessage("");
    try {
      await action();
      setMessage(success);
      try { await load(); }
      catch (e) {
        setAdmin(null); setExams(null);
        setError(`The change was saved, but the page could not be refreshed. ${e instanceof Error ? e.message : "Please try again."}`);
      }
    } catch (e) {
      if (e instanceof RequestError && (e.status === 401 || e.status === 403)) { setAdmin(null); setExams(null); }
      setError(e instanceof Error ? e.message : "Unable to connect.");
    }
    finally { setBusy(false); }
  }
  const canManage = admin?.role === "super_admin" || admin?.role === "exam_manager";
  return <div className="form-wrap">
    <p className="eyebrow">Administration</p><h1>Manage exams</h1>
    <p><Link href="/admin">← Administration</Link></p>
    {error && <p className="notice error" role="alert">{error}</p>}
    {message && <p className="notice" role="status">{message}</p>}
    {loading ? <p>Loading exams…</p> : exams === null || !admin ? <button type="button" onClick={() => void initialLoad()}>Try again</button> : <>
      {canManage && <section className="card">
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
      </section>}
      <section><h2>Exams and schedules</h2>
        {exams.length === 0 ? <p>No exams yet.</p> : <div className="list">{exams.map(exam => <div className="card" key={exam.id}>
          <h3>{exam.title}</h3><p>{exam.durationMinutes} minutes · Results {exam.resultsPublished ? "published" : "not published"}</p>
          {exam.schedules.length > 0 && <ul>{exam.schedules.map(schedule => <li key={schedule.locationId}>{schedule.location?.name || locations.find(l => l.id === schedule.locationId)?.name || "Location"}: {new Date(schedule.opensAt).toLocaleString()} – {new Date(schedule.closesAt).toLocaleString()}</li>)}</ul>}
          {canManage && <><p>Each location can be scheduled once per exam.</p><form onSubmit={event => {
            event.preventDefault(); const values = new FormData(event.currentTarget);
            const opensAt = new Date(String(values.get("opensAt"))); const closesAt = new Date(String(values.get("closesAt")));
            if (Number.isNaN(opensAt.getTime()) || Number.isNaN(closesAt.getTime()) || closesAt <= opensAt) {
              setMessage(""); setError("Enter valid times with the closing time after the opening time."); return;
            }
            void run(async () => { await request(`/api/admin/exams/${exam.id}/schedules`, { locationId: values.get("locationId"), opensAt: opensAt.toISOString(), closesAt: closesAt.toISOString() }); }, "Schedule saved.");
          }}>
            <label>Location<select name="locationId" required defaultValue=""><option value="" disabled>Choose a location</option>{locations.filter(location => location.active).map(location => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>
            <label>Opens (your local time)<input type="datetime-local" name="opensAt" required /></label>
            <label>Closes (your local time)<input type="datetime-local" name="closesAt" required /></label>
            <button disabled={busy || !locations.some(location => location.active)}>Add schedule</button>
          </form></>}
          {admin.role === "super_admin" && !exam.resultsPublished && <div className="actions"><button type="button" disabled={busy} onClick={() => {
            if (window.confirm("Publish results for this exam? Students will be able to see their scores.")) void run(async () => { await request(`/api/admin/exams/${exam.id}/results`, { published: true }, "PATCH"); }, "Results published.");
          }}>Publish results</button></div>}
        </div>)}</div>}
      </section>
    </>}
  </div>;
}
