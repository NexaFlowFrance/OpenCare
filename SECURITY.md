# Security Policy

OpenCare stores the **health data of vulnerable people**: medical history, treatments,
vitals, emergency directives. Any vulnerability in OpenCare is a vulnerability in the
privacy of a cared-for person and their family. We treat every report with that level
of seriousness, and we ask reporters to handle findings with the same care.

## Supported Versions

OpenCare is actively maintained on the `main` branch and latest release tags.

- `main`: supported
- Latest release (`v*`): supported
- Older releases: best effort only

## Reporting a Vulnerability

If you discover a security vulnerability, please do not open a public issue.

Send a private report with the following information:

- A clear description of the issue
- Steps to reproduce
- Impact assessment (in particular: can health data of a circle be read or altered
  by someone outside that circle?)
- Proposed mitigation (if available)

Contact: contact@nexaflow.fr

If email is unavailable, open a GitHub issue with no exploit details and ask for a private contact channel.

## Disclosure Process

- We acknowledge new reports within 72 hours.
- We triage and assess severity. Anything exposing care-circle data across circle
  boundaries, through public token pages (emergency sheet, magic links, handover) or
  through the kiosk is treated as high severity by default.
- We work on a fix and coordinate disclosure with the reporter.
- We publish a patch release and security notes when applicable.

## Security Best Practices for Self-Hosting

You are hosting health data: a few minutes of hardening are worth it.

- Set a strong `JWT_SECRET` (minimum 32 characters; the server refuses placeholder values).
- Set a strong `POSTGRES_PASSWORD` (the server refuses to start in production without one).
- Restrict `CORS_ORIGINS` to trusted frontend domains.
- Use HTTPS for both app and API in production (also required for web push and the PWA).
- Set `REGISTRATION_ENABLED=false` once every member of the circle has an account.
- Treat magic links (`/care/<token>`), the emergency sheet QR and handover links as
  secrets: share them only with the intended caregivers, set expirations, and revoke
  them when a caregiver stops intervening.
- Consider `INTEGRATIONS_BLOCK_PRIVATE_IPS=true` on hardened deployments where
  integrations never target your LAN.
- Keep Docker images and dependencies up to date.
- Do not expose PostgreSQL publicly unless required.
- Back up the database and your `.env` securely (backups contain health data too).
