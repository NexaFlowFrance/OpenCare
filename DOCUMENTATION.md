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
- `escalationScheduler` : escalade des prises en retard et des demandes d'aide sans prise en charge (chaque minute, cercles ayant activé les règles).

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
- `GET / POST /api/calendar/token` puis `GET /api/calendar/feed/:token.ics` (public) : export iCal (.ics / webcal). Le lien affiché dans l'agenda vise l'adresse de l'API (`VITE_API_URL`), et celle de la page seulement quand l'API est à la même origine : sur une installation à deux domaines, l'adresse de la page renverrait l'app en HTML et l'agenda resterait vide.

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
- `GET /api/presence/status`, `GET /api/presence/signals` : « activité normale » sur le tableau de bord. Le bouton « Tout va bien » du mode Kiosk enregistre aussi un signal de présence (source `kiosk`) : appuyer dessus suffit à lever l'alerte « aucun signe de vie ».
- `PUT /api/presence/rule`, `POST /api/presence/webhook-token` (admin) : règles d'alerte et rotation du token.

### Journal vocal (`/api/voice`)

- `POST /api/voice/transcribe` : transcription de l'audio par votre Whisper auto-hébergé.
- `POST /api/voice/journal` : rangement par l'IA (entrée de journal + extraction d'items vers tâches et courses).

### Synthèses et statistiques (`/api/digests`, `/api/insights`, `/api/dashboard`)

- `GET /api/digests`, `POST /api/digests/generate` : synthèse hebdo IA (résumé, signaux faibles).
- `GET /api/insights/equity` : équité de la charge (visites, tâches, présences par membre).
- `GET /api/insights/consultation` : préparation de consultation (événements marquants, courbes, traitements, questions) prête à imprimer.
- `GET /api/dashboard` : agrégation du tableau de bord. Le champ `attention` (« À traiter ») liste, par gravité, ce qu'un aidant doit regarder en premier : signaux d'alerte des dernières 24 h (bouton d'aide, compagnon), aucun signe de vie avant l'heure limite de la veille passive, prises manquées, ordonnances à renouveler, tâches en retard, visiteur sur place, rendez-vous dans les deux heures, constantes hors de la plage définie et médicaments bientôt épuisés. Les éléments de santé sont omis pour le rôle voisin.

### Kiosk (`/api/kiosk`)

- `POST /api/kiosk/status` : les deux gros boutons (« ok » et « help »).
- `GET /api/kiosk/today` : qui vient aujourd'hui, prises du jour (avec photo, quantité et consignes), et la vue patient `medications` : uniquement ce qui est **à prendre maintenant** (`due_now`), le reste résumé (`upcoming_count`, `next_due_at`, `taken_count`). Les prises du jour sont générées à l'appel, même si personne n'a ouvert l'application aidant.
- `POST /api/kiosk/intakes/confirm` : « J'ai tout pris » depuis le kiosk ou le téléphone du patient (`intake_ids`, `source`), attribué au proche dans le journal avec la source conservée.

### Plan de soins (`/api/care-plan`)

Une page qui rassemble ce qu'il faut savoir pour prendre soin du proche, sans dupliquer : huit **consignes** rédigées par la famille (routine du matin, repas, aide à la mobilité, toilette et soins personnels, communication, ce qui contrarie, ce qui apaise, en cas d'urgence ; table `care_plans`, 4 000 caractères par section, mise à jour partielle par `PUT /api/care-plan` pour admin et famille), puis la **routine médicamenteuse** calculée depuis les traitements actifs et leurs horaires (matin, midi, soir, coucher, plus « si besoin » ; omise pour le rôle voisin), les **professionnels réguliers** (contacts médecin, infirmier, aide à domicile, kiné, pharmacie) et la **semaine à venir** (agenda sur sept jours, occurrences récurrentes comprises). Chaque bloc renvoie vers sa page. La page s'imprime. Les consignes alimentent aussi le pack de relais (`content.care_plan`) et le mode Kiosk : un visiteur professionnel peut les lire pendant sa visite (`GET /api/kiosk/care-plan`, sections non vides seulement).

### Alertes et escalade (`/api/escalation`)

Chaque famille choisit son niveau de surveillance (Paramètres, section « Alertes et escalade », administrateurs ; table `escalation_rules`, désactivée par défaut).

- **Prise de médicament en retard** : rappel au proche sur le Kiosk après N minutes (écran calme, lu à voix haute, un seul bouton « J'ai tout pris »), puis notification aux **aidants principaux**, puis aux **aidants de relais**. Chaque palier a son délai en minutes ; 0 désactive le palier. Au-delà de quatre heures la prise est marquée manquée et l'escalade s'arrête.
- **Bouton « J'ai besoin d'aide »** : les aidants principaux sont prévenus immédiatement et la demande est tracée (table `help_requests`). Sans prise en charge (« Je m'en occupe » depuis le bloc « À traiter » du tableau de bord, `POST /api/escalation/help/:id/ack`), les aidants de relais sont prévenus après N minutes.
- Sans sélection, les aidants principaux sont les **administrateurs** du cercle et les aidants de relais les membres **famille**.
- Endpoints : `GET /api/escalation/rules` (tout membre), `PUT /api/escalation/rules` (admin), `GET /api/escalation/help`, `POST /api/escalation/help/:id/ack`.

### Occurrences d'un événement récurrent

Une série récurrente n'a plus besoin d'être cassée pour une exception : `PUT /api/events/:id/occurrences/:date` **saute** (`{"action":"skip"}`) ou **déplace** (`{"action":"move","start_time":"...","end_time":"..."}`) une seule occurrence, et `DELETE` sur la même adresse la remet à sa place. La date de l'URL est le jour d'origine de l'occurrence (`YYYY-MM-DD`), qui reste son identité même après un déplacement. Un déplacement est limité à sept jours autour de ce jour. Les exceptions vivent dans la colonne `events.exceptions` (JSONB), donc tout ce qui lit déjà un événement en hérite sans requête supplémentaire : agenda, tableau de bord, mode Kiosk, plan de soins, pack de relais et export iCal.

### Stock de médicaments

Chaque traitement peut suivre sa **réserve restante** et un **seuil de renouvellement**, exprimés dans l'unité d'une prise (`PUT /api/medications/:id/stock`, admin et famille). La réserve baisse toute seule quand une prise est confirmée et remonte si la confirmation est annulée ; un stock non suivi (`NULL`) ne devient jamais un nombre tout seul. Sous le seuil, le médicament remonte dans « À traiter » avec le nombre de doses restantes.

### Seuils sur les constantes

La famille peut fixer une **plage normale** par type de constante (`GET` et `PUT /api/vitals/thresholds`, admin et famille ; la tension utilise les deux bornes, systolique et diastolique). Une mesure hors de cette plage déclenche une notification aux admins et à la famille, et apparaît dans « À traiter » pendant sept jours.

### Messages non lus

Le compteur de messages non lus est réel : `GET /api/messages/unread` renvoie le total, le fil du cercle et le détail par conversation privée, et `POST /api/messages/read` marque un fil comme lu (table `message_reads`, une ligne par fil et par utilisateur). Un message compte comme non lu tant qu'il est postérieur à la dernière lecture du fil et qu'il vient de quelqu'un d'autre.

### Langues et accessibilité

L'interface existe en **français, anglais et espagnol**. Les langues sont découvertes depuis les dossiers de `client/src/i18n/locales/` : déposer un dossier `<code>/` suffit pour qu'une langue apparaisse dans le sélecteur, et une traduction partielle retombe sur l'anglais clé par clé. L'attribut `lang` du document suit la langue choisie, pour que les lecteurs d'écran prononcent correctement.

Le serveur parle les mêmes trois langues pour tout ce qu'il écrit lui-même : messages d'erreur, notifications et push (rappels, mesure hors plage, visites, escalade, absence de signe de vie), e-mail de mot de passe oublié, réponses du compagnon « Demandez-moi » et synthèse hebdomadaire. Chaque membre reçoit ses notifications dans la langue de son compte, que le client enregistre par `PUT /api/auth/language` (`fr`, `en` ou `es`). Le mode Kiosk suit la langue réglée sur la tablette, y compris pour la voix de synthèse et la dictée. La synthèse hebdomadaire, écrite une fois pour tout le cercle, prend la langue la plus fréquente chez les administrateurs et la famille, celle du créateur du cercle en cas d'égalité.

Côté serveur, les messages vivent dans `server/src/lib/i18n.ts`, dont un test vérifie que les trois langues ont les mêmes clés et les mêmes variables. Les phrases construites dans le code passent par `pick(lang, { fr, en, es })`, dont le type impose les trois variantes : ajouter une langue fera échouer la compilation à chaque phrase oubliée, au lieu de retomber en silence sur le français.

Côté accessibilité : un lien d'évitement mène directement au contenu dès la première tabulation, les deux barres de navigation sont nommées et la page courante porte `aria-current`, le contenu principal est un repère `main` focalisable, les boutons de langue annoncent le nom de la langue et non son code, et les boîtes de dialogue se ferment à l'échappement en rendant le focus. Les états importants ne passent jamais par la seule couleur : une mesure hors plage, un stock bas ou un message non lu portent aussi un texte lisible par un lecteur d'écran.

### Fuseau horaire

Les horodatages d'OpenCare sont des heures locales sans fuseau : « 8 h », c'est 8 h chez le proche, quoi qu'en pense le serveur. Deux choses les écrivent, le serveur applicatif quand il envoie une date, et PostgreSQL quand il remplit un `CURRENT_TIMESTAMP`. Si les deux ne sont pas dans le même fuseau, une même journée affiche des heures décalées de quelques heures selon la ligne.

Réglez donc **un seul** fuseau, celui du proche, dans `.env` :

```
TZ=Europe/Paris
```

Il sert à tout : le serveur, les planificateurs (rappels de rendez-vous, veille passive, synthèse hebdomadaire) et, depuis la connexion, la session PostgreSQL, qui s'aligne automatiquement sur le fuseau du serveur. Aucune commande n'est à passer sur la base, et il n'y a rien à reconfigurer si vous changez d'avis : redémarrez le serveur, les nouvelles connexions suivent.

Deux précisions utiles :

- **Docker** : `TZ` est transmis au conteneur du serveur par `docker-compose.yml`. Sans valeur, tout reste en UTC, comme avant.
- **Windows** : Node ignore la variable `TZ` sur ce système. L'installateur utilise donc le fuseau de la machine, et la base s'aligne dessus, ce qui donne le bon résultat tant que la machine est à l'heure du proche.

Les horodatages déjà enregistrés ne sont pas réécrits : changer de fuseau ne corrige pas le passé, il aligne la suite.

### Sauvegarde et restauration

Tout vit dans PostgreSQL : le journal, les photos, les documents, les médicaments. Sauvegarder la base, c'est donc tout sauvegarder.

```bash
bash scripts/backup.sh                  # pile Docker, écrit dans ./backups
bash scripts/backup.sh --dir /mnt/nas   # ailleurs, disque externe ou NAS
bash scripts/backup.sh --keep 30        # ne garde que les 30 plus récentes
bash scripts/backup.sh --direct         # PostgreSQL local, sans Docker
```

Le fichier est un `pg_dump` compressé, nommé par sa date, écrit en 600. Il n'apparaît qu'une fois vérifié : un dump vide ou tronqué est supprimé plutôt que publié, parce qu'une sauvegarde à laquelle on ne peut pas se fier est pire que pas de sauvegarde. Une ligne de cron suffit à l'automatiser :

```
30 3 * * * cd /opt/opencare && bash scripts/backup.sh --keep 30 >> /var/log/opencare-backup.log 2>&1
```

Copiez ces fichiers **hors de la machine**. Une sauvegarde qui vit sur le disque qui lâche ne sauve personne.

Pour restaurer, arrêtez d'abord le serveur applicatif (`docker compose stop server`) :

```bash
bash scripts/restore.sh backups/opencare-20260925-093000.sql.gz
```

La restauration demande une confirmation explicite, vérifie que le fichier ressemble bien à une sauvegarde OpenCare, et prend une sauvegarde de sécurité de l'état actuel avant de l'écraser. L'export JSON par cercle des Paramètres reste disponible pour un besoin plus fin : emporter un cercle, pas toute l'instance.

### Tests

`npm test` lance les tests unitaires (Vitest, dossier `tests/`) : fenêtres de prise de la vue patient, récurrences et leurs exceptions, validation des règles d'escalade et des consignes du plan de soins, réponses du compagnon, et cohérence des traductions dans toutes les langues. Ils ne touchent pas la base et tournent en quelques secondes. Le parcours complet avec PostgreSQL est couvert par `npm run smoke:api`, joué en intégration continue sur la pile Docker.

### Unités de mesure

Un cercle choisit son système dans les Paramètres, carte **Langue et région**, section **Unités** (admins) : métrique ou impérial. Le poids passe des kilos aux livres, la température des degrés Celsius aux Fahrenheit, la glycémie des g/L aux mg/dL. La tension reste en mmHg dans les deux cas, la douleur et le moral sur dix.

Les mesures sont **toujours enregistrées en métrique**, quel que soit le système choisi : le réglage ne change que la saisie et l'affichage. Il s'applique partout où une mesure est montrée : pages Santé et Journal, tableau de bord (dernières mesures et carte « à surveiller »), préparation de consultation, alertes hors plage (notification et push), synthèse hebdomadaire de l'IA, et météo du mode Kiosk (°F ou °C). Côté serveur, `server/src/lib/units.ts` reprend la conversion d'affichage du client ; un test vérifie que les deux donnent le même résultat. Changer d'avis convertit donc l'historique entier à l'écran, sans migration, sans arrondi cumulé et sans perte. Les seuils d'alerte suivent la même règle. La conversion vit dans `client/src/lib/units.ts` et est couverte par des tests d'aller-retour.

Le réglage est stocké dans `care_circles.settings`, à côté de secrets qui ne doivent jamais sortir du serveur. `GET /api/circles` et `GET /api/circles/:id` ne renvoient donc que les **clés publiques** de ce JSONB, et `PUT /api/circles/:id` **fusionne** les réglages fournis après validation au lieu de remplacer l'objet : enregistrer une préférence n'efface plus le code aidant du mode Kiosk, et l'empreinte de ce code ne circule plus dans une réponse d'API.

### Premier jour de la semaine

Dans la même carte **Langue et région**, les admins choisissent le premier jour de la semaine du cercle : **lundi** (par défaut) ou **dimanche**. Le calendrier commence sa grille ce jour-là, et les choix de jours (récurrence d'un événement, jours d'un traitement) suivent le même ordre. C'est un réglage d'affichage seulement : les jours restent enregistrés en ISO (lundi = 1) et les récurrences en `BYDAY=MO,...`, donc changer d'avis ne touche aucune donnée. La clé `week_start` fait partie des clés publiques de `care_circles.settings`, validée comme `unit_system`. L'ordre vit dans `client/src/lib/weekStart.ts`, couvert par des tests.

Une exception assumée : la synthèse hebdomadaire couvre toujours lundi à dimanche, quel que soit le réglage. C'est une période de rapport, pas une grille de calendrier, et déplacer ses bornes couperait la semaine en deux au moment du changement. Un cercle réglé sur dimanche voit donc son calendrier commencer le dimanche, et reçoit toujours le récapitulatif de la semaine écoulée du lundi au dimanche.

### Numéros d'urgence de l'affiche

L'affiche imprimable de la fiche urgence porte une ligne de numéros d'urgence, précédée de « Appelez : » dans la langue de l'interface. Les admins la saisissent dans la carte **Langue et région**, section **Numéros d'urgence** : texte libre sur une ligne, 80 caractères au plus (« 911 », « SAMU 15, Pompiers 18, 112 »). Sans saisie, un cercle francophone garde l'affiche d'origine (SAMU 15, Pompiers 18) ; dans une autre langue, l'affiche n'imprime aucun numéro plutôt qu'un numéro d'un autre pays, et la fiche le rappelle à côté du bouton d'impression. La clé `emergency_numbers` fait partie des clés publiques de `care_circles.settings` (`null` efface le réglage). Le repli vit dans `client/src/lib/emergencyNumbers.ts`, couvert par des tests.

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

Le « partiel » du voisin a deux bornes, appliquées partout où le journal est lu (`/api/journal`, le tableau de bord) : les 7 derniers jours, et jamais les entrées de santé, c'est-à-dire les mesures (`vital`), les prises (`medication`) et les incidents (`incident`), dont le texte peut décrire une douleur ou une chute. Un voisin ne lit pas non plus la synthèse hebdomadaire, écrite à partir de ces données. Il voit qu'une demande d'aide est en cours dans « À traiter », sans le détail.

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

La page `/kiosk` (alias `/myday`) est l'**mode Kiosk** : un mode plein écran sans menu, pour la tablette fixée au mur chez le proche et, à l'identique, pour son téléphone (mode poche). Il répond à quatre questions seulement :

- **Qu'est-ce que je dois faire maintenant ?** Uniquement les médicaments dus maintenant, avec photo, nom, dosage et « Prends 2 comprimés », puis un seul bouton « J'ai tout pris ». Les prises futures ne sont pas montrées (« Prochaine prise à 20 h »), les prises manquées restent côté aidant.
- **Qui vient aujourd'hui ?** Les visites du jour avec la photo et le rôle des membres, ou l'infirmière et l'aide à domicile.
- **Est-ce que j'ai un rendez-vous ?** Les rendez-vous médicaux du jour, avec l'heure et le lieu.
- **Urgences** : un bouton rouge dans la barre du haut ouvre la **fiche urgence** en grand, à montrer aux secours qui arrivent chez le proche : identité, âge, groupe sanguin, allergies en rouge, traitements en cours, antécédents, directives anticipées et qui appeler. Un QR code à côté permet au secouriste de l'emporter dans son téléphone. Ce QR contient la fiche dans le fragment de son URL, il s'ouvre donc hors ligne, dans l'ambulance, sans exposer OpenCare. `GET /api/kiosk/emergency`, accessible à un appareil appairé comme à un membre : c'est la même fiche que le QR du frigo.
- **Comment demander ?** « Demandez-moi » (réponses sur la journée, puis compagnon de conversation), « Mes informations » (nom, adresse, téléphone, médecin, pharmacie, infirmière, aide à domicile), et les deux gros boutons « Tout va bien » (entrée de journal de type humeur) et « J'ai besoin d'aide » (entrée incident + notification urgente, y compris Web Push, à tout le cercle).

### Demandez-moi

Le bouton **« Demandez-moi »** répond d'abord avec les données du cercle, sans IA : « Qu'est-ce que je dois prendre ? » (les prises dues maintenant, avec la quantité), « Qui vient aujourd'hui ? » (visites prévues à l'agenda et visiteurs signalés sur l'écran), « Mes rendez-vous ? », « Quel jour sommes-nous ? », « Qui puis-je appeler ? » (médecin, pharmacie, infirmier, aide à domicile), la canicule. Les questions sont reconnues par mots-clés en français et en anglais, proposées en boutons rapides, et les réponses sont lues à voix haute par le navigateur. Une demande d'aide (« au secours », « j'ai besoin d'aide ») rappelle le gros bouton rouge et envoie le même signal discret aux admins et à la famille que le compagnon IA (notification et entrée de journal). Quand l'IA du cercle est configurée et le compagnon activé, tout le reste (souvenirs, conversation) passe par le modèle, qui reçoit les mêmes faits du jour dans son prompt avec pour consigne de ne rien inventer au-delà, et toujours aucun conseil médical. Sans IA, le compagnon reste disponible pour les questions pratiques. `POST /api/companion/message` répond `{ reply, flagged, source: 'facts' | 'ai' | 'fallback', intent }`.

La dictée passe par le serveur Whisper auto-hébergé du cercle quand il est configuré (intégration `whisper`). À défaut, un aidant peut activer **« Dictée par le navigateur »** dans les réglages du mode Kiosk : la reconnaissance vocale est alors celle du navigateur (Google, Apple ou Microsoft selon l'appareil), ce qui fait sortir la voix de votre serveur ; l'option est désactivée par défaut. Le clavier reste toujours disponible.

### Visiteurs

Le bouton **« Visiteur »** du mode Kiosk permet à quiconque arrive de se signaler en deux gestes : type (famille, ami ou voisin, aide à domicile, infirmier, médecin, autre), prénom, arrivée notée. Le proche sait qui est là, la famille reçoit une notification (« Nadia est arrivée à 8 h ») et une entrée de journal de type visite est écrite au nom du visiteur. Un **professionnel** peut, depuis le même écran, lire les consignes du plan de soins, laisser une note de passage et confirmer les médicaments dus maintenant (la confirmation est alors à son nom), puis signaler son départ, sans jamais voir le reste des données du cercle. La page **Visiteurs** de l'app aidant liste les passages (durée, notes) ; un admin peut supprimer une visite erronée. Endpoints : `POST /api/kiosk/visits/check-in`, `POST /api/kiosk/visits/:id/note`, `POST /api/kiosk/visits/:id/check-out` (appareil ou membre), `GET /api/visits`, `DELETE /api/visits/:id` (membres).

En **plein écran**, le mode Kiosk occupe toute la largeur de la dalle : une tablette murale ou un téléviseur n'a pas à garder des marges vides. Hors plein écran, la largeur reste bornée pour rester lisible dans une fenêtre de navigateur.

Le bandeau d'accueil affiche les **photos de famille** de votre instance Immich quand l'option est activée (la clé API ne quitte jamais le serveur, les photos sont proxifiées par `/api/kiosk/photo`), sinon une image calme. La **météo** du jour apparaît quand un lieu est réglé.

### Identité de l'appareil, appairage et code aidant

La tablette et le téléphone n'ont **pas besoin de compte** : un aidant (admin ou famille) génère un code d'appairage à usage unique (15 minutes) depuis Réglages, section « Mode Kiosk », affiché avec un QR code. L'appareil le saisit sur `/kiosk/pair` et reçoit un **token d'appareil** (table `kiosk_devices`) qui n'ouvre que les routes patient : `GET /api/kiosk/today`, `POST /api/kiosk/status`, `POST /api/kiosk/intakes/confirm`, `/api/kiosk/photo`, `/api/companion/message`, `/api/voice/transcribe` et ses propres réglages (`/api/kiosk/device/settings`). Tout le reste répond 401. Un appareil se détache depuis ses réglages ou se révoque depuis l'app aidant : son token meurt aussitôt. Les appareils rejoignent aussi le canal WebSocket de leur cercle : une prise confirmée sur la tablette s'affiche instantanément sur le téléphone, et inversement.

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
| **En-têtes HTTP** | helmet, avec une CSP dédiée quand le serveur sert aussi le client (`SERVE_CLIENT_DIR`) ; le nginx de l'image Docker du client envoie la même politique (`client/nginx.conf`), seul `connect-src` y est élargi parce que l'adresse de l'API (`VITE_API_URL`) n'y est pas connue |
| **Anti brute-force** | Rate limiting sur `/api/auth/login`, `/api/auth/register` et `/api/auth/forgot-password` (fenêtre et plafond configurables) |
| **Mot de passe oublié** | Jeton aléatoire de 256 bits, stocké haché (SHA-256), valable une heure, à usage unique ; réponse identique que le compte existe ou non ; sans SMTP, remise du lien par un administrateur du cercle ; toutes les sessions ouvertes sont fermées après le changement |
| **CORS** | Origines strictes configurables (`CORS_ORIGINS`) |
| **Secrets** | Clés IA et identifiants d'intégrations chiffrés au repos (AES-256-GCM), jamais renvoyés au navigateur |
| **Fichiers et import** | Documents, photos et pièces jointes sont des data URL en base, limitées aux images matricielles et au PDF (pas de SVG). L'import (`/api/data/import`) applique exactement les mêmes règles (`server/src/lib/dataUrls.ts`) et n'attribue un contenu qu'à un membre du cercle importé |
| **Fiche urgence en direct** | Désactivée par défaut ; son jeton n'est remis qu'aux admins et à la famille, les rôles qui peuvent l'activer |
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
