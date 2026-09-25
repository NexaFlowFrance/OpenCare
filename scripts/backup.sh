#!/usr/bin/env bash
# Sauvegarde de la base OpenCare.
#
# Tout vit dans PostgreSQL : le journal, les photos, les documents, les
# medicaments. Une sauvegarde de la base est donc une sauvegarde complete.
#
#   bash scripts/backup.sh                  # pile Docker, dans ./backups
#   bash scripts/backup.sh --dir /mnt/nas   # ailleurs (disque externe, NAS)
#   bash scripts/backup.sh --keep 30        # ne garde que les 30 dernieres
#   bash scripts/backup.sh --direct         # serveur PostgreSQL local, sans Docker
#
# Restauration : bash scripts/restore.sh <fichier>
set -euo pipefail

cd "$(dirname "$0")/.."

BACKUP_DIR="./backups"
KEEP=14
MODE="docker"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) BACKUP_DIR="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    --direct) MODE="direct"; shift ;;
    --docker) MODE="docker"; shift ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Option inconnue : $1" >&2; exit 1 ;;
  esac
done

if [[ ! "$KEEP" =~ ^[0-9]+$ ]]; then
  echo "[ERREUR] --keep attend un nombre entier" >&2
  exit 1
fi

# Lecture du .env SANS `source` : le fichier ecrit par l'installateur Windows
# commence par un BOM, que le shell essaierait d'executer. On ne lit ici que
# des lignes CLE=VALEUR, et une variable deja posee dans l'environnement garde
# la main sur le fichier.
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

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="$BACKUP_DIR/opencare-$STAMP.sql.gz"
TMP="$TARGET.partial"

echo "[1/3] Sauvegarde de $DB_NAME ($MODE)"

# --clean --if-exists : le fichier peut etre rejoue sur une base existante.
# --no-owner : il se restaure sous n'importe quel utilisateur.
DUMP_ARGS=(--clean --if-exists --no-owner --format=plain)

if [[ "$MODE" == "docker" ]]; then
  if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    echo "[ERREUR] Conteneur $CONTAINER introuvable. Lancez la pile, ou utilisez --direct." >&2
    exit 1
  fi
  docker exec -i "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" "${DUMP_ARGS[@]}" | gzip > "$TMP"
else
  if ! command -v pg_dump >/dev/null 2>&1; then
    echo "[ERREUR] pg_dump introuvable dans le PATH." >&2
    exit 1
  fi
  PGPASSWORD="${POSTGRES_PASSWORD:-}" pg_dump \
    -h "${POSTGRES_HOST:-localhost}" -p "${POSTGRES_PORT:-5432}" \
    -U "$DB_USER" -d "$DB_NAME" "${DUMP_ARGS[@]}" | gzip > "$TMP"
fi

# Un dump tronque est pire que pas de dump : le fichier definitif n'apparait
# qu'une fois son contenu verifie.
if [[ ! -s "$TMP" ]] || ! gzip -t "$TMP" 2>/dev/null; then
  rm -f "$TMP"
  echo "[ERREUR] Sauvegarde vide ou illisible, rien n'a ete ecrit." >&2
  exit 1
fi
if ! gzip -dc "$TMP" | grep -q "CREATE TABLE"; then
  rm -f "$TMP"
  echo "[ERREUR] Le dump ne contient aucune table, rien n'a ete ecrit." >&2
  exit 1
fi
mv "$TMP" "$TARGET"
chmod 600 "$TARGET"

SIZE="$(du -h "$TARGET" | cut -f1)"
echo "[2/3] Ecrit : $TARGET, $SIZE"

echo "[3/3] Rotation : on garde les $KEEP plus recentes"
REMOVED=0
while IFS= read -r old; do
  REMOVED=$((REMOVED + 1))
  rm -f "$old"
  echo "      supprimee : $(basename "$old")"
done < <(ls -1t "$BACKUP_DIR"/opencare-*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))")
if [[ "$REMOVED" -eq 0 ]]; then echo "      rien a supprimer"; fi

echo
echo "Sauvegarde terminee. Copiez ce fichier hors de la machine :"
echo "une sauvegarde qui vit sur le disque qui lache ne sauve personne."
