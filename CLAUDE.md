# OpenCare

App auto-hébergée de coordination d'aidants familiaux autour d'une personne âgée. Par NexaFlow, licence AGPL-3.0. Issue du socle OpenFamily (copie transformée).

Lire `docs/SPEC.md` avant tout travail produit : modèle de données, rôles, phases.

## Règles absolues

- AUCUN em dash (le caractère tiret long) nulle part : code, UI, i18n, docs, commits. Utiliser deux points, parenthèses ou virgules.
- Design sobre et épuré, jamais criard, pas d'esthétique néon/gradients IA.
- Tout le travail reste local : ne JAMAIS commiter sans demande explicite de l'utilisateur. Identité git du repo : NexaFlowFrance <contact@nexaflow.fr>.
- i18n systématique : chaque chaîne UI passe par i18next, FR et EN (`client/src/i18n/locales/{fr,en}/`).

## Stack

- Monorepo npm workspaces : `client/` (React 19, Vite, Tailwind, Radix UI, PWA), `server/` (Express, PostgreSQL via pg, ws), `shared/` (types TS).
- Node 20+, npm 10+. Dev : `npm run dev` (concurrently). PostgreSQL local (docker-compose.yml fourni).
- Migrations idempotentes dans `server/src/db.ts`, schéma initial `server/schema.sql`.
- Temps réel : `server/src/lib/broadcaster.ts` (WebSocket par userId).
- IA : `server/src/services/ai/` (Ollama, Anthropic, OpenAI-compatible), `aiComplete()` avec JSON schema.
- Rappels planifiés : `server/src/lib/reminderScheduler.ts` (node-cron).
- Installateur Windows : `installer/windows/` (Inno Setup, runtimes Node + PostgreSQL embarqués).

## Domaine

Tout est rattaché à un `care_circle` (un cercle = un proche aidé). Un utilisateur peut appartenir à plusieurs cercles avec des rôles différents : admin, family, professional, neighbor, viewer. Les intervenants sans compte écrivent au journal via `caregiver_links` (liens magiques). Voir la matrice de permissions dans docs/SPEC.md.
