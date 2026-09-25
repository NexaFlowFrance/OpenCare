# Contributing to OpenCare

Thank you for being here. OpenCare is used by families to coordinate care around a
vulnerable person, so the bar for correctness is high, but the project is small and
approachable: one npm workspace repository, no framework magic, no build steps you cannot
run on your laptop.

If anything below is unclear or out of date, that itself is worth an issue.

## Ways to help

- **Report a bug.** Open an [issue](https://github.com/NexaFlowFrance/OpenCare/issues/new/choose)
  with what you did, what you expected and what happened. A screenshot of the screen and the
  browser console usually saves a round trip.
- **Translate.** Copy `client/src/i18n/locales/en/` to `client/src/i18n/locales/<code>/` and
  translate the values. The language appears in the switcher on its own, no wiring needed.
  Partial translations are fine: missing keys fall back to English.
- **Pick a first issue.** Anything labelled
  [good first issue](https://github.com/NexaFlowFrance/OpenCare/issues?q=is%3Aopen+label%3A%22good+first+issue%22)
  is scoped so it can be finished in one sitting.
- **Propose a feature.** Open an issue first and describe the caregiving situation it solves.
  The product direction lives in [docs/SPEC.md](docs/SPEC.md) and [ROADMAP.md](ROADMAP.md).

## Local setup

You need Node.js 20 or later and a PostgreSQL 15 or later database.

```bash
git clone https://github.com/NexaFlowFrance/OpenCare.git
cd OpenCare
npm install                 # single lockfile at the root, installs all workspaces
cp .env.example .env        # set POSTGRES_* and JWT_SECRET
npm run dev                 # client on 3000, server on 3001
```

The schema installs itself on first start, so there is no migration command to run.

- **Windows without Docker**: `scripts/dev-windows.ps1` starts the PostgreSQL bundled with
  the installer on port 5544 and the app against it.
- **Docker**: `docker-compose up -d --build`.
- Set `REGISTRATION_ENABLED=true` in `.env` to create the first account.

## Before opening a pull request

```bash
npm test               # unit tests, fast, no database needed
npm run build          # shared, server and client, with type checking
npm run smoke:api      # end to end HTTP walk through the API (needs jq and a running server)
```

All three run in CI on every pull request. The unit tests live in `tests/` and cover the
logic that breaks silently: intake windows, recurrence and its exceptions, escalation
rules, care plan sections, the grounded companion answers, and the consistency of every
locale. Add one next to your change when you touch that kind of logic. Two more checks are
quick and catch most review comments:

- **FR and EN key parity.** Every key added to `client/src/i18n/locales/fr/<ns>.json` must
  exist in `client/src/i18n/locales/en/<ns>.json`, and the other way around.
Both of these are covered by `npm test`, so a failing pull request tells you which key or
which file is at fault.

- **No em dash.** The em dash character (U+2014) is not used anywhere in the project, in code, comments,
  documentation or user-facing text. Use a comma, a colon or two sentences.

## Invariants not to break

These come from real review findings. A change that touches them needs a test or a very
good explanation.

- **The `neighbor` role never sees health data.** No medications, no vitals, no full recipient
  profile, on any route, in any payload. The permission matrix in [docs/SPEC.md](docs/SPEC.md)
  is the reference.
- **A paired patient device only reaches patient routes.** The `X-Kiosk-Token` header opens
  `/api/kiosk/*`, the companion and the transcription endpoint, and nothing else.
- **Outgoing requests to user-supplied URLs go through `safeFetch`** and the URL guard, which
  block private ranges and cloud metadata endpoints.
- **The emergency sheet is off by default** and its public token is revocable.
- **Data stays on the server.** No telemetry, no analytics, no third-party font or script
  fetched at runtime.

## Code conventions

- TypeScript everywhere, strict mode. No `any` unless a library forces it.
- The server keeps SQL in the route or lib that owns it. Shared logic that more than one
  route needs lives in `server/src/lib/`.
- The client is React with Tailwind. Colors and spacing come from the design tokens in
  `client/src/design/tokens.css`, not from raw hex values, with one deliberate exception:
  the patient screen (`client/src/pages/Kiosk.tsx` and its overlays) has its own high
  contrast palette in the file itself.
- Comments explain why, not what. They are welcome on anything a future reader could get
  wrong, especially timezone handling, permissions and recurrence.
- Timestamps are naive local `TIMESTAMP` columns and naive local ISO strings. Never
  `toISOString()` on a value that will be compared to a column.
- Every user-facing string goes through i18n, in French and English.

## Commit and pull request

- One topic per pull request. A refactor and a feature in the same diff are hard to review.
- Commit messages in English, in the imperative, with a scope when it helps:
  `feat(medications): track stock and warn before running out`.
- Say in the description what you tested and how. Screenshots for anything visual, both
  light and dark theme.

## Security

Please do not open a public issue for a vulnerability. [SECURITY.md](SECURITY.md) explains
how to report it privately.

## License

By contributing you agree that your contribution is licensed under the
[AGPL-3.0-only](licence.md), like the rest of the project.
