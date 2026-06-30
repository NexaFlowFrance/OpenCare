<div align="center">
  <img src="client/public/OpenCare.png" alt="OpenCare" width="90">
  <h1>OpenCare</h1>
  <p><strong>L'application open source et auto-hébergée de coordination des aidants familiaux</strong><br>
  Coordonnez le cercle autour d'un proche âgé. Sur votre serveur, avec vos données.</p>

  🇬🇧 <a href="README.md">English</a> · 🇫🇷 <strong>Français</strong>

  [![Release](https://img.shields.io/github/v/release/NexaFlowFrance/OpenCare?color=3E6B54&label=version)](https://github.com/NexaFlowFrance/OpenCare/releases/latest)
  [![CI](https://img.shields.io/github/actions/workflow/status/NexaFlowFrance/OpenCare/ci.yml?branch=main&label=CI)](https://github.com/NexaFlowFrance/OpenCare/actions/workflows/ci.yml)
  [![Licence : AGPL v3](https://img.shields.io/badge/Licence-AGPL--v3-blue.svg)](licence.md)
  [![PWA](https://img.shields.io/badge/PWA-ready-3E6B54)](https://github.com/NexaFlowFrance/OpenCare)
</div>

---

OpenCare est une **alternative auto-hébergée aux applications d'aidants comme Jointly ou CaringBridge** :
un cercle de soin autour de chaque proche aidé, un journal de liaison en temps réel, les médicaments et
leurs rappels, un calendrier partagé, le partage des frais entre la fratrie, et des outils que personne
d'autre ne propose : des liens magiques pour que les professionnels écrivent sans compte, une fiche
urgence en QR sur le frigo, une tablette murale pour la personne aidée. Le tout sur **votre** serveur :
les données de santé d'une personne vulnérable n'ont rien à faire sur le cloud de quelqu'un d'autre.

## ✨ Fonctionnalités

### Le socle

| | |
|---|---|
| 👥 **Cercle de soin** | Un cercle par proche aidé, invitation par lien, rôles fins (famille, professionnel, voisin, lecture seule). Multi-proches dès le départ : suivez vos deux parents, ou reliez deux cercles en **foyer** (un couple) avec un tableau de bord combiné |
| 📔 **Journal de liaison** | Le cahier de transmission numérique : entrées horodatées avec photos, en temps réel sur tous les appareils. Le cœur de l'application |
| 💊 **Médicaments** | Traitements et horaires, confirmation de prise reportée au journal, alertes de renouvellement d'ordonnance |
| 📅 **Calendrier partagé** | Visites, rendez-vous médicaux, passages infirmière, récurrences, rappels, export iCal (.ics / webcal) |
| ❤️ **Suivi santé** | Constantes saisies à la main (poids, tension, douleur, moral, température, glycémie), courbes dans le temps |
| ✅ **Tâches et courses** | Le « qui fait quoi cette semaine », et une liste de courses partagée que l'auxiliaire peut utiliser |
| 💬 **Messagerie** | Fil du cercle et messages directs, pièces jointes |
| 📁 **Documents et contacts** | Ordonnances, comptes-rendus, mutuelle, jugement de tutelle ; le carnet d'adresses du cercle (médecin traitant, SSIAD, la voisine qui a la clé) |

### Ce que les applications payantes n'ont pas

| | |
|---|---|
| 💶 **Frais partagés** | Un Tricount intégré : qui a avancé quoi, soldes, règlements suggérés, et le suivi des aides françaises (APA, CESU, crédit d'impôt) |
| ⚖️ **Équité de la charge** | « Marie a assuré 78 % des visites ce mois-ci » : des chiffres objectifs pour prévenir l'épuisement de l'aidant principal |
| 🔗 **Liens magiques** | L'auxiliaire de vie ou l'infirmière écrit dans le journal depuis un simple lien (SMS/QR), sans compte ni application |
| 🩺 **Préparation de consultation** | En un clic, un document imprimable pour le médecin : événements marquants, évolution des constantes, traitements, questions de la famille |
| 🖥️ **Kiosk** | Une tablette au mur chez le proche : qui vient aujourd'hui (avec photo), rappels de médicaments en gros, météo, et deux gros boutons : « Tout va bien » / « J'ai besoin d'aide » |
| 🚨 **Fiche urgence QR** | Un QR imprimé sur le frigo : les pompiers et le SAMU scannent et voient la fiche vitale (traitements, allergies, directives, contacts), toujours à jour |
| 📖 **« Qui je suis »** | Une page récit de vie (métier, fiertés, habitudes, ce qui l'apaise) montrée à tout nouvel intervenant, inspirée du « This is me » de l'Alzheimer's Society |
| 🧳 **Mode relais** | L'aidant principal part une semaine : un pack de passation auto-généré (planning, médicaments, consignes, contacts) partagé par lien |
| 🏠 **Veille passive** | Webhooks Home Assistant (capteur de porte, prise de la cafetière, mouvement) : « activité normale ce matin » sur le tableau de bord, cascade d'alertes si aucun signe de vie. Ni caméra, ni bracelet |
| 🎙️ **Journal vocal** | Dictez en sortant (« passage de 20 minutes, RAS, prévoir du paracétamol ») : votre Whisper auto-hébergé transcrit, l'IA range l'entrée au journal et le paracétamol dans les courses |
| 🤖 **Synthèse hebdo IA** | Chaque dimanche : « Semaine calme. 5 visites. Tension stable. Point d'attention : 2 prises oubliées mardi et jeudi. » Avec détection des signaux faibles (moral en baisse, perte de poids lente) |
| 🌡️ **Veille canicule** | Déclarez un épisode de forte chaleur en un geste : checklist de prévention sur le tableau de bord et le kiosk, rappels d'hydratation aux aidants aux heures choisies, et un bouton « J'ai bu de l'eau » sur le kiosk |
| 🗣️ **Compagnon IA** | Un compagnon vocal optionnel avec qui le proche discute depuis le kiosk : réminiscence douce à partir de la page « Qui je suis », parole en entrée (votre Whisper) et lecture à voix haute. Garde-fous stricts (jamais de conseil médical, alerte le cercle en cas de détresse). Local d'abord avec Ollama, ou votre propre clé cloud |

### Chez vous, pour de bon

- **Auto-hébergé** : Docker, ou un **installateur Windows en un clic** (Node.js et PostgreSQL embarqués)
- **PWA tolérante au hors-ligne** : fonctionne dans une chambre d'EHPAD sans réseau
- **IA locale d'abord** : Ollama sur votre machine, ou votre propre clé Anthropic / compatible OpenAI, chiffrée au repos
- **Export complet** des données du cercle, licence **AGPL-3.0**
- Interface **français et anglais**

## 🚀 Démarrage rapide

### 🪟 Installateur Windows (.exe)

Pour Windows, **NexaFlow** fournit un installateur graphique tout-en-un : Node.js et PostgreSQL
sont embarqués, sans Docker ni configuration.

Téléchargez `OpenCare-Setup.exe` depuis la [dernière version](https://github.com/NexaFlowFrance/OpenCare/releases/latest),
lancez-le, cliquez sur **Démarrer** : l'application s'ouvre sur http://localhost:3000. La fenêtre
affiche aussi votre adresse réseau locale pour que le reste de la famille s'y connecte depuis
un téléphone sur le même Wi-Fi.

### 🐳 Docker (recommandé pour un serveur)

```bash
cp .env.example .env   # définissez POSTGRES_PASSWORD et JWT_SECRET
docker-compose up -d --build
```

- Interface : http://localhost:3000
- API : http://localhost:3001

### 🛠️ Développement

Sous Windows, le plus simple ne demande pas Docker : le script démarre le
PostgreSQL embarqué, écrit un `.env` de dev, puis lance l'application.

```powershell
npm install
powershell -ExecutionPolicy Bypass -File scripts\dev-windows.ps1
```

Sous macOS ou Linux (ou Windows avec Docker) :

```bash
npm install
docker-compose up -d postgres   # ou tout PostgreSQL 14+
cp .env.example .env            # definir JWT_SECRET (32+ caracteres) et POSTGRES_PASSWORD
npm run dev
```

- Interface : http://localhost:5173 · API : http://localhost:3001

Le schéma de base de données s'installe tout seul au premier démarrage : aucune étape SQL manuelle. Un fichier `.env` à la racine est requis pour `npm run dev` (le script ci-dessus le crée pour vous sous Windows).

## 🆚 Pourquoi OpenCare ?

|  | OpenCare | Jointly / CaringBridge |
|---|---|---|
| Vos données sur votre serveur | ✅ | ❌ |
| Open source (AGPL-3.0) | ✅ | ❌ |
| Gratuit, sans abonnement | ✅ | ⚠️ |
| Les intervenants écrivent sans compte (lien magique) | ✅ | ❌ |
| Frais partagés et équité de la charge | ✅ | ❌ |
| Kiosk pour la personne aidée | ✅ | ❌ |
| Veille passive via Home Assistant | ✅ | ❌ |

## 🧰 Pile technique

**Frontend** : React 19 · TypeScript · Vite 7 · TailwindCSS · Radix UI · i18next · PWA (service worker, web push, hors-ligne)
**Backend** : Node.js 20 · Express · PostgreSQL 14+ (schéma auto-installé) · WebSocket · Web Push (VAPID) · JWT + bcrypt 12 · helmet · rate limiting
**DevOps** : Docker Compose · GitHub Actions · Installateur Windows Inno Setup

## 🔐 Sécurité

Authentification JWT (7 jours) · mots de passe hachés **bcrypt (coût 12)** · vérification du rôle
par cercle sur chaque requête · en-têtes HTTP sécurisés via **helmet** · rate limiting sur
l'authentification · CORS strict configurable · validation des entrées côté serveur · clés IA
chiffrées au repos (AES-256-GCM) · journaux structurés.

## 🤝 Contribuer

Les contributions sont bienvenues ! La spécification produit vit dans [docs/SPEC.md](docs/SPEC.md).
Ouvrez une [issue](https://github.com/NexaFlowFrance/OpenCare/issues) ou une
[pull request](https://github.com/NexaFlowFrance/OpenCare/pulls).

## 📄 Licence

GNU Affero General Public License v3.0 (AGPL-3.0-only), voir [licence.md](licence.md).

## 🙏 Crédits

Développé et maintenu par [NexaFlow France](https://nexaflow.fr), et offert à toutes les familles
qui prennent soin de quelqu'un.
