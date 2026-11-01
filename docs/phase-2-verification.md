# Phase 2 — authentication and access layer

Status checked: 2026-11-02. **Not started; not verified.**

## Purpose and status log

Phase 2 adds GitHub/Google OAuth, protected application routes and a
data-access layer that requires the authenticated user's ID. It must prevent
one user from reading, editing or deleting another user's data.

- **2026-11-02 — Prerequisite audit logged.** The repository contains the
  Phase 1 auth table schema but no auth runtime, protected routes or
  application access layer. Phase 2 remains unchecked in doc 06. No OAuth,
  login redirect or application IDOR acceptance result is claimed.

## Required completion evidence

From doc 06: unauthenticated requests redirect to `/login?next=`; IDOR tests
prove user A cannot read, edit or delete user B's rows. These checks have
not been run because their implementations do not exist.

Security tests for the access layer must precede dependent application code.
Schema ownership constraints from Phase 1 supplement these checks; they do
not replace authentication or authorization tests.

See the completed [Phase 0](phase-0-verification.md) and
[Phase 1](phase-1-verification.md) logs for the verified foundation.
