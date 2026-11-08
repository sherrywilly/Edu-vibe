"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import WhatsAppInvitation from "../components/whatsapp-invitation";

type Student = { name: string; registrationId: string; school: string; className: string; location: { name: string; whatsappGroupUrl: string | null } };
export default function Dashboard() {
  const [student, setStudent] = useState<Student | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { fetch("/api/student/me").then(async r => {
    if (!r.ok) throw new Error("Please sign in to see your dashboard.");
    setStudent(await r.json());
  }).catch(e => setError(e.message)); }, []);
  return <div className="form-wrap"><p className="eyebrow">Your dashboard</p>
    {error ? <><p className="notice error" role="alert">{error}</p><Link className="button" href="/login">Sign in</Link></> : !student ? <p>Loading your dashboard…</p> : <>
      <h1>Hello, {student.name}!</h1><p className="muted">Your learning journey starts here.</p>
      <div className="card"><h2>Registration details</h2><p>Registration ID: <strong>{student.registrationId}</strong><br />{student.school} · {student.className}<br />Registration location: {student.location.name}</p></div>
      <WhatsAppInvitation location={student.location} />
      <div className="card"><h2>Examinations</h2><p>See your exams, continue an attempt, or check published results.</p><Link className="button" href="/exams">View my exams</Link></div>
    </>}
  </div>;
}
