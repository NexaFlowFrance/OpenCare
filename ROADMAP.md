# OpenCare : Roadmap

This document tracks where the project stands and the larger ideas that are not yet
implemented. It is not a commitment or a schedule: priorities can shift based on
feedback, and issues and discussions are welcome.

The product specification lives in [docs/SPEC.md](docs/SPEC.md).

## Shipped

Everything described in docs/SPEC.md is implemented and released:

- **Care circles**: one circle per cared-for person, multi-circle accounts, fine-grained
  roles (admin, family, professional, neighbor, viewer), invitations by link, care
  recipient profile (medical history, allergies, directives).
- **Care journal**: the heart of the app. Typed entries (visit, note, vital, medication,
  incident, mood) with photos, real time over WebSocket.
- **Health tracking**: vitals (weight, blood pressure, pain, mood, temperature, glucose)
  with curves over time.
- **Medications**: treatments, schedules, generated intakes with confirmation written to
  the journal, prescriptions and renewal alerts.
- **Calendar**: visit and medical categories, simple recurrences, reminders, iCal export.
- **Tasks and shared shopping list.**
- **Messages**: circle thread and direct messages, attachments.
- **Documents and contacts**: the circle's paperwork and address book.
- **Shared expenses**: Tricount-style balances and settlements, plus tracking of French
  aids (APA, CESU, tax credit).
- **Care-load fairness**: objective per-member stats (visits, tasks, presence).
- **Magic links**: professionals write in the journal without an account (URL/QR/SMS).
- **Consultation prep**: printable summary for the doctor since the last visit.
- **Emergency QR sheet**: public read-only vital sheet for first responders.
- **"Who I am" page**: life story shown to new caregivers.
- **Respite handover packs**: auto-generated, shared by link, time-limited.
- **Kiosk**: wall tablet for the cared-for person, with the "All is well" / "I need
  help" buttons.
- **Passive monitoring**: Home Assistant webhooks, normal-activity display, alert rules.
- **Voice journal**: self-hosted Whisper transcription, AI filing into journal, tasks
  and shopping.
- **Weekly AI digest**: Sunday summary with weak-signal detection.
- **Integrations**: Home Assistant (passive monitoring and shopping), Whisper, Immich,
  Nextcloud (CalDAV), Grocy, and a multi-provider AI layer (Ollama, Anthropic,
  OpenAI-compatible) with keys encrypted at rest.
- **Foundation**: self-bootstrapping PostgreSQL schema, offline-friendly PWA, web push,
  full data export/import, French and English UI, Docker deployment and the one-click
  Windows installer.

## Future ideas

- **Native mobile app**: the PWA covers most needs today; a native app (better
  notifications, background sync, widgets) is the natural next step.
- **SMS notifications**: an optional SMS gateway for circle members and magic-link
  caregivers who do not use smartphones or push notifications.
- **DMP / Mon Espace Sante import**: import health documents and treatment data from
  the French national health record.
- **More languages**: the interface is currently French/English. The i18n
  infrastructure is in place (namespaced JSON locales); the goal is to add German,
  Spanish, Italian, Dutch and more, ideally through a community translation workflow
  (e.g. Weblate). Contributions welcome.
- **Multi-circle aggregation for professionals**: a cross-circle view for nurses and
  home aides who follow several cared-for persons (today each circle is consulted
  separately).
- **Per-occurrence exceptions for recurrences**: edit or cancel a single occurrence of
  a recurring event or task without breaking the series.
- **Message read-tracking**: show who has seen a message in the circle thread.
