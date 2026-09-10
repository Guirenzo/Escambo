#!/usr/bin/env bash
# Backup lógico do MySQL do Escambo: mysqldump DENTRO do container do banco (usa as credenciais
# que o próprio container já tem — nada de senha em argumento ou em arquivo aqui), comprimido.
#
#   scripts/backup-db.sh                                       # → backups/escambo-YYYYmmdd-HHMMSS.sql.gz
#   COMPOSE_FILE=docker-compose.prod.yml scripts/backup-db.sh  # stack de produção
#
# Variáveis: BACKUP_DIR (padrão ./backups) · BACKUP_KEEP (quantos manter, padrão 14) · COMPOSE_FILE.
# Cron sugerido (todo dia às 03h), a partir da pasta da stack:
#   0 3 * * * cd /opt/escambo && COMPOSE_FILE=docker-compose.prod.yml scripts/backup-db.sh >> backups/backup.log 2>&1
# Copie a pasta backups/ para fora da VPS (rclone, scp, S3…): backup na mesma máquina não é backup.
set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
stamp="$(date +%Y%m%d-%H%M%S)"
out="$BACKUP_DIR/escambo-$stamp.sql.gz"
mkdir -p "$BACKUP_DIR"

# --single-transaction: snapshot consistente (InnoDB) sem travar as tabelas enquanto a API roda.
docker compose exec -T db sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -uroot --single-transaction --quick \
     --routines --triggers --set-gtid-purged=OFF "$MYSQL_DATABASE"' \
  | gzip -9 > "$out"

# gzip vazio = dump falhou silenciosamente; não deixe um "backup" de 20 bytes enganar ninguém.
if [ "$(stat -c %s "$out" 2>/dev/null || stat -f %z "$out")" -lt 1024 ]; then
  echo "backup vazio ou falho: $out" >&2
  rm -f "$out"
  exit 1
fi
echo "backup: $out ($(du -h "$out" | cut -f1))"

# Retenção: mantém os BACKUP_KEEP mais recentes.
ls -1t "$BACKUP_DIR"/escambo-*.sql.gz 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | xargs -r rm -f
