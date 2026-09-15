#!/usr/bin/env bash
# Backup dos arquivos que vivem fora do banco, no volume da API:
#   uploads/  anexos do chat (ADR 29) — o banco só tem a chave de cada um
#   media/    fotos de perfil e imagens do portfólio (ADR 36) — o banco só tem a URL
# Sem estas pastas, as mensagens mostram "arquivo indisponível" e os perfis ficam sem foto.
# Empacota DE DENTRO do container (tar do próprio Alpine).
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

# Só as pastas que existem; instância nova, sem nenhuma, não tem o que guardar (e não é erro).
dirs="$(docker compose exec -T api sh -c 'cd /repo/apps/api/data && for d in uploads media; do [ -d "$d" ] && printf "%s " "$d"; done; true')"
if [ -z "${dirs// /}" ]; then
  echo "sem uploads nem media ainda; nada a fazer"
  exit 0
fi

# shellcheck disable=SC2086 # $dirs é a lista de pastas, separada por espaço de propósito
docker compose exec -T api sh -c "cd /repo/apps/api/data && tar czf - $dirs" > "$out"

if [ "$(stat -c %s "$out" 2>/dev/null || stat -f %z "$out")" -lt 64 ]; then
  echo "backup vazio ou falho: $out" >&2
  rm -f "$out"
  exit 1
fi
echo "backup: $out ($(du -h "$out" | cut -f1)) — pastas: $dirs"

# Retenção: mantém os BACKUP_KEEP mais recentes.
ls -1t "$BACKUP_DIR"/uploads-*.tgz 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | xargs -r rm -f
