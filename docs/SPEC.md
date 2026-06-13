# OpenCare : spécification produit et technique

OpenCare est une application auto-hébergée de coordination pour les aidants familiaux autour d'une personne âgée ou dépendante. Développée et offerte par NexaFlow sous licence AGPL-3.0, comme OpenFamily dont elle reprend le socle technique.

Deux publics :
- Les aidants (famille, professionnels, voisins) : usage mobile et desktop, vie active.
- La personne aidée : tablette kiosk au mur, lecture simple, deux gros boutons.

## 1. Socle technique (hérité d'OpenFamily)

- Monorepo npm workspaces : `client/` (React 19 + Vite + Tailwind + Radix + PWA), `server/` (Express + PostgreSQL + ws), `shared/` (types).
- Auth JWT + bcrypt, invitations par token, WebSocket temps réel (`server/src/lib/broadcaster.ts`).
- Abstraction IA multi-fournisseurs (`server/src/services/ai/`) : Ollama local, Anthropic, OpenAI-compatible. Clés chiffrées AES-256-GCM.
- Notifications internes + Web Push, planificateur node-cron (`reminderScheduler.ts`).
- i18n FR + EN (i18next), mode kiosk existant, installateur Windows Inno Setup (Node + PostgreSQL embarqués).

Modules OpenFamily supprimés car hors domaine : recettes, plans de repas, récompenses/points enfants.
Modules conservés et adaptés : tâches, calendrier/rendez-vous, courses (liste partagée), budget (refondu en partage de frais), notes, kiosk, paramètres, IA.

## 2. Modèle de données cible

Principe : tout est rattaché à un cercle de soin. Un cercle correspond à un proche aidé. Un utilisateur peut appartenir à plusieurs cercles (génération sandwich : deux parents = deux cercles), avec un rôle distinct dans chacun.

### Cercle et membres
- `care_circles` : id, name, created_by, settings JSONB.
- `care_recipients` : 1 par cercle. Identité, date de naissance, photo, adresse, médecin traitant, groupe sanguin, allergies, antécédents, directives anticipées, numéro de sécurité sociale, notes médicales.
- `circle_members` : circle_id, user_id, role, display_name, color. Rôles : `admin` (gère le cercle), `family` (fratrie, écrit partout), `professional` (écrit journal/constantes/médicaments), `neighbor` (écrit journal simple, lit calendrier), `viewer` (lecture seule).
- `circle_invites` : token, rôle pré-assigné, email optionnel, expiration.
- `caregiver_links` : liens magiques pour intervenants SANS compte (auxiliaire, infirmière). Token long, nom affiché, rôle, portée limitée (journal + lecture du jour), expiration optionnelle, accessible par URL/QR/SMS.

### Journal de liaison (cœur de l'app)
- `journal_entries` : circle_id, auteur (user OU caregiver_link), type (`visit`, `note`, `vital`, `medication`, `incident`, `mood`), texte, données structurées JSONB, photos, horodatage du passage, temps réel via WebSocket.
- `journal_photos` : fichiers liés à une entrée.

### Santé
- `vitals` : circle_id, type (`weight`, `bp`, `pain`, `mood`, `temperature`, `glucose`), valeur(s), unité, mesuré le, lien vers entrée de journal. Courbes dans le temps.
- `medications` : nom, posologie, forme, photo, prescripteur, début/fin, consignes, actif.
- `medication_schedules` : horaires de prise (matin/midi/soir/heures précises, jours).
- `medication_intakes` : occurrences générées, statut (`pending`, `taken`, `skipped`, `missed`), confirmé par qui, répercuté au journal.
- `prescriptions` : ordonnance (document lié), date de renouvellement, alerte avant échéance.

### Organisation
- `events` (calendrier) : titre, catégorie (`visit`, `medical`, `nurse`, `aide`, `other`), début/fin, récurrence (RRULE simple), participants (membres), rappels, lieu. Export iCal.
- `tasks` : titre, assigné à (membres), échéance, récurrence, statut, catégorie (courses, pharmacie, lessive, autre).
- `messages` : fil du cercle + messages directs entre membres, pièces jointes.
- `documents` : catégorie (ordonnance, compte-rendu, mutuelle, juridique, autre), fichier, uploadé par, lié au proche.
- `contacts` : carnet d'adresses du cercle (médecin traitant, SSIAD, kiné, voisine qui a la clé), catégorie, téléphones, notes.

### Frais partagés (différenciateur)
- `expenses` : payeur (membre), montant, catégorie (pharmacie, auxiliaire, travaux, autre), date, justificatif (document), répartition (égale ou parts personnalisées).
- `expense_settlements` : remboursements entre membres, calcul des soldes façon Tricount.
- `aid_records` : suivi des aides françaises (APA, crédit d'impôt, CESU) : montants perçus, périodes.

### Équité de la charge
Pas de table dédiée : statistiques calculées depuis `journal_entries` (visites par membre), `tasks` (tâches faites), `events` (présences). Affichage mensuel de la répartition.

### Wow
- `emergency_sheets` : fiche vitale générée (traitements actifs, allergies, contacts, directives), token public en lecture seule pour le QR du frigo, régénérée automatiquement.
- `recipient_story` : page « Qui je suis » (métier, fiertés, habitudes, ce qui l'apaise, musiques), sections éditables, montrée aux nouveaux intervenants.
- `presence_signals` : webhooks Home Assistant (capteur de porte, prise cafetière, mouvement), affichage « activité normale » et règles d'alerte (aucun signe de vie avant HH:MM, cascade vers la fratrie).
- `weekly_digests` : synthèse hebdo générée par l'IA chaque dimanche (résumé, signaux faibles), envoyée au cercle.
- `handover_packs` : mode relais vacances, pack de passation généré (planning, médicaments, consignes, contacts) avec période de validité.
- `kiosk_devices` : token par tablette, réglages (source photos Immich, météo, taille).
- Journal vocal : upload audio, transcription Whisper locale (serveur), rangement par l'IA (entrée journal + extraction d'items vers tâches/courses).
- Préparation de consultation : PDF généré (événements marquants, courbes, traitements, questions de la famille) depuis la dernière visite.

## 3. Permissions par rôle

| Action | admin | family | professional | neighbor | viewer | lien magique |
|---|---|---|---|---|---|---|
| Gérer cercle, membres, invitations | x | | | | | |
| Profil du proche, médicaments, documents | x | x | lecture + ajout doc | | lecture | |
| Journal : écrire | x | x | x | x | | x |
| Journal : lire tout | x | x | x | partiel | x | jour même |
| Calendrier : modifier | x | x | x (ses passages) | | | |
| Frais : saisir / régler | x | x | | | | |
| Messagerie | x | x | x | x | | |

## 4. Pages client

Aidants : Tableau de bord (par cercle, sélecteur multi-proches), Journal, Calendrier, Médicaments, Santé (courbes), Tâches + Courses, Messages, Frais, Documents, Contacts, Cercle (membres, invitations, liens magiques, équité), Profil du proche (+ Qui je suis, fiche urgence, mode relais), Paramètres, Intégrations (HA, Immich, Whisper, IA).

Sans compte : page lien magique (saisie journal simplifiée), fiche urgence QR (lecture publique par token), page d'invitation.

Kiosk : qui vient aujourd'hui (avec photo), rappels médicaments en gros, photos de famille (Immich), météo, boutons « Tout va bien » / « J'ai besoin d'aide » (alerte au cercle).

## 5. Contraintes transverses

- Design épuré et sobre, jamais criard, aucun em dash nulle part (code, UI, docs). Pas d'esthétique « néon IA ».
- Offline-first : PWA, file d'attente d'écriture (IndexedDB), synchronisation au retour du réseau. Doit marcher dans une chambre d'EHPAD sans réseau.
- Données chez soi : self-hosted, chiffrement au repos des secrets, export complet (dataTransfer existant à adapter).
- Accessibilité : gros textes sur le kiosk, contrastes AA minimum, cibles tactiles larges.
- i18n FR + EN complet.
- Installateur Windows Inno Setup identique à OpenFamily, rebrandé OpenCare.

## 6. Phases de développement

1. Rebranding + nettoyage : OpenFamily vers OpenCare partout, suppression recettes/repas/récompenses, nouveau design system.
2. Cercles de soin : tables, rôles, invitations, multi-cercles, profil du proche.
3. Journal de liaison temps réel + santé/constantes.
4. Médicaments + rappels + confirmation.
5. Calendrier (récurrences, iCal) + tâches/courses.
6. Messagerie, documents, contacts.
7. Frais partagés + équité de charge.
8. Liens magiques intervenants + PDF consultation.
9. Kiosk OpenCare + fiche urgence QR + Qui je suis + mode relais.
10. Intégrations : Home Assistant (veille passive), Whisper (journal vocal), synthèse hebdo IA, Immich.
11. Offline-first + installateur Windows.
