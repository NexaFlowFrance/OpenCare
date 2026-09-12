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

- **Les aidants** (famille, professionnels, voisins) : usage mobile et desktop. Tableau de bord par cercle ouvert sur « À traiter », journal, calendrier, médicaments, frais, messagerie. La navigation est regroupée en six sections (Aujourd'hui, Soins, Organiser, Informations, Équipe, Plus) et masque au rôle voisin ce qu'il ne peut pas consulter.
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
- Modèle : chaque horaire porte une **quantité et une unité** (« 2 comprimés », « 5 ml »), distinctes du dosage (« 500 mg ») ; le médicament indique s'il est **« si besoin »** (`prn`, sans horaire), sa prise par rapport aux repas (`with_food`), **pourquoi** il est pris (`reason`) et son **aspect** (`appearance`). Chaque prise garde la quantité de son horaire et la **source de confirmation** (`caregiver`, `kiosk`, `phone`, `link`).
- `GET /api/medications/intakes`, `PUT /api/medications/intakes/:id` : occurrences générées (`pending`, `taken`, `skipped`, `missed`), confirmation répercutée au journal.
- `POST /api/medications/:id/intakes` : prise ponctuelle d'un médicament « si besoin » (enregistrée comme prise, maintenant).
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
- `GET /api/presence/status`, `GET /api/presence/signals` : « activité normale » sur le tableau de bord. Le bouton « Tout va bien » de l'écran patient enregistre aussi un signal de présence (source `kiosk`) : appuyer dessus suffit à lever l'alerte « aucun signe de vie ».
- `PUT /api/presence/rule`, `POST /api/presence/webhook-token` (admin) : règles d'alerte et rotation du token.

### Journal vocal (`/api/voice`)

- `POST /api/voice/transcribe` : transcription de l'audio par votre Whisper auto-hébergé.
- `POST /api/voice/journal` : rangement par l'IA (entrée de journal + extraction d'items vers tâches et courses).

### Synthèses et statistiques (`/api/digests`, `/api/insights`, `/api/dashboard`)

- `GET /api/digests`, `POST /api/digests/generate` : synthèse hebdo IA (résumé, signaux faibles).
- `GET /api/insights/equity` : équité de la charge (visites, tâches, présences par membre).
- `GET /api/insights/consultation` : préparation de consultation (événements marquants, courbes, traitements, questions) prête à imprimer.
- `GET /api/dashboard` : agrégation du tableau de bord. Le champ `attention` (« À traiter ») liste, par gravité, ce qu'un aidant doit regarder en premier : signaux d'alerte des dernières 24 h (bouton d'aide, compagnon), aucun signe de vie avant l'heure limite de la veille passive, prises manquées, ordonnances à renouveler, tâches en retard, visiteur sur place, rendez-vous dans les deux heures. Les éléments de santé sont omis pour le rôle voisin.

### Kiosk (`/api/kiosk`)

- `POST /api/kiosk/status` : les deux gros boutons (« ok » et « help »).
- `GET /api/kiosk/today` : qui vient aujourd'hui, prises du jour (avec photo, quantité et consignes), et la vue patient `medications` : uniquement ce qui est **à prendre maintenant** (`due_now`), le reste résumé (`upcoming_count`, `next_due_at`, `taken_count`). Les prises du jour sont générées à l'appel, même si personne n'a ouvert l'application aidant.
- `POST /api/kiosk/intakes/confirm` : « J'ai tout pris » depuis le kiosk ou le téléphone du patient (`intake_ids`, `source`), attribué au proche dans le journal avec la source conservée.

### Plan de soins (`/api/care-plan`)

Une page qui rassemble ce qu'il faut savoir pour prendre soin du proche, sans dupliquer : huit **consignes** rédigées par la famille (routine du matin, repas, aide à la mobilité, toilette et soins personnels, communication, ce qui contrarie, ce qui apaise, en cas d'urgence ; table `care_plans`, 4 000 caractères par section, mise à jour partielle par `PUT /api/care-plan` pour admin et famille), puis la **routine médicamenteuse** calculée depuis les traitements actifs et leurs horaires (matin, midi, soir, coucher, plus « si besoin » ; omise pour le rôle voisin), les **professionnels réguliers** (contacts médecin, infirmier, aide à domicile, kiné, pharmacie) et la **semaine à venir** (agenda sur sept jours, occurrences récurrentes comprises). Chaque bloc renvoie vers sa page. La page s'imprime. Les consignes alimentent aussi le pack de relais (`content.care_plan`) et l'écran patient : un visiteur professionnel peut les lire pendant sa visite (`GET /api/kiosk/care-plan`, sections non vides seulement).

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

La page `/kiosk` (alias `/myday`) est l'**écran patient** : un mode plein écran sans menu, pour la tablette fixée au mur chez le proche et, à l'identique, pour son téléphone (mode poche). Il répond à quatre questions seulement :

- **Qu'est-ce que je dois faire maintenant ?** Uniquement les médicaments dus maintenant, avec photo, nom, dosage et « Prends 2 comprimés », puis un seul bouton « J'ai tout pris ». Les prises futures ne sont pas montrées (« Prochaine prise à 20 h »), les prises manquées restent côté aidant.
- **Qui vient aujourd'hui ?** Les visites du jour avec la photo et le rôle des membres, ou l'infirmière et l'aide à domicile.
- **Est-ce que j'ai un rendez-vous ?** Les rendez-vous médicaux du jour, avec l'heure et le lieu.
- **Comment demander ?** « Demandez-moi » (réponses sur la journée, puis compagnon de conversation), « Mes informations » (nom, adresse, téléphone, médecin, pharmacie, infirmière, aide à domicile), et les deux gros boutons « Tout va bien » (entrée de journal de type humeur) et « J'ai besoin d'aide » (entrée incident + notification urgente, y compris Web Push, à tout le cercle).

### Demandez-moi

Le bouton **« Demandez-moi »** répond d'abord avec les données du cercle, sans IA : « Qu'est-ce que je dois prendre ? » (les prises dues maintenant, avec la quantité), « Qui vient aujourd'hui ? » (visites prévues à l'agenda et visiteurs signalés sur l'écran), « Mes rendez-vous ? », « Quel jour sommes-nous ? », « Qui puis-je appeler ? » (médecin, pharmacie, infirmier, aide à domicile), la canicule. Les questions sont reconnues par mots-clés en français et en anglais, proposées en boutons rapides, et les réponses sont lues à voix haute par le navigateur. Une demande d'aide (« au secours », « j'ai besoin d'aide ») rappelle le gros bouton rouge et envoie le même signal discret aux admins et à la famille que le compagnon IA (notification et entrée de journal). Quand l'IA du cercle est configurée et le compagnon activé, tout le reste (souvenirs, conversation) passe par le modèle, qui reçoit les mêmes faits du jour dans son prompt avec pour consigne de ne rien inventer au-delà, et toujours aucun conseil médical. Sans IA, le compagnon reste disponible pour les questions pratiques. `POST /api/companion/message` répond `{ reply, flagged, source: 'facts' | 'ai' | 'fallback', intent }`.

La dictée passe par le serveur Whisper auto-hébergé du cercle quand il est configuré (intégration `whisper`). À défaut, un aidant peut activer **« Dictée par le navigateur »** dans les réglages de l'écran patient : la reconnaissance vocale est alors celle du navigateur (Google, Apple ou Microsoft selon l'appareil), ce qui fait sortir la voix de votre serveur ; l'option est désactivée par défaut. Le clavier reste toujours disponible.

### Visiteurs

Le bouton **« Visiteur »** de l'écran patient permet à quiconque arrive de se signaler en deux gestes : type (famille, ami ou voisin, aide à domicile, infirmier, médecin, autre), prénom, arrivée notée. Le proche sait qui est là, la famille reçoit une notification (« Nadia est arrivée à 8 h ») et une entrée de journal de type visite est écrite au nom du visiteur. Un **professionnel** peut, depuis le même écran, lire les consignes du plan de soins, laisser une note de passage et confirmer les médicaments dus maintenant (la confirmation est alors à son nom), puis signaler son départ, sans jamais voir le reste des données du cercle. La page **Visiteurs** de l'app aidant liste les passages (durée, notes) ; un admin peut supprimer une visite erronée. Endpoints : `POST /api/kiosk/visits/check-in`, `POST /api/kiosk/visits/:id/note`, `POST /api/kiosk/visits/:id/check-out` (appareil ou membre), `GET /api/visits`, `DELETE /api/visits/:id` (membres).

Le bandeau d'accueil affiche les **photos de famille** de votre instance Immich quand l'option est activée (la clé API ne quitte jamais le serveur, les photos sont proxifiées par `/api/kiosk/photo`), sinon une image calme. La **météo** du jour apparaît quand un lieu est réglé.

### Identité de l'appareil, appairage et code aidant

La tablette et le téléphone n'ont **pas besoin de compte** : un aidant (admin ou famille) génère un code d'appairage à usage unique (15 minutes) depuis Réglages, section « Écran patient », affiché avec un QR code. L'appareil le saisit sur `/kiosk/pair` et reçoit un **token d'appareil** (table `kiosk_devices`) qui n'ouvre que les routes patient : `GET /api/kiosk/today`, `POST /api/kiosk/status`, `POST /api/kiosk/intakes/confirm`, `/api/kiosk/photo`, `/api/companion/message`, `/api/voice/transcribe` et ses propres réglages (`/api/kiosk/device/settings`). Tout le reste répond 401. Un appareil se détache depuis ses réglages ou se révoque depuis l'app aidant : son token meurt aussitôt. Les appareils rejoignent aussi le canal WebSocket de leur cercle : une prise confirmée sur la tablette s'affiche instantanément sur le téléphone, et inversement.

Le **code aidant (PIN, 4 à 8 chiffres)**, défini dans la même section, protège les réglages de l'écran et sa sortie, ce qui compte quand des visiteurs touchent la tablette. Il est stocké haché dans les réglages du cercle et vérifié par `POST /api/kiosk/pin/verify` (limité en débit).

Un membre du cercle connecté peut toujours ouvrir `/kiosk` avec sa session (usage historique). Contraintes d'accessibilité respectées : gros textes (taille réglable), contrastes AA, cibles tactiles larges.

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
| **Appareils patient** | La tablette et le téléphone du proche ont un token d'appareil (appairage par code à usage unique) qui n'atteint que les écrans patient, révocable à tout moment ; un code aidant protège les réglages et la sortie de l'écran |
| **En-têtes HTTP** | helmet, avec une CSP dédiée quand le serveur sert aussi le client (`SERVE_CLIENT_DIR`) |
| **Anti brute-force** | Rate limiting sur `/api/auth/login`, `/api/auth/register` et `/api/auth/forgot-password` (fenêtre et plafond configurables) |
| **Mot de passe oublié** | Jeton aléatoire de 256 bits, stocké haché (SHA-256), valable une heure, à usage unique ; réponse identique que le compte existe ou non ; sans SMTP, remise du lien par un administrateur du cercle ; toutes les sessions ouvertes sont fermées après le changement |
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
