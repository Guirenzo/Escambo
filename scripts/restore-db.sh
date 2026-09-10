#!/usr/bin/env bash
# Restaura um backup gerado por backup-db.sh no MySQL do Escambo. SOBRESCREVE os dados atuais.
#
#   scripts/restore-db.sh backups/escambo-20260910-030000.sql.gz
#   COMPOSE_FILE=docker-compose.prod.yml scripts/restore-db.sh backups/escambo-....sql.gz --yes
#
# Passos: para a API (ninguém escreve durante a restauração) → importa o dump → roda o job de
# migrations (o dump pode ser de uma versão anterior) → sobe a API de novo.
set -euo pipefail
cd "$(dirname "$0")/.."

file="${1:?uso: scripts/restore-db.sh <backups/escambo-....sql.gz> [--yes]}"
[ -f "$file" ] || { echo "arquivo não encontrado: $file" >&2; exit 1; }

if [ "${2:-}" != "--yes" ]; then
  read -r -p "Isto SOBRESCREVE o banco atual com $file. Continuar? [s/N] " ok
  case "${ok:-}" in s|S) ;; *) echo "cancelado"; exit 1 ;; esac
fi

echo "→ parando a API"
docker compose stop api >/dev/null

echo "→ importando $file"
gunzip -c "$file" | docker compose exec -T db sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot "$MYSQL_DATABASE"'

echo "→ migrations pendentes (o dump pode ser de uma versão anterior)"
docker compose run --rm migrate >/dev/null

echo "→ subindo a API"
docker compose up -d api >/dev/null
echo "restaurado: $file"
