# Edu Vibe

**Status: incomplete prototype. Do not use for real student data or live examinations.** This is not the complete scholarship examination platform.

## What works

- Next.js responsive registration, student login and basic dashboard, plus a location administration screen.
- NestJS API with PostgreSQL/Prisma migration. Admin-created seven-character random links resolve to a location on the server; registration stores the server-selected location separately from locality. Active/opening/closing status is checked on lookup and registration.
- Phone-and-DOB student login, generic credential errors, registration-ID disambiguation, database-backed sessions and basic database-backed request limits. Consent and optional WhatsApp consent are recorded separately with timestamps and version numbers.
- Searchable, paginated admin student list without DOB or contact fields, and configurable registration opening and closing times. Login limits use keyed identifiers, temporary cooldowns, and progressive delays.
- Individual admin accounts use scrypt passwords, with super-admin, exam-manager and reviewer permissions enforced by the API. Legacy shared-password admin sessions are invalidated by the migration. Admins can manage registration options and edit registration windows.
- Admins can create MCQ exams, schedule them by registration location and publish results. Students can start an eligible exam, save answers, resume, submit and see published scores. Server deadlines and scoring are authoritative. A dedicated BullMQ worker reconciles deadline jobs and periodically sweeps overdue attempts.
- Admins can preview and confirm small CSV student imports with recorded consent evidence. Filtered student CSV and individual admin-only PDF acknowledgements are available. Imports require review; they do not establish consent or verified contact ownership.
- Synthetic example location seed, and a Docker Compose development environment.

## Important gaps

PDF/XLSX imports, question imports, bulk PDF/XLSX exports, certificates, QR codes, notifications and provider integrations are **not implemented**. Private document storage is not integrated. No WhatsApp, email, OCR or external PDF provider was tested or configured, and no real messages are sent.

There is no admin-assisted student credential correction, retention/deletion workflow, comprehensive audit-log viewer, monitoring or comprehensive validation. The application has not had a production security review. Do not deploy it publicly.

Exams are limited to immutable multiple-choice questions with one mark each and scheduling by registration location. Schedules cannot be edited or deleted. Advanced cohort assignment, separate session durations, randomisation, attempt-device leases, question imports, configurable passing criteria, detailed result breakdowns and exam integrity event logs are not implemented. Flags in the exam UI are local to the page and are not saved.

## Local setup

1. Copy `.env.example` to `.env`. Set a random `RATE_LIMIT_SECRET` (at least 32 characters) and a database password containing URL-safe characters. The example values are placeholders only.
2. Run `docker compose up --build`. The API applies the checked-in migrations before starting. Create the first super-admin from a private shell using `docker compose exec -e ADMIN_SETUP_USERNAME -e ADMIN_SETUP_PASSWORD api node dist/auth-setup.js` after securely exporting those variables in that shell. This only works when no admin accounts exist. Use a unique password of at least 12 characters; unset the variables afterwards. Visit <http://localhost:3000/admin>, sign in, configure registration options and create a location.
3. Optionally create a synthetic location with `docker compose exec api node prisma/seed.cjs`; the command prints its registration link. It does not create real students.

Compose runs HTTP with development-mode cookies and is intended only for local use. `WEB_ORIGIN` must exactly match the browser origin. For a different origin, update it and the published port. `NEXT_PUBLIC_BRAND_NAME` changes the displayed brand. The web API proxy destination is configured at build time with `API_URL`.

For running without Compose, start PostgreSQL, then in `api` run `npm ci`, set `DATABASE_URL`, `RATE_LIMIT_SECRET` and `WEB_ORIGIN`, and run `npx prisma migrate deploy`, `npx prisma generate`, and `npm run start:dev`. Set `ADMIN_SETUP_USERNAME` and `ADMIN_SETUP_PASSWORD` securely and run `npx ts-node src/auth-setup.ts` once. For deadline recovery, run the compiled worker with `REDIS_URL` set using `node dist/exam-deadline.main.js`. In `web`, run `npm ci` and `npm run dev`. The default web proxy points to `http://localhost:4000`.

The network rate limiter defaults to disabled because the Next.js rewrite cannot safely establish client IP addresses. Account-based login limits and per-key lookup and registration limits still apply, but per-key limits cannot prevent abuse across many keys. Production requires a separately configured ingress that strips untrusted forwarding headers and applies edge rate limits; only configure trusted forwarding after verifying that boundary. See `api/src/network.ts`. `PDF_FONT_PATH` must point to a suitable Unicode font for acknowledgements containing non-ASCII text.

## Backup and restore

Back up PostgreSQL with `pg_dump` to protected storage, test restoration into a separate database with `pg_restore`, and verify migrations and application access before switching traffic. Keep Redis persistence and database backups consistent with operational recovery procedures; the worker reconciles outstanding exam deadlines from PostgreSQL after restart. Never include `.env` or credentials in backups shared outside the trusted environment.

## Checks

- `cd api && npm test -- --runInBand`
- `cd api && npm run test:e2e -- --runInBand`
- `cd api && npm run build`
- `cd web && npm run lint && npm run build`

The API tests cover key status checks, server-side location assignment, shared-phone/DOB ambiguity and malformed dates. Exam integration tests require a disposable PostgreSQL database via `EXAM_TEST_DATABASE_URL` with the migrations applied. The exam UI was exercised with mock API responses, not as a full browser-to-database flow. These checks do not establish readiness for real examinations or personal data.
