"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

type Answer = { questionId: string; option: number };
type Attempt = {
  id: string; status: "in_progress" | "submitted"; deadline: string; serverNow: string;
  revision: number; questions: { id: string; prompt: string; options: string[] }[];
  answers: Answer[]; score?: number; total?: number; requestStarted: number;
};
type SaveState = "saved" | "saving" | "unsaved";

async function api(path: string, method = "GET", body?: object): Promise<Attempt> {
  const requestStarted = performance.now();
  const response = await fetch(path, {
    method, cache: "no-store",
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.message === "string" ? data.message : "Unable to connect. Please try again.");
  return { ...data, serverNow: data.serverNow || response.headers.get("date") || "", requestStarted } as Attempt;
}

export default function ExamAttempt() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const path = `/api/student/attempts/${encodeURIComponent(id)}`;
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [error, setError] = useState("");
  const [deadlineWarning, setDeadlineWarning] = useState("");
  const [remaining, setRemaining] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [flagged, setFlagged] = useState<string[]>([]);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenAvailable, setFullscreenAvailable] = useState(false);
  const [fullscreenMessage, setFullscreenMessage] = useState("");
  const answersRef = useRef<Answer[]>([]);
  const revision = useRef(0);
  const editVersion = useRef(0);
  const savedVersion = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clock = useRef<{ deadline: number; serverNow: number; measured: number } | null>(null);
  const checkingDeadline = useRef(false);
  const finalized = useRef(false);
  const submitInProgress = useRef(false);
  const mounted = useRef(true);

  const syncClock = useCallback((data: Attempt) => {
    const serverNow = Date.parse(data.serverNow);
    if (Number.isFinite(serverNow)) clock.current = { deadline: Date.parse(data.deadline), serverNow, measured: data.requestStarted };
  }, []);
  const load = useCallback(async () => {
    const data = await api(path);
    if (!mounted.current) return;
    revision.current = data.revision;
    finalized.current = data.status === "submitted";
    answersRef.current = data.answers;
    editVersion.current = 0; savedVersion.current = 0;
    setAnswers(data.answers); setAttempt(data); setSaveState("saved"); setError("");
    syncClock(data);
  }, [path, syncClock]);
  useEffect(() => {
    mounted.current = true;
    void load().catch(e => { if (mounted.current) setError(e.message); });
    return () => { mounted.current = false; if (timer.current) clearTimeout(timer.current); };
  }, [load]);
  useEffect(() => {
    const updateFullscreen = () => setFullscreen(document.fullscreenElement === document.documentElement);
    setFullscreenAvailable(Boolean(document.fullscreenEnabled && document.documentElement.requestFullscreen));
    updateFullscreen();
    document.addEventListener("fullscreenchange", updateFullscreen);
    return () => document.removeEventListener("fullscreenchange", updateFullscreen);
  }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (editVersion.current !== savedVersion.current) { event.preventDefault(); event.returnValue = ""; }
    };
    const warnLink = (event: MouseEvent) => {
      if (editVersion.current === savedVersion.current || !(event.target instanceof Element)) return;
      const link = event.target.closest("a[href]");
      if (link && !window.confirm("Some answers are not saved yet. Leave anyway?")) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", warnLink, true);
    return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("click", warnLink, true); };
  }, []);

  const save = useCallback(async (): Promise<void> => {
    if (inFlight.current) { await inFlight.current; if (editVersion.current !== savedVersion.current) return save(); return; }
    if (editVersion.current === savedVersion.current) return;
    const version = editVersion.current;
    const snapshot = [...answersRef.current];
    if (mounted.current) { setSaveState("saving"); setError(""); }
    const pending = (async () => {
      const data = await api(`${path}/answers`, "PUT", { revision: revision.current, answers: snapshot });
      revision.current = data.revision; savedVersion.current = version; syncClock(data);
      if (mounted.current) setSaveState(editVersion.current === version ? "saved" : "unsaved");
    })();
    inFlight.current = pending;
    try { await pending; }
    catch (e) {
      if (mounted.current && !finalized.current) { setSaveState("unsaved"); setError(e instanceof Error ? e.message : "Could not save your answer."); }
      throw e;
    } finally { inFlight.current = null; }
    if (editVersion.current !== savedVersion.current) await save();
  }, [path, syncClock]);

  useEffect(() => {
    if (!attempt || attempt.status !== "in_progress") return;
    const tick = () => {
      if (!clock.current) return;
      const left = Math.max(0, Math.ceil((clock.current.deadline - clock.current.serverNow - (performance.now() - clock.current.measured)) / 1000));
      setRemaining(left);
      if (left === 0 && !checkingDeadline.current) {
        checkingDeadline.current = true;
        void api(path).then(data => {
          if (!mounted.current) return;
          syncClock(data);
          if (data.status === "submitted") {
            const serverAnswers = new Map(data.answers.map(answer => [answer.questionId, answer.option]));
            const differs = answersRef.current.length !== data.answers.length ||
              answersRef.current.some(answer => serverAnswers.get(answer.questionId) !== answer.option);
            if (differs) setDeadlineWarning("Time is up. Some answers on this device were not saved and were not included in your submission.");
            finalized.current = true;
            if (timer.current) clearTimeout(timer.current);
            setError("");
            setAttempt(data); setAnswers(data.answers); answersRef.current = data.answers;
            savedVersion.current = editVersion.current;
          }
        }).catch(() => { if (mounted.current) setError("Could not check the exam deadline. Please reconnect."); })
          .finally(() => { checkingDeadline.current = false; });
      }
    };
    tick(); const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [attempt, path, syncClock]);

  function choose(questionId: string, option: number | null) {
    const next = answersRef.current.filter(answer => answer.questionId !== questionId);
    if (option !== null) next.push({ questionId, option });
    answersRef.current = next; editVersion.current++; setAnswers(next); setSaveState("unsaved");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void save().catch(() => {}); }, 400);
  }
  async function submit() {
    if (submitInProgress.current || finalized.current || remaining === 0) return;
    submitInProgress.current = true;
    setSubmitting(true); setError("");
    if (timer.current) clearTimeout(timer.current);
    try {
      await save();
      if (finalized.current) return;
      const data = await api(`${path}/submit`, "POST");
      finalized.current = data.status === "submitted";
      setAttempt(data); setAnswers(data.answers); answersRef.current = data.answers;
    } catch (e) { setError(e instanceof Error ? e.message : "Could not submit. Please try again."); }
    finally { submitInProgress.current = false; if (mounted.current) setSubmitting(false); }
  }
  async function toggleFullscreen() {
    setFullscreenMessage("");
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setFullscreenMessage("Full screen isn't available right now. You can still take your exam.");
    }
  }
  function leave() {
    if (editVersion.current !== savedVersion.current && !window.confirm("Some answers are not saved yet. Leave anyway?")) return;
    router.push("/exams");
  }
  const question = attempt?.questions[questionIndex];
  return <div className="form-wrap">
    <p className="eyebrow">Your exam</p><h1>{attempt?.status === "submitted" ? "All done!" : "Take your time"}</h1>
    {error && <p className="notice error" role="alert">{error}</p>}
    {deadlineWarning && <p className="notice error" role="alert">{deadlineWarning}</p>}
    {!attempt ? <>{!error ? <p>Loading your exam…</p> : <><p><Link href="/exams">Back to my exams</Link></p><button onClick={() => void load().catch(e => setError(e.message))}>Try again</button></>}</> :
      attempt.status === "submitted" ? <>
        <p>Your exam has been submitted. {attempt.score != null && attempt.total != null ? `Your score: ${attempt.score} / ${attempt.total}.` : "Your results will appear when they are published."}</p>
        {fullscreen && <button type="button" onClick={() => void toggleFullscreen()}>Exit full screen</button>}
        {fullscreenMessage && <p role="status">{fullscreenMessage}</p>}
        <Link className="button" href="/exams">Back to my exams</Link>
      </> : <>
        <p role="timer" aria-label="Time remaining">Time remaining: {remaining === null ? "Checking server time…" : `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`}</p>
        <p role="status">{saveState === "saved" ? "All answers saved" : saveState === "saving" ? "Saving your answers…" : "Answers not saved yet"}</p>
        {fullscreenAvailable && <button type="button" onClick={() => void toggleFullscreen()}>{fullscreen ? "Exit full screen" : "Use full screen (optional)"}</button>}
        {fullscreenMessage && <p role="status">{fullscreenMessage}</p>}
        {saveState === "unsaved" && error && <div className="actions"><button type="button" onClick={() => void save().catch(() => {})}>Retry saving</button><button type="button" onClick={() => {
          if (window.confirm("Reload the saved answers? Unsaved changes on this device will be lost.")) void load().catch(e => setError(e.message));
        }}>Reload saved answers</button></div>}
        {reviewing ? <section className="card" aria-labelledby="review-heading">
          <h2 id="review-heading">Let&apos;s check your answers</h2>
          <p>You answered {answers.length} of {attempt.questions.length} questions. You can go back to any question before submitting.</p>
          <p>Flags are reminders on this page only and won&apos;t be saved if you leave or reload.</p>
          <ul>
            {attempt.questions.map((item, index) => <li key={item.id}>
              <button type="button" disabled={submitting} onClick={() => { setQuestionIndex(index); setReviewing(false); }}>
                Question {index + 1}: {answers.some(answer => answer.questionId === item.id) ? "Answered" : "Not answered"}{flagged.includes(item.id) ? " · Flagged for review" : ""}
              </button>
            </li>)}
          </ul>
          <p>Once you submit, you can&apos;t change your answers.</p>
          <div className="actions">
            <button type="button" disabled={submitting} onClick={() => setReviewing(false)}>Keep working</button>
            <button type="button" disabled={submitting || remaining === 0} onClick={() => void submit()}>{submitting ? "Submitting…" : "Submit my exam"}</button>
          </div>
        </section> : <>
        {question && <section className="card">
          <p>Question {questionIndex + 1} of {attempt.questions.length}</p>
          <fieldset disabled={submitting || remaining === 0}>
            <legend><strong>{question.prompt}</strong></legend>
            {question.options.map((option, index) => <label className="check" key={index}>
              <input type="radio" name={`question-${question.id}`} checked={answers.some(answer => answer.questionId === question.id && answer.option === index)} onChange={() => choose(question.id, index)} />{option}
            </label>)}
          </fieldset>
          <button type="button" disabled={submitting || remaining === 0 || !answers.some(answer => answer.questionId === question.id)} onClick={() => choose(question.id, null)}>Clear answer</button>
          <button type="button" disabled={submitting || remaining === 0} aria-pressed={flagged.includes(question.id)} onClick={() => setFlagged(current => current.includes(question.id) ? current.filter(id => id !== question.id) : [...current, question.id])}>
            {flagged.includes(question.id) ? "Remove review flag" : "Flag for review"}
          </button>
          {flagged.includes(question.id) && <p>Flagged for review</p>}
        </section>}
        <div className="actions">
          <button type="button" disabled={questionIndex === 0 || submitting} onClick={() => setQuestionIndex(index => index - 1)}>Previous</button>
          <button type="button" disabled={questionIndex >= attempt.questions.length - 1 || submitting} onClick={() => setQuestionIndex(index => index + 1)}>Next</button>
          <button type="button" disabled={submitting || remaining === 0} onClick={() => setReviewing(true)}>Review and submit</button>
          <button type="button" disabled={submitting} onClick={leave}>Back to my exams</button>
        </div>
        <p>{answers.length} of {attempt.questions.length} answered. Your timer keeps running if you leave.</p>
        </>}
      </>}
  </div>;
}
