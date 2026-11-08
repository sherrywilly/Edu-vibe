import Link from "next/link";

export default function Home() {
  return <>
    <section className="hero"><div className="container">
      <p className="eyebrow">A brighter beginning</p>
      <h1>Big dreams start with a little curiosity.</h1>
      <p className="lead">Welcome to a scholarship experience designed for young learners and the people cheering them on.</p>
      <div className="actions"><Link className="button" href="/login">Student login →</Link><a className="button secondary" href="#how">How it works</a></div>
    </div></section>
    <section className="section container" id="how"><p className="eyebrow">Your journey</p><h2>Small steps, exciting possibilities.</h2>
      <div className="grid"><div className="card"><strong>01 · Register</strong><p>Open the unique registration link shared by your school or organiser.</p></div>
      <div className="card"><strong>02 · Sign in</strong><p>Use your parent’s mobile number and your date of birth to access your dashboard.</p></div>
      <div className="card"><strong>03 · Get ready</strong><p>Keep your registration ID safe and look out for further instructions from your organiser.</p></div></div>
    </section>
  </>;
}
