# OpenCare : documentation complète

## Sommaire

1. [Présentation](#présentation)
2. [À qui s'adresse OpenCare ?](#à-qui-sadresse-opencare-)
3. [Architecture technique](#architecture-technique)
4. [Modules et API](#modules-et-api)
5. [Modèle de permissions](#modèle-de-permissions)
6. [Pages publiques (sans compte)](#pages-publiques-sans-compte)
7. [Le kiosk](#le-kiosk)
8. [Intégrations](#intégrations)
9. [Base de données](#base-de-données)
10. [Sécurité](#sécurité)
11. [Déploiement](#déploiement)

---

## Présentation

**OpenCare** est une application **open source** de coordination des aidants familiaux autour d'une personne âgée ou dépendante, développée par **NexaFlow France** sous licence **GNU AGPL v3**. Elle est conçue pour être **auto-hébergée** : les données de santé d'une personne vulnérable restent sur votre serveur, sous votre contrôle.

Le principe central : un **cercle de soin** par proche aidé. La famille, les professionnels (auxiliaire de vie, infirmière) et les voisins se coordonnent dans ce cercle autour d'un **journal de liaison** en temps réel, des médicaments, du calendrier, des frais partagés et de tout ce qui fait le quotidien de l'aide.

L'application est une **Progressive Web App (PWA)** : installable sur l'écran d'accueil d'un téléphone ou d'un ordinateur, tolérante au hors-ligne (file d'attente d'écriture, synchronisation au retour du réseau), pensée pour fonctionner dans une chambre d'EHPAD au réseau capricieux.

La spécification produit de référence vit dans [docs/SPEC.md](docs/SPEC.md).

---

## À qui s'adresse OpenCare ?

Deux publics, deux interfaces :

- **Les aidants** (famille, professionnels, voisins) : usage mobile et desktop. Tableau de bord par cercle, journal, calendrier, médicaments, frais, messagerie.
- **La personne aidée** : une tablette murale en mode kiosk, lecture simple en gros caractères, et deux gros boutons : « Tout va bien » et « J'ai besoin d'aide ».

**Cas d'usage typiques :**

- L'auxiliaire de vie termine son passage et écrit au journal depuis un simple lien, sans compte ni application.
- La fratrie voit en temps réel que la tension a été prise ce matin et que le traitement de midi a été confirmé.
- Les frais (pharmacie, auxiliaire, travaux) sont saisis avec justificatif et répartis façon Tricount entre les enfants.
- Le SAMU scanne le QR du frigo et voit la fiche vitale : traitements actifs, allergies, directives, contacts.
- L'aidant principal part une semaine : un pack de passation généré automatiquement est partagé par lien.
- Un capteur de porte Home Assistant signale « activité normale ce matin » sur le tableau de bord de la famille.

---

## Architecture technique

OpenCare suit une architecture **client-serveur en 3 tiers** :

```
┌──────────────────┐     HTTP / WS     ┌──────────────────┐     SQL      ┌──────────────────┐
│                  │ ◄───────────────► │                  │ ◄──────────► │                  │
│   Client React   │                   │  Serveur Express │              │  PostgreSQL 14+  │
│   (SPA / PWA)    │                   │  (API REST + WS) │              │                  │
│                  │                   │                  │              │                  │
└──────────────────┘                   └──────────────────┘              └──────────────────┘
     Port 3000                              Port 3001                        Port 5432
```

### Monorepo npm workspaces

- `client/` : application React 19 + Vite + Tailwind + Radix UI, PWA (service worker, web push, hors-ligne).
- `server/` : API Express + PostgreSQL (driver `pg`) + WebSocket (`ws`).
- `shared/` : types TypeScript et constantes partagés entre client et serveur.

### Schéma auto-installé

Au premier démarrage, le serveur détecte une base vierge (absence de la table `care_circles`) et applique `server/schema.sql` en une passe (`server/src/db.ts`). Les évolutions ultérieures sont des **migrations idempotentes** exécutées à chaque démarrage. Aucune commande SQL manuelle n'est nécessaire, ni à l'installation ni à la mise à jour.

### Temps réel : WebSocket par cercle

Le serveur maintient les connexions WebSocket par utilisateur (`server/src/lib/broadcaster.ts`). Chaque écriture (journal, prise de médicament, courses, messages, présence...) déclenche un `broadcastToCircle(circleId, ...)` : tous les membres du cercle concerné reçoivent l'événement et leurs interfaces se rafraîchissent instantanément. Un utilisateur appartenant à deux cercles (ses deux parents) ne reçoit que les événements des cercles dont il est membre.

### Rôles et cercles

Tout est rattaché à un `care_circle` (un cercle = un proche aidé). Un utilisateur peut appartenir à plusieurs cercles avec un rôle distinct dans chacun : `admin`, `family`, `professional`, `neighbor`, `viewer`. Les requêtes API portent l'en-tête `X-Circle-Id` et passent par un middleware qui vérifie l'appartenance et le rôle. Les intervenants **sans compte** écrivent au journal via des liens magiques (`caregiver_links`).

### Tâches planifiées

Trois planificateurs node-cron tournent dans le serveur :

- `reminderScheduler` : rappels d'événements et génération des occurrences de prises de médicaments.
- `digestScheduler` : synthèse hebdomadaire IA envoyée au cercle chaque dimanche.
- `presenceMonitor` : règles de veille passive (« aucun signe de vie avant HH:MM »), cascade d'alertes.

### IA multi-fournisseurs

`server/src/services/ai/` abstrait trois fournisseurs : **Ollama** (local), **Anthropic** et tout endpoint **compatible OpenAI**. La fonction `aiComplete()` impose un schéma JSON de sortie. Les clés API sont chiffrées au repos (AES-256-GCM).

---

## Modules et API

Toutes les routes (sauf mention contraire) exigent un JWT (`Authorization: Bearer <token>`) et l'en-tête `X-Circle-Id`. Liste complète des montages dans `server/src/app.ts`.

### Authentification et compte (`/api/auth`)

- `POST /api/auth/register` : création de compte (désactivable via `REGISTRATION_ENABLED=false`).
- `POST /api/auth/login`, `POST /api/auth/refresh`, `GET /api/auth/me`, `PUT /api/auth/profile`, `PUT /api/auth/language`.

### Cercles de soin (`/api/circles`)

- `GET / POST /api/circles` : lister ses cercles, créer un cercle.
- `GET / PUT / DELETE /api/circles/:circleId` : détail, réglages, suppression (admin).
- `PUT / DELETE /api/circles/:circleId/members/:memberId` : rôle, couleur, retrait d'un membre.
- `GET / PUT /api/circles/:circleId/recipient` : profil du proche (identité, médecin traitant, allergies, antécédents, directives anticipées...).

### Invitations (`/api/invites`)

- `GET /api/invites/info/:token` (public) et `POST /api/invites/accept/:token` : page `/join`.
- `GET / POST / DELETE /api/invites` : gestion des invitations du cercle (rôle pré-assigné, expiration).

### Journal de liaison (`/api/journal`) : le cœur de l'app

- `GET / POST /api/journal`, `PUT / DELETE /api/journal/:id` : entrées typées (`visit`, `note`, `vital`, `medication`, `incident`, `mood`), photos, horodatage du passage, diffusion temps réel.
- `GET /api/journal/link/:linkToken/today` et `POST /api/journal/link/:linkToken/entries` : accès par lien magique, sans compte.

### Santé et constantes (`/api/vitals`)

- `GET /api/vitals`, `GET /api/vitals/latest`, `POST / PUT / DELETE` : poids, tension, douleur, moral, température, glycémie. Courbes dans le temps côté client.

### Médicaments (`/api/medications`)

- CRUD des traitements (posologie, photo, prescripteur, consignes) et de leurs horaires de prise.
- `GET /api/medications/intakes`, `PUT /api/medications/intakes/:id` : occurrences générées (`pending`, `taken`, `skipped`, `missed`), confirmation répercutée au journal.
- `GET / POST / PUT / DELETE /api/medications/prescriptions` : ordonnances et alertes de renouvellement.
- `PUT /api/medications/link/:linkToken/intakes/:id` : confirmation de prise par un intervenant en lien magique.

### Calendrier (`/api/events`, `/api/calendar`)

- `GET /api/events`, `GET /api/events/upcoming`, `POST / PUT / DELETE` : visites, rendez-vous médicaux, passages infirmière, récurrences (RRULE simple), rappels, participants.
- `GET / POST /api/calendar/token` puis `GET /api/calendar/feed/:token.ics` (public) : export iCal (.ics / webcal).

### Tâches et courses (`/api/tasks`, `/api/shopping`)

- `GET / POST / PUT / DELETE /api/tasks`, `PUT /api/tasks/:id/complete`, `GET /api/tasks/statistics` : qui fait quoi, récurrences, catégories (courses, pharmacie, lessive...).
- `GET / POST / PUT / DELETE /api/shopping`, `DELETE /api/shopping/checked/clear` : liste de courses partagée du cercle.

### Frais partagés (`/api/expenses`)

- `GET / POST / PUT / DELETE /api/expenses` : payeur, montant, catégorie, justificatif, répartition (égale ou parts personnalisées).
- `GET /api/expenses/balances` : soldes façon Tricount et règlements suggérés.
- `GET / POST / DELETE /api/expenses/settlements` : remboursements entre membres.
- `GET / POST / PUT / DELETE /api/expenses/aids` : suivi des aides françaises (APA, crédit d'impôt, CESU).
- `GET /api/expenses/summary` : synthèse mensuelle.

### Messagerie (`/api/messages`)

- `GET /api/messages` (fil du cercle), `GET /api/messages/dm` et `GET /api/messages/dm/:userId` (messages directs), `POST / PUT / DELETE`, pièces jointes.

### Documents et contacts (`/api/documents`, `/api/contacts`)

- Documents par catégorie (ordonnance, compte-rendu, mutuelle, juridique, autre), CRUD complet.
- Carnet d'adresses du cercle (médecin traitant, SSIAD, kiné, la voisine qui a la clé), CRUD complet.

### Liens magiques (`/api/caregiver-links`)

- `GET / POST / PUT / DELETE /api/caregiver-links` : création et gestion des liens pour intervenants sans compte (nom affiché, portée limitée, expiration optionnelle, partage par URL, QR ou SMS).

### Fiche urgence (`/api/emergency`)

- `GET /api/emergency/public/:token` (public) : la fiche vitale derrière le QR du frigo.
- `GET / PUT /api/emergency/sheet` : contenu et régénération du token.

### « Qui je suis » (`/api/story`)

- `GET / PUT /api/story` : page récit de vie (métier, fiertés, habitudes, ce qui l'apaise), sections éditables.
- `GET /api/story/link/:linkToken` : lecture par les intervenants en lien magique.

### Mode relais (`/api/handover`)

- `GET / POST / DELETE /api/handover` : génération d'un pack de passation (planning, médicaments, consignes, contacts) avec période de validité.
- `GET /api/handover/public/:token` (public) : consultation du pack via la page `/relais/<token>`.

### Veille passive (`/api/presence`)

- `POST /api/presence/webhook/:circleId/:webhookToken` (public, token secret) : réception des signaux Home Assistant (capteur de porte, prise de la cafetière, mouvement).
- `GET /api/presence/status`, `GET /api/presence/signals` : « activité normale » sur le tableau de bord.
- `PUT /api/presence/rule`, `POST /api/presence/webhook-token` (admin) : règles d'alerte et rotation du token.

### Journal vocal (`/api/voice`)

- `POST /api/voice/transcribe` : transcription de l'audio par votre Whisper auto-hébergé.
- `POST /api/voice/journal` : rangement par l'IA (entrée de journal + extraction d'items vers tâches et courses).

### Synthèses et statistiques (`/api/digests`, `/api/insights`, `/api/dashboard`)

- `GET /api/digests`, `POST /api/digests/generate` : synthèse hebdo IA (résumé, signaux faibles).
- `GET /api/insights/equity` : équité de la charge (visites, tâches, présences par membre).
- `GET /api/insights/consultation` : préparation de consultation (événements marquants, courbes, traitements, questions) prête à imprimer.
- `GET /api/dashboard` : agrégation du tableau de bord.

### Kiosk (`/api/kiosk`)

- `POST /api/kiosk/status` : les deux gros boutons (« ok » et « help »).
- `GET /api/kiosk/today` : qui vient aujourd'hui, rappels de médicaments du jour.

### Divers

- `GET / POST / PUT / DELETE /api/notes` : notes partagées du cercle.
- `GET /api/data/export`, `POST /api/data/import` : export et import complets des données du cercle.
- `/api/notifications` : notifications internes, abonnements Web Push (`GET /vapid-public-key`, `POST / DELETE /subscribe`, marquage lu).
- `/api/integrations` : voir [Intégrations](#intégrations).
- `/api/ai` : `GET / PUT /settings` (fournisseur, modèle, clé chiffrée), `POST /test`, `POST /parse`.

---

## Modèle de permissions

Chaque requête vérifie le rôle du membre dans le cercle visé. La matrice de référence (docs/SPEC.md) :

| Action | admin | family | professional | neighbor | viewer | lien magique |
|---|---|---|---|---|---|---|
| Gérer cercle, membres, invitations | x | | | | | |
| Profil du proche, médicaments, documents | x | x | lecture + ajout doc | | lecture | |
| Journal : écrire | x | x | x | x | | x |
| Journal : lire tout | x | x | x | partiel | x | jour même |
| Calendrier : modifier | x | x | x (ses passages) | | | |
| Frais : saisir / régler | x | x | | | | |
| Messagerie | x | x | x | x | | |

Les liens magiques ont une portée volontairement étroite : écrire au journal, lire le jour même, confirmer une prise de médicament, consulter la page « Qui je suis ».

---

## Pages publiques (sans compte)

Quatre routes du client sont accessibles sans authentification :

| URL | Usage | API consommée |
|---|---|---|
| `/care/<token>` | Saisie de journal simplifiée pour un intervenant en lien magique | `/api/journal/link/:token/*`, `/api/medications/link/:token/*`, `/api/story/link/:token` |
| `/urgence/<token>` | Fiche vitale en lecture seule (QR imprimé sur le frigo) | `/api/emergency/public/:token` |
| `/relais/<token>` | Pack de passation du mode relais | `/api/handover/public/:token` |
| `/join` | Acceptation d'une invitation au cercle | `/api/invites/info/:token`, `/api/invites/accept/:token` |

S'y ajoutent deux endpoints publics côté serveur : le flux iCal (`/api/calendar/feed/:token.ics`) et le webhook de présence Home Assistant (`/api/presence/webhook/:circleId/:webhookToken`), tous deux protégés par token secret.

---

## Le kiosk

La page `/kiosk` est un mode plein écran sans menu, pensé pour une tablette fixée au mur chez le proche :

- **Qui vient aujourd'hui** : les visites du jour avec la photo des membres.
- **Rappels de médicaments** en très gros caractères.
- **Photos de famille** : diaporama alimenté par votre instance Immich (la clé API ne quitte jamais le serveur, les photos sont proxifiées par `/api/integrations/immich/photo`).
- **Météo** du jour.
- Deux gros boutons : « Tout va bien » (entrée de journal de type humeur) et « J'ai besoin d'aide » (entrée incident + notification urgente, y compris Web Push, à tout le cercle).

Le kiosk fonctionne avec la session d'un membre du cercle et respecte les contraintes d'accessibilité : gros textes, contrastes AA, cibles tactiles larges.

---

## Intégrations

Les intégrations se configurent par cercle, dans l'interface (page Intégrations), sans toucher au serveur. Les identifiants sont chiffrés au repos (AES-256-GCM). Les URL fournies passent par un garde anti-SSRF (`server/src/utils/urlGuard.ts`) : schémas non http(s) et endpoints de métadonnées cloud toujours bloqués, blocage optionnel des IP privées via `INTEGRATIONS_BLOCK_PRIVATE_IPS=true`.

| Intégration | Rôle |
|---|---|
| **Home Assistant** | Deux usages : la **veille passive** (capteur de porte, prise de la cafetière, détecteur de mouvement, envoyés au webhook de présence) et la synchronisation de la **liste de courses** |
| **Whisper** (speaches, faster-whisper-server ou tout serveur compatible API OpenAI) | Transcription locale du journal vocal |
| **Immich** | Source des photos de famille du kiosk |
| **Nextcloud** | Import CalDAV des agendas dans le calendrier du cercle |
| **Grocy** | Synchronisation de la liste de courses et du stock |
| **Ollama / Anthropic / OpenAI-compatible** | Fournisseur IA pour la synthèse hebdo, le rangement du journal vocal et l'analyse de texte (`/api/ai/settings`) |

Endpoints : `GET /api/integrations`, `POST /api/integrations/test` (essai sans sauvegarde), `POST /api/integrations` (connexion), `POST /api/integrations/:id/sync`, `DELETE /api/integrations/:id`.

---

## Base de données

PostgreSQL 14+ : le schéma complet vit dans `server/schema.sql` et s'applique tout seul au premier démarrage. Tables principales (détail dans docs/SPEC.md) :

| Domaine | Tables |
|---|---|
| Cercle | `care_circles`, `care_recipients`, `circle_members`, `circle_invites`, `caregiver_links` |
| Journal | `journal_entries`, `journal_photos` |
| Santé | `vitals`, `medications`, `medication_schedules`, `medication_intakes`, `prescriptions` |
| Organisation | `events`, `tasks`, `messages`, `documents`, `contacts` |
| Frais | `expenses`, `expense_settlements`, `aid_records` |
| Différenciateurs | `emergency_sheets`, `recipient_story`, `presence_signals`, `weekly_digests`, `handover_packs`, `kiosk_devices` |
| Technique | `users`, `notifications`, `push_subscriptions`, `integrations` |

Caractéristiques : clés primaires UUID, contraintes d'intégrité (`ON DELETE CASCADE` / `SET NULL`), index sur les colonnes requêtées, triggers `updated_at`, JSONB pour les données structurées (réglages, données de mesure, sections du récit de vie).

---

## Sécurité

OpenCare manipule des **données de santé** : la prudence prime à chaque couche.

| Mécanisme | Détail |
|---|---|
| **Authentification** | JWT avec expiration à 7 jours, `JWT_SECRET` de 32 caractères minimum exigé au démarrage (les valeurs d'exemple sont refusées) |
| **Mots de passe** | bcrypt, coût 12 |
| **Isolation par cercle** | Chaque requête vérifie l'appartenance au cercle et le rôle du membre ; les liens magiques ont une portée réduite et révocable |
| **En-têtes HTTP** | helmet, avec une CSP dédiée quand le serveur sert aussi le client (`SERVE_CLIENT_DIR`) |
| **Anti brute-force** | Rate limiting sur `/api/auth/login` et `/api/auth/register` (fenêtre et plafond configurables) |
| **CORS** | Origines strictes configurables (`CORS_ORIGINS`) |
| **Secrets** | Clés IA et identifiants d'intégrations chiffrés au repos (AES-256-GCM), jamais renvoyés au navigateur |
| **SSRF** | Validation des URL d'intégrations (schéma, métadonnées cloud, IP privées optionnellement bloquées) |
| **Journaux** | Logs structurés, stack traces masquées en production |

Voir [SECURITY.md](SECURITY.md) pour le signalement de vulnérabilités.

---

## Déploiement

Trois voies, détaillées dans [INSTALLATION.md](INSTALLATION.md) :

1. **Installateur Windows** (`OpenCare-Setup.exe`) : Node.js et PostgreSQL embarqués, aucun Docker, aucune configuration. Le serveur sert aussi le client (`SERVE_CLIENT_DIR`) et l'application est accessible sur le réseau local.
2. **Docker Compose** : 3 conteneurs (`opencare-db`, `opencare-server`, `opencare-client` derrière Nginx).
3. **Manuel** : Node 20+, PostgreSQL 14+, `npm install` puis `npm run dev`. Sous Windows sans Docker : `scripts/dev-windows.ps1`.

Dans tous les cas, le schéma de base de données s'installe tout seul au premier démarrage du serveur.

---

> **Dépôt GitHub** : [https://github.com/NexaFlowFrance/OpenCare](https://github.com/NexaFlowFrance/OpenCare)
> **Spécification produit** : [docs/SPEC.md](docs/SPEC.md)
> **Licence** : GNU AGPL v3
> **Auteur** : NexaFlow France
