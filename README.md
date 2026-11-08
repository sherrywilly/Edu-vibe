# Edu Vibe

**Status: incomplete prototype. Do not use for real student data or live examinations.** This repository currently implements a registration and login foundation, not the complete scholarship examination platform.

## What works

- Next.js responsive registration, student login and basic dashboard, plus a location administration screen.
- NestJS API with PostgreSQL/Prisma migration. Admin-created seven-character random links resolve to a location on the server; registration stores the server-selected location separately from locality. Active/opening/closing status is checked on lookup and registration.
- Phone-and-DOB student login, generic credential errors, registration-ID disambiguation, database-backed sessions and basic database-backed request limits. Consent and optional WhatsApp consent are recorded separately with timestamps and version numbers.
- Synthetic example location seed, and a Docker Compose development environment.

## Important gaps

Exams, scheduling, attempts, autosave, background finalisation, scoring, results, PDF/CSV/XLSX imports and exports, certificates, QR codes, notifications, provider integrations, and their tests are **not implemented**. Redis is provisioned but unused; BullMQ and private document storage are not integrated. No WhatsApp, email, OCR or PDF provider was tested or configured, and no real messages are sent.

Admin authentication currently uses a single bootstrap password and an admin/student role distinction, not individual accounts, strong credential management, or the requested super-admin/exam-manager/reviewer permissions. There is no admin-assisted credential correction, retention/deletion workflow, managed options, school search, date-window editor, audit-log viewer, progressive login delays, monitoring or comprehensive validation. The current rate limiter uses the API connection IP; behind the Next.js proxy this can group users together and is not suitable for production. The application has not had a production security review. Do not deploy it publicly.

## Local setup

1. Copy `.env.example` to `.env`. Set a long unique `ADMIN_PASSWORD` (at least 20 characters), a separate random `RATE_LIMIT_SECRET` (at least 32 characters), and a database password containing URL-safe characters. The example values are placeholders only.
2. Run `docker compose up --build`. The API applies the checked-in migration before starting. Visit <http://localhost:3000/admin>, sign in and create a location. Open its link to register a synthetic student.
3. Optionally create a synthetic location with `docker compose exec api node prisma/seed.cjs`; the command prints its registration link. It does not create real students.

Compose runs HTTP with development-mode cookies and is intended only for local use. `WEB_ORIGIN` must exactly match the browser origin. For a different origin, update it and the published port. `NEXT_PUBLIC_BRAND_NAME` changes the displayed brand. The web API proxy destination is configured at build time with `API_URL`.

For running without Compose, start PostgreSQL, then in `api` run `npm ci`, set `DATABASE_URL`, `ADMIN_PASSWORD`, `RATE_LIMIT_SECRET` and `WEB_ORIGIN`, and run `npx prisma migrate deploy`, `npx prisma generate`, and `npm run start:dev`. In `web`, run `npm ci` and `npm run dev`. The default web proxy points to `http://localhost:4000`.

## Checks

- `cd api && npm test -- --runInBand`
- `cd api && npm run test:e2e -- --runInBand`
- `cd api && npm run build`
- `cd web && npm run lint && npm run build`

The API tests cover key status checks, server-side location assignment, shared-phone/DOB ambiguity and malformed dates. They do not establish readiness for real examinations or personal data.
