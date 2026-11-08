"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Attempt = {
  id: string;
  startedAt: string;
  submittedAt: string | null;
  student: { registrationId: string; name: string };
  exam: { title: string };
};
type AttemptPage = { attempts: Attempt[]; page: number; hasMore: boolean };
type Summary = { attemptId: string; total: number; counts: { type: string; count: number }[] };

async function request<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) {
    if (response.status === 401) throw new Error("Please sign in again.");
    if (response.status === 403) throw new Error("You do not have permission to view attempts.");
    if (response.status === 404) throw new Error("Attempt not found.");
    throw new Error("Unable to load data. Please try again.");
  }
  return response.json() as Promise<T>;
}

export default function AdminAttempts() {
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [results, setResults] = useState<AttemptPage | null>(null);
  const [listError, setListError] = useState("");
  const [listLoading, setListLoading] = useState(true);
  const [listRetry, setListRetry] = useState(0);
  const [selected, setSelected] = useState<Attempt | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [summaryError, setSummaryError] = useState("");
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryRetry, setSummaryRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ page: String(page), q: search });
    void request<AttemptPage>(`/api/admin/attempts?${params}`, controller.signal)
      .then(data => { if (!controller.signal.aborted) setResults(data); })
      .catch(error => {
        if (!controller.signal.aborted) setListError(error instanceof Error ? error.message : "Unable to load attempts.");
      })
      .finally(() => { if (!controller.signal.aborted) setListLoading(false); });
    return () => controller.abort();
  }, [page, search, listRetry]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    void request<Summary>(`/api/admin/attempts/${encodeURIComponent(selected.id)}/events/summary`, controller.signal)
      .then(data => { if (!controller.signal.aborted) setSummary(data); })
      .catch(error => {
        if (!controller.signal.aborted) setSummaryError(error instanceof Error ? error.message : "Unable to load summary.");
      })
      .finally(() => { if (!controller.signal.aborted) setSummaryLoading(false); });
    return () => controller.abort();
  }, [selected, summaryRetry]);

  function resetList() {
    setResults(null); setListError(""); setListLoading(true);
    setSelected(null); setSummary(null); setSummaryError("");
  }
  function selectAttempt(attempt: Attempt) {
    setSummary(null); setSummaryError(""); setSummaryLoading(true);
    if (selected?.id === attempt.id) setSummaryRetry(value => value + 1);
    else setSelected(attempt);
  }

  return <div className="form-wrap">
    <p className="eyebrow">Administration</p><h1>Attempt monitoring</h1>
    <p><Link href="/admin">← Administration</Link></p>
    <p>Focus events are optional and may be incomplete. They are not evidence of misconduct and do not result in score penalties.</p>
    <form onSubmit={event => {
      event.preventDefault();
      const next = input.trim();
      resetList();
      if (page === 1 && search === next) setListRetry(value => value + 1);
      else { setPage(1); setSearch(next); }
    }}>
      <label>Search attempt ID, student registration ID or name, or exam title
        <input value={input} maxLength={200} onChange={event => setInput(event.target.value)} />
      </label>
      <button type="submit">Search</button>
    </form>
    {listLoading ? <p>Loading attempts…</p> : listError ? <>
      <p className="notice error" role="alert">{listError}</p>
      <button type="button" onClick={() => { resetList(); setListRetry(value => value + 1); }}>Try again</button>
    </> : results && <>
      <section><h2>Attempts</h2>
        {results.attempts.length === 0 ? <p>No attempts found.</p> : <div className="list">
          {results.attempts.map(attempt => <div className="card" key={attempt.id}>
            <h3>{attempt.exam.title}</h3>
            <p>{attempt.student.name} · Registration ID: {attempt.student.registrationId}</p>
            <p>Attempt ID: {attempt.id}</p>
            <p>Started: {new Date(attempt.startedAt).toLocaleString()} · Submitted: {attempt.submittedAt ? new Date(attempt.submittedAt).toLocaleString() : "Not submitted"}</p>
            <button type="button" onClick={() => selectAttempt(attempt)}>View focus event summary</button>
          </div>)}
        </div>}
        <div className="actions">
          <button type="button" disabled={page <= 1} onClick={() => { resetList(); setPage(value => value - 1); }}>Previous</button>
          <span>Page {page}</span>
          <button type="button" disabled={!results.hasMore || page >= 99999} onClick={() => { resetList(); setPage(value => value + 1); }}>Next</button>
        </div>
      </section>
      {selected && <section className="card" aria-live="polite">
        <h2>Focus event summary</h2>
        <p>{selected.student.name} · {selected.exam.title} · Attempt {selected.id}</p>
        {summaryLoading ? <p>Loading summary…</p> : summaryError ? <>
          <p className="notice error" role="alert">{summaryError}</p>
          <button type="button" onClick={() => selectAttempt(selected)}>Try again</button>
        </> : summary && <>
          <p>Total recorded events: {summary.total}</p>
          {summary.counts.length ? <ul>{summary.counts.map(item => <li key={item.type}>{item.type.replaceAll("_", " ")}: {item.count}</li>)}</ul> : <p>No events recorded. This does not establish that no events occurred.</p>}
        </>}
      </section>}
    </>}
  </div>;
}
