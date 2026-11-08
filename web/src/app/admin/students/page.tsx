"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Student = { id: string; registrationId: string; name: string; school: string; district: string; className: string; medium: string; syllabus: string; locality: string; location: { name: string } };
type Location = { id: string; name: string };
type Result = { students: Student[]; total: number; page: number };

export default function Students() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [location, setLocation] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => {
    setError("");
    try {
      const params = new URLSearchParams({ search: submittedSearch, locationId: location, page: String(page) });
      const response = await fetch(`/api/admin/students?${params}`, { signal });
      if (!response.ok) throw new Error(response.status === 401 ? "Please sign in as an administrator." : "Unable to load students.");
      setResult(await response.json());
    } catch (e) { if (!signal?.aborted) { setResult(null); setError(e instanceof Error ? e.message : "Unable to connect."); } }
  }, [submittedSearch, location, page]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  useEffect(() => { fetch("/api/admin/locations").then(r => r.ok ? r.json() : []).then(setLocations).catch(() => setLocations([])); }, []);

  return <div className="form-wrap"><p className="eyebrow">Administration</p><h1>Students</h1>
    <Link href="/admin">← Back to administration</Link>
    <form onSubmit={e => { e.preventDefault(); setPage(1); if (submittedSearch === search && page === 1) void load(); else setSubmittedSearch(search); }}>
      <label>Search name, ID, school, district, class, medium, syllabus or locality<input value={search} onChange={e => setSearch(e.target.value)} maxLength={120} /></label>
      <label>Registration location<select value={location} onChange={e => { setLocation(e.target.value); setPage(1); }}><option value="">All locations</option>{locations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <button>Search</button>
    </form>
    {error ? <p className="notice error" role="alert">{error}</p> : !result ? <p>Loading students…</p> : <>
      <h2>{result.total} registrations</h2>
      {result.students.length === 0 ? <p className="muted">No students match these filters.</p> : <div className="list">{result.students.map(student => <article className="card" key={student.id}>
        <strong>{student.name}</strong> · {student.registrationId}<br />{student.school} · {student.district}<br />{student.className} · {student.medium} · {student.syllabus}<br />Locality: {student.locality}<br />Registration location: {student.location.name}
      </article>)}</div>}
      <div className="actions"><button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page}</span><button type="button" disabled={page * 50 >= result.total} onClick={() => setPage(page + 1)}>Next</button></div>
    </>}
  </div>;
}
