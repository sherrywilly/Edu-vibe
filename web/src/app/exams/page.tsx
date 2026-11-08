"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

type Exam = {
  id: string; scheduleId: string; title: string; durationMinutes: number; opensAt: string; closesAt: string;
  resultsPublished: boolean;
  attempt: null | { id: string; status: "in_progress" | "submitted"; score?: number; total?: number; passingScore?: number | null; passed?: boolean | null };
};

export default function Exams() {
  const router = useRouter();
  const [exams, setExams] = useState<Exam[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    const response = await fetch("/api/student/exams", { cache: "no-store" });
    if (!response.ok) throw new Error(response.status === 401 ? "Please sign in to see your exams." : "Could not load your exams. Please try again.");
    setExams(await response.json());
  }, []);
  useEffect(() => { void load().catch(e => setError(e.message)); }, [load]);
  async function start(exam: Exam) {
    if (!window.confirm(`Start ${exam.title}? Your time begins now, even if you leave this page.`)) return;
    setBusy(exam.id); setError("");
    try {
      const response = await fetch(`/api/student/exams/${exam.id}/start`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not start this exam.");
      router.push(`/exams/${data.id}`);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to connect."); setBusy(""); }
  }
  return <div className="form-wrap">
    <p className="eyebrow">Your learning journey</p><h1>My exams</h1>
    <p><Link href="/dashboard">← Back to dashboard</Link></p>
    {error && <p className="notice error" role="alert">{error} {exams === null && <Link href="/login">Sign in</Link>}</p>}
    {exams === null ? !error && <p>Loading your exams…</p> : exams.length === 0 ? <p>There are no exams scheduled for your location yet.</p> :
      <div className="list">{exams.map(exam => <section className="card" key={exam.scheduleId}>
        <h2>{exam.title}</h2><p>{exam.durationMinutes} minutes<br />Open: {new Date(exam.opensAt).toLocaleString()}<br />Closes: {new Date(exam.closesAt).toLocaleString()}</p>
        {exam.attempt?.status === "submitted" ? <>
          <p>All done! {exam.resultsPublished && exam.attempt.score != null && exam.attempt.total != null ? `Your score: ${exam.attempt.score} / ${exam.attempt.total}.` : "Results are not published yet."}</p>
          {exam.attempt.passed != null && <p>{exam.attempt.passed ? "Passed" : "Not passed"} (passing score: {exam.attempt.passingScore}).</p>}
          <Link href={`/exams/${exam.attempt.id}`}>View result</Link>
        </> : exam.attempt ? <><p>Your exam is in progress. The clock keeps running while you are away.</p><Link className="button" href={`/exams/${exam.attempt.id}`}>Continue exam</Link></> :
          <><p>Start when the exam is open. Your timer cannot be paused.</p><button disabled={!!busy} onClick={() => void start(exam)}>{busy === exam.id ? "Starting…" : "Start exam"}</button></>}
      </section>)}</div>}
    {error && exams !== null && <button type="button" onClick={() => { setError(""); void load().catch(e => setError(e.message)); }}>Refresh exam list</button>}
  </div>;
}
