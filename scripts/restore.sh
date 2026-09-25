#!/usr/bin/env bash
# Restauration d'une sauvegarde OpenCare.
#
# ATTENTION : la base actuelle est ECRASEE par le contenu du fichier.
# Une sauvegarde de securite est prise avant, sauf refus explicite.
#
#   bash scripts/restore.sh backups/opencare-20260925-093000.sql.gz
#   bash scripts/restore.sh <fichier> --direct   # PostgreSQL local, sans Docker
#   bash scripts/restore.sh <fichier> --yes      # sans confirmation
#
# Arretez le serveur applicatif avant, sinon il ecrit pendant la restauration :
#   docker compose stop server
set -euo pipefail

cd "$(dirname "$0")/.."

FILE=""
MODE="docker"
ASSUME_YES=0
SKIP_SAFETY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --direct) MODE="direct"; shift ;;
    --docker) MODE="docker"; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --no-safety-backup) SKIP_SAFETY=1; shift ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "Option inconnue : $1" >&2; exit 1 ;;
    *) FILE="$1"; shift ;;
  esac
done

if [[ -z "$FILE" ]]; then
  echo "Usage : bash scripts/restore.sh <fichier.sql.gz> [--direct] [--yes]" >&2
  exit 1
fi
if [[ ! -f "$FILE" ]]; then
  echo "[ERREUR] Fichier introuvable : $FILE" >&2
  exit 1
fi

# Lecture du .env SANS `source` : voir la meme fonction dans backup.sh.
load_env() {
  [[ -f .env ]] || return 0
  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    case "$line" in ''|'#'*) continue ;; esac
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    key="${key//[[:space:]]/}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    value="${value%\"}"; value="${value#\"}"
    [[ -n "${!key-}" ]] || printf -v "$key" '%s' "$value"
  done < <(tr -d '\357\273\277' < .env)
}
load_env

DB_NAME="${POSTGRES_DB:-opencare}"
DB_USER="${POSTGRES_USER:-opencare}"
CONTAINER="${POSTGRES_CONTAINER:-opencare-db}"

# Le fichier est-il lisible et plausible ? Verifie avant de toucher a la base.
if [[ "$FILE" == *.gz ]]; then
  gzip -t "$FILE" 2>/dev/null || { echo "[ERREUR] Archive illisible : $FILE" >&2; exit 1; }
  READ_CMD=(gzip -dc "$FILE")
else
  READ_CMD=(cat "$FILE")
fi
if ! "${READ_CMD[@]}" | grep -q "CREATE TABLE"; then
  echo "[ERREUR] Ce fichier ne ressemble pas a une sauvegarde OpenCare." >&2
  exit 1
fi

echo "Base cible : $DB_NAME ($MODE)"
echo "Fichier    : $FILE"
echo
if [[ "$ASSUME_YES" -ne 1 ]]; then
  echo "Toutes les donnees actuelles de $DB_NAME seront remplacees."
  read -r -p "Tapez RESTAURER pour continuer : " answer
  if [[ "$answer" != "RESTAURER" ]]; then echo "Annule."; exit 1; fi
fi

if [[ "$MODE" == "docker" ]] && ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "[ERREUR] Conteneur $CONTAINER introuvable. Lancez la base, ou utilisez --direct." >&2
  exit 1
fi

# Filet : l'etat actuel part dans une sauvegarde avant d'etre remplace.
if [[ "$SKIP_SAFETY" -ne 1 ]]; then
  echo "[1/2] Sauvegarde de securite de l'etat actuel"
  if [[ "$MODE" == "direct" ]]; then
    bash scripts/backup.sh --dir ./backups --keep 99 --direct >/dev/null
  else
    bash scripts/backup.sh --dir ./backups --keep 99 >/dev/null
  fi
  echo "      faite dans ./backups"
fi

echo "[2/2] Restauration"
if [[ "$MODE" == "docker" ]]; then
  "${READ_CMD[@]}" | docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" >/dev/null
else
  command -v psql >/dev/null 2>&1 || { echo "[ERREUR] psql introuvable dans le PATH." >&2; exit 1; }
  "${READ_CMD[@]}" | PGPASSWORD="${POSTGRES_PASSWORD:-}" psql -v ON_ERROR_STOP=1 \
    -h "${POSTGRES_HOST:-localhost}" -p "${POSTGRES_PORT:-5432}" \
    -U "$DB_USER" -d "$DB_NAME" >/dev/null
fi

echo
echo "Restauration terminee. Redemarrez le serveur applicatif :"
echo "docker compose up -d server"
