# Guide d'installation OpenCare

Ce guide couvre :
- l'installateur Windows tout-en-un
- un déploiement Docker (recommandé pour un serveur)
- une installation manuelle (développement), y compris sous Windows sans Docker
- la mise derrière un reverse proxy
- les sauvegardes

Dans tous les cas, **le schéma de base de données s'installe tout seul au premier démarrage du serveur** (et les migrations suivantes s'appliquent automatiquement à chaque démarrage) : aucune commande `psql -f` n'est nécessaire.

## Prérequis

- Docker + Docker Compose (voie Docker), ou Node.js 20+ / npm 10+ et un PostgreSQL 14+ (voie manuelle)
- Rien du tout pour l'installateur Windows : Node.js et PostgreSQL sont embarqués
- `curl` + `jq` pour les smoke tests API (optionnel)

## 1) Installateur Windows (.exe)

Téléchargez `OpenCare-Setup.exe` depuis la [dernière release](https://github.com/NexaFlowFrance/OpenCare/releases/latest) et laissez-vous guider. Node.js et PostgreSQL sont embarqués : aucun Docker, aucune configuration.

Une fenêtre s'ouvre avec trois boutons (Démarrer, Arrêter, Ouvrir). L'application est servie sur `http://localhost:3000` et la fenêtre affiche aussi l'adresse réseau locale pour que le reste de la famille s'y connecte depuis un téléphone sur le même Wi-Fi.

## 2) Démarrage rapide Docker (recommandé pour un serveur)

```bash
cp .env.example .env
# définissez au minimum POSTGRES_PASSWORD et JWT_SECRET (32 caractères minimum)

docker-compose up -d --build
```

Services exposés :
- Frontend : `http://localhost:3000`
- API : `http://localhost:3001`
- PostgreSQL : `localhost:5433` (port hôte défini par `POSTGRES_PORT` dans `.env`, 5433 par défaut dans `.env.example` pour éviter les conflits avec un PostgreSQL local)

Vérification rapide :

```bash
curl -sS http://localhost:3001/health
npm run smoke:api
```

Au premier démarrage, le serveur applique `server/schema.sql` sur la base vierge, puis crée le premier compte via l'interface (page d'inscription).

### Variables d'environnement de production

Base de référence : `.env.production.example`. En production, définir au minimum :
- `POSTGRES_PASSWORD` fort (le serveur refuse de démarrer en production sans mot de passe)
- `JWT_SECRET` fort (32+ caractères ; les valeurs d'exemple sont refusées au démarrage)
- `CORS_ORIGINS` vers le domaine du frontend
- `VITE_API_URL` et `VITE_WS_URL` vers votre endpoint public API (variables de build du client)
- les clés VAPID si vous voulez le Web Push (`npx web-push generate-vapid-keys`)

Pensez aussi à `REGISTRATION_ENABLED=false` une fois tous les comptes du cercle créés.

### Validation post-déploiement

```bash
curl -sS https://api.votre-domaine.tld/health
API_BASE=https://api.votre-domaine.tld npm run smoke:api
```

## 3) Installation manuelle (développement)

Mode conseillé : garder uniquement la base de données dans Docker.

```bash
npm install
docker-compose up -d postgres   # ou tout PostgreSQL 14+
cp .env.example .env
npm run dev                     # client + serveur (concurrently)
```

Accès :
- Frontend dev : `http://localhost:5173`
- API dev : `http://localhost:3001`

À savoir :
- le backend charge automatiquement `../.env` quand il est lancé depuis `server/`
- le schéma s'applique tout seul au premier démarrage du serveur
- si le mot de passe DB change après initialisation du volume Docker, il faut réinitialiser le volume

Réinitialiser la base (destructif) :

```bash
docker-compose down -v
docker-compose up -d postgres
```

### Développer sous Windows sans Docker

Le script `scripts/dev-windows.ps1` lance OpenCare en développement en réutilisant le PostgreSQL embarqué de l'installateur (`installer/windows/app/runtime/pgsql`) :

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev-windows.ps1
# ou avec un port PostgreSQL personnalisé :
powershell -ExecutionPolicy Bypass -File scripts/dev-windows.ps1 -Port 5544
```

Le script initialise la base de développement dans `.devdata/pgsql`, exporte les variables d'environnement nécessaires et lance `npm run dev`. Là encore, le schéma s'applique tout seul au premier démarrage du serveur.

## 4) Reverse proxy

En production, placez OpenCare derrière un reverse proxy en HTTPS (obligatoire pour le service worker et le Web Push). Deux points d'attention :

1. **WebSocket** : le temps réel passe par `/ws`, le proxy doit accepter l'upgrade.
2. **Taille des corps** : une entrée de journal peut porter des photos en data URL, autorisez au moins 8 Mo.

Exemple Nginx :

```nginx
server {
    listen 443 ssl http2;
    server_name care.votre-domaine.tld;

    # ... certificats SSL ...

    client_max_body_size 10m;

    # Frontend (conteneur client ou fichiers statiques du build)
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # API + WebSocket
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location /ws {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
}
```

Avec Caddy, l'équivalent tient en quelques lignes (`reverse_proxy` gère l'upgrade WebSocket nativement). Le serveur Express est configuré avec `trust proxy`, les en-têtes `X-Forwarded-*` sont donc correctement pris en compte (rate limiting, logs).

N'exposez jamais PostgreSQL publiquement.

## 5) Sauvegardes

Trois choses à sauvegarder :

1. **La base PostgreSQL** (l'essentiel : journal, santé, frais, documents...) :

```bash
# Docker
docker exec opencare-db pg_dump -U opencare opencare > backup-$(date +%F).sql

# Restauration sur une base vierge
cat backup-2026-06-12.sql | docker exec -i opencare-db psql -U opencare opencare
```

2. **Le dossier `server/uploads/`** (fichiers envoyés), monté en volume dans Docker Compose.

3. **Votre fichier `.env`** (secrets JWT et VAPID : sans lui, les sessions et abonnements push existants sont invalidés).

En complément, chaque cercle peut exporter l'intégralité de ses données depuis l'interface (Paramètres, export de données, endpoint `GET /api/data/export`) : pratique pour une copie de précaution lisible ou une migration.

Automatisez le `pg_dump` (cron quotidien) et stockez une copie hors du serveur.

## 6) Exploitation et dépannage

Logs et état :

```bash
docker-compose logs -f server
docker-compose ps
docker-compose down
```

### `password authentication failed for user "opencare"`

Cause fréquente : volume PostgreSQL initialisé avec un ancien mot de passe.

Solutions :
1. remettre l'ancien mot de passe dans `.env`
2. ou réinitialiser le volume (`docker-compose down -v`, destructif)

### Le serveur refuse de démarrer en parlant de `JWT_SECRET`

Comportement voulu : `JWT_SECRET` doit faire au moins 32 caractères et ne pas être une valeur d'exemple. Générez-en un : `openssl rand -hex 32`.

### Port déjà utilisé

```bash
sudo lsof -i :3000
sudo lsof -i :3001
sudo lsof -i :5433
```

### API KO mais conteneur up

- vérifier `docker-compose logs --tail=200 server`
- vérifier `curl -sS http://localhost:3001/health`

### Pas de notifications push

- les clés VAPID sont-elles définies dans `.env` ?
- l'application est-elle servie en HTTPS (obligatoire hors localhost) ?
