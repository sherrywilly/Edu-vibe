"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Login() {
  const router = useRouter();
  const [ambiguous, setAmbiguous] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch("/api/student/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message);
      if (data.requiresRegistrationId) setAmbiguous(true);
      else router.push("/dashboard");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to connect."); }
    finally { setBusy(false); }
  }
  return <div className="form-wrap"><p className="eyebrow">Welcome back</p><h1>Student login</h1>
    <p className="muted">Use your parent’s registered mobile number and your date of birth.</p>
    {error && <p className="notice error" role="alert">{error}</p>}
    <form onSubmit={submit}>
      <label>Parent’s mobile number<input name="phone" type="tel" required placeholder="+91" /></label>
      <label>Date of birth (DD/MM/YYYY)<input name="dob" required placeholder="DD/MM/YYYY" pattern="\d{2}/\d{2}/\d{4}" inputMode="numeric" /></label>
      {ambiguous && <label>Registration ID<input name="registrationId" required /></label>}
      <button disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  </div>;
}
