#!/usr/bin/env bash
# Backup dos anexos do chat (ADR 29): o volume da API guarda os arquivos enviados na Sala em
# uploads/AAAA/MM. O banco só tem a chave de cada um — sem esta pasta, as mensagens ficam com
# "arquivo não disponível". Empacota a pasta DE DENTRO do container (tar do próprio Alpine).
#
#   scripts/backup-uploads.sh                                       # → backups/uploads-YYYYmmdd-HHMMSS.tgz
#   COMPOSE_FILE=docker-compose.prod.yml scripts/backup-uploads.sh  # stack de produção
#
# Variáveis: BACKUP_DIR (padrão ./backups) · BACKUP_KEEP (quantos manter, padrão 14) · COMPOSE_FILE.
# Rode junto com o backup-db.sh (mesmo cron) e copie a pasta backups/ para fora da VPS.
#
# Restauração (com a API parada, para não gravar por cima):
#   docker compose stop api
#   docker compose run --rm --no-deps -T --entrypoint sh api -c 'cd /repo/apps/api/data && tar xzf -' < backups/uploads-XXXX.tgz
#   docker compose start api
set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
stamp="$(date +%Y%m%d-%H%M%S)"
out="$BACKUP_DIR/uploads-$stamp.tgz"
mkdir -p "$BACKUP_DIR"

# Sem uploads ainda (instância nova): não há o que guardar, e não é erro.
if ! docker compose exec -T api sh -c 'test -d /repo/apps/api/data/uploads'; then
  echo "sem pasta de uploads ainda; nada a fazer"
  exit 0
fi

docker compose exec -T api sh -c 'cd /repo/apps/api/data && tar czf - uploads' > "$out"

if [ "$(stat -c %s "$out" 2>/dev/null || stat -f %z "$out")" -lt 64 ]; then
  echo "backup vazio ou falho: $out" >&2
  rm -f "$out"
  exit 1
fi
echo "backup: $out ($(du -h "$out" | cut -f1))"

# Retenção: mantém os BACKUP_KEEP mais recentes.
ls -1t "$BACKUP_DIR"/uploads-*.tgz 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | xargs -r rm -f
