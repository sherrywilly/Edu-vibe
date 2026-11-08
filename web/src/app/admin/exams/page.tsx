"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type QuestionDraft = { prompt: string; options: string[]; correctOption: number; subject: string; marks: string; negativeMarks: string };
type Schedule = { id: string; locationId: string; opensAt: string; closesAt: string; durationMinutes?: number; eligibilityType?: "location" | "school" | "district" | "students"; eligibilityValue?: string | null; cancelledAt?: string | null; selectedStudents?: { studentId: string }[] };
type Exam = { id: string; title: string; durationMinutes: number; resultsPublished: boolean; shuffleQuestions: boolean; shuffleOptions: boolean; schedules: Schedule[] };
type Location = { id: string; name: string; active: boolean };
type AdminAccount = { role: "super_admin" | "exam_manager" | "reviewer" };
const newQuestion = (): QuestionDraft => ({ prompt: "", options: ["", "", "", ""], correctOption: 0, subject: "", marks: "1", negativeMarks: "0" });

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

function localDateTime(value: string) {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 23);
}

function ScheduleForm({ exam, schedule, locations, busy, run, setError }: {
  exam: Exam; schedule?: Schedule; locations: Location[]; busy: boolean;
  run: (action: () => Promise<void>, success: string) => Promise<void>;
  setError: (message: string) => void;
}) {
  const [type, setType] = useState(schedule?.eligibilityType ?? "location");
  return <form onSubmit={event => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const opensAt = new Date(String(values.get("opensAt")));
    const closesAt = new Date(String(values.get("closesAt")));
    if (Number.isNaN(opensAt.getTime()) || Number.isNaN(closesAt.getTime()) || closesAt <= opensAt) {
      setError("Enter valid times with the closing time after the opening time."); return;
    }
    const studentIds = String(values.get("studentIds") ?? "").split(/[\n,]+/).map(id => id.trim()).filter(Boolean);
    if (type === "students" && (!studentIds.length || new Set(studentIds).size !== studentIds.length)) {
      setError("Enter unique student IDs."); return;
    }
    const payload = {
      locationId: values.get("locationId"), opensAt: opensAt.toISOString(), closesAt: closesAt.toISOString(),
      durationMinutes: Number(values.get("durationMinutes")), eligibilityType: type,
      ...((type === "school" || type === "district") ? { eligibilityValue: String(values.get("eligibilityValue")).trim() } : {}),
      ...(type === "students" ? { studentIds } : {}),
    };
    void run(async () => {
      await request(`/api/admin/exams/${exam.id}/schedules${schedule ? `/${schedule.id}` : ""}`, payload, schedule ? "PUT" : "POST");
    }, schedule ? "Schedule updated." : "Schedule saved.");
  }}>
    <label>Location<select name="locationId" required defaultValue={schedule?.locationId ?? ""}><option value="" disabled>Choose a location</option>{locations.filter(location => location.active || location.id === schedule?.locationId).map(location => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>
    <label>Opens (your local time)<input type="datetime-local" name="opensAt" step="0.001" required defaultValue={schedule ? localDateTime(schedule.opensAt) : undefined} /></label>
    <label>Closes (your local time)<input type="datetime-local" name="closesAt" step="0.001" required defaultValue={schedule ? localDateTime(schedule.closesAt) : undefined} /></label>
    <label>Duration in minutes<input type="number" name="durationMinutes" min="1" max="10080" step="1" required defaultValue={schedule?.durationMinutes ?? exam.durationMinutes} /></label>
    <label>Eligibility<select value={type} onChange={event => setType(event.target.value as typeof type)}><option value="location">Location</option><option value="school">School</option><option value="district">District</option><option value="students">Selected students</option></select></label>
    {(type === "school" || type === "district") && <label>{type === "school" ? "School" : "District"}<input name="eligibilityValue" required maxLength={200} defaultValue={schedule?.eligibilityValue ?? ""} /></label>}
    {type === "students" && <label>Student IDs (one per line or comma-separated)<textarea name="studentIds" required defaultValue={schedule?.selectedStudents?.map(student => student.studentId).join("\n") ?? ""} /></label>}
    <button disabled={busy || !locations.some(location => location.active || location.id === schedule?.locationId)}>{schedule ? "Update schedule" : "Add schedule"}</button>
  </form>;
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
        <p><Link href="/admin/question-imports">Import questions</Link></p>
        <p>Each question has four choices and one correct answer. Check your questions before creating the exam.</p>
        <form onSubmit={event => {
          event.preventDefault();
          const form = event.currentTarget;
          const values = new FormData(form);
          const scoredQuestions = questions.map(({ prompt, options, correctOption, subject, marks, negativeMarks }) => ({
            prompt, options, correctOption, subject: subject.trim(), marks: Number(marks), negativeMarks: Number(negativeMarks),
          }));
          const total = scoredQuestions.reduce((sum, question) => sum + question.marks, 0);
          const penalties = scoredQuestions.reduce((sum, question) => sum + question.negativeMarks, 0);
          const passingValue = String(values.get("passingScore") ?? "");
          const passingScore = passingValue === "" ? null : Number(passingValue);
          if (
            scoredQuestions.some(q => !q.subject || !Number.isInteger(q.marks) || q.marks < 1 || !Number.isInteger(q.negativeMarks) || q.negativeMarks < 0) ||
            total > 2147483647 || penalties > 2147483647 ||
            (passingScore !== null && (!Number.isInteger(passingScore) || passingScore < 0 || passingScore > total))
          ) {
            setMessage(""); setError("Enter valid scoring fields; passing score cannot exceed total marks."); return;
          }
          if (!window.confirm("Create this exam with these questions and correct answers? Check them carefully first.")) return;
          void run(async () => {
            const payload = {
              title: values.get("title"), durationMinutes: Number(values.get("durationMinutes")),
              questions: scoredQuestions, passingScore,
              shuffleQuestions: values.has("shuffleQuestions"),
              shuffleOptions: values.has("shuffleOptions"),
            };
            await request("/api/admin/exams", payload);
            form.reset(); setQuestions([newQuestion()]);
          }, "Exam created. Add a schedule below.");
        }}>
          <label>Exam title<input name="title" required maxLength={120} /></label>
          <label>Time limit in minutes<input name="durationMinutes" type="number" min="1" max="10080" required /></label>
          <label>Passing score (optional)<input name="passingScore" type="number" min="0" max="2147483647" step="1" /></label>
          <label><input name="shuffleQuestions" type="checkbox" /> Randomize question order per attempt</label>
          <label><input name="shuffleOptions" type="checkbox" /> Randomize answer choices per attempt</label>
          {questions.map((question, index) => <fieldset className="card" key={index}>
            <legend>Question {index + 1}</legend>
            <label>Subject<input value={question.subject} maxLength={200} required onChange={e => updateQuestion(index, { subject: e.target.value })} /></label>
            <label>Marks for a correct answer<input type="number" min="1" max="2147483647" step="1" required value={question.marks} onChange={e => updateQuestion(index, { marks: e.target.value })} /></label>
            <label>Marks deducted for a wrong answer<input type="number" min="0" max="2147483647" step="1" required value={question.negativeMarks} onChange={e => updateQuestion(index, { negativeMarks: e.target.value })} /></label>
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
      <section className="card">
        <h2>Focus event summaries</h2>
        <p>Search by attempt ID in <Link href="/admin/attempts">attempt monitoring</Link> to view a summary. Events are optional and informational, may be incomplete, and are not evidence of misconduct or grounds for score penalties.</p>
      </section>
      <section><h2>Exams and schedules</h2>
        {exams.length === 0 ? <p>No exams yet.</p> : <div className="list">{exams.map(exam => <div className="card" key={exam.id}>
          <h3>{exam.title}</h3><p>{exam.durationMinutes} minutes · Results {exam.resultsPublished ? "published" : "not published"}</p>
          <p>Question order: {exam.shuffleQuestions ? "randomized" : "original"} · Choice order: {exam.shuffleOptions ? "randomized" : "original"}</p>
          {exam.schedules.map(schedule => <div key={schedule.id}>
            <p>{locations.find(l => l.id === schedule.locationId)?.name || "Location"}: {new Date(schedule.opensAt).toLocaleString()} – {new Date(schedule.closesAt).toLocaleString()} · {schedule.durationMinutes ?? exam.durationMinutes} minutes · {schedule.eligibilityType ?? "location"}{schedule.eligibilityValue ? `: ${schedule.eligibilityValue}` : ""}{schedule.cancelledAt ? " · Cancelled" : ""}</p>
            {canManage && !schedule.cancelledAt && <><details><summary>Edit schedule</summary><ScheduleForm exam={exam} schedule={schedule} locations={locations} busy={busy} run={run} setError={setError} /></details>
              <button type="button" disabled={busy} onClick={() => {
                if (window.confirm("Cancel this schedule?")) void run(async () => { await request(`/api/admin/exams/${exam.id}/schedules/${schedule.id}`, {}, "DELETE"); }, "Schedule cancelled.");
              }}>Cancel schedule</button></>}
          </div>)}
          {canManage && <><p>Schedules cannot be added or changed after an attempt exists. School and district values are self-reported; verify eligibility independently. Names match exactly, including case. Mixed-scope overlapping sessions are conservatively rejected even when they may not share students.</p><ScheduleForm exam={exam} locations={locations} busy={busy} run={run} setError={setError} /></>}
          {admin.role === "super_admin" && !exam.resultsPublished && <div className="actions"><button type="button" disabled={busy} onClick={() => {
            if (window.confirm("Publish results for this exam? Students will be able to see their scores.")) void run(async () => { await request(`/api/admin/exams/${exam.id}/results`, { published: true }, "PATCH"); }, "Results published.");
          }}>Publish results</button></div>}
        </div>)}</div>}
      </section>
    </>}
  </div>;
}
