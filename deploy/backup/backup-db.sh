#!/usr/bin/env bash
# Backup lógico do MySQL do Escambo (RNF-009): mysqldump com snapshot consistente, comprimido, com o
# checksum ao lado e retenção. É o que o serviço `backup` do docker-compose.prod.yml roda todo dia
# (agendador.sh, modo direto) e o que scripts/backup-db.sh chama à mão (modo compose; ver comum.sh).
#
#   scripts/backup-db.sh                                       # → backups/escambo-YYYYmmdd-HHMMSS.sql.gz + .sha256
#   COMPOSE_FILE=docker-compose.prod.yml scripts/backup-db.sh  # stack de produção
#
# Variáveis: BACKUP_DIR (padrão ./backups) · BACKUP_KEEP (padrão 7) · BACKUP_MODE e DB_* (comum.sh).
# Restaurar: scripts/restore-db.sh <arquivo>.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here/../.."
# shellcheck source=deploy/backup/comum.sh
. "$here/comum.sh"

banco="$(nome_do_banco)"
stamp="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
out="$BACKUP_DIR/escambo-$stamp.sql.gz"
# Nome que não casa com escambo-*: nem a retenção nem a cópia fora da VPS veem um dump pela metade.
tmp="$BACKUP_DIR/.parcial-escambo-$stamp.sql.gz"
trap 'rm -f "$tmp"' EXIT

# --single-transaction: snapshot consistente (InnoDB) sem travar as tabelas enquanto a API roda.
# --triggers: os triggers do extrato imutável e da retenção da auditoria (migration 0046, RNF-036/037)
#   vão no dump, depois dos dados de cada tabela e com o DEFINER original; quem restaura é o root
#   (restore-db.sh), que pode recriá-los assim.
# --routines/--hex-blob: rotinas, se um dia houver, e colunas binárias sem depender do charset.
# corrigir_triggers (comum.sh): sem ele, o dump dos triggers da 0046 não reimporta.
mysqldump_root --single-transaction --quick --routines --triggers --hex-blob --no-tablespaces \
  --set-gtid-purged=OFF --default-character-set=utf8mb4 "$banco" | corrigir_triggers | gzip -9 >"$tmp"

# O mysqldump só escreve a última linha ("-- Dump completed") quando termina bem: dump cortado no
# meio (conexão caiu, disco encheu) não vira "backup".
if ! gzip -t "$tmp" 2>/dev/null || ! gunzip -c "$tmp" | tail -n 1 | grep -q '^-- Dump completed'; then
  echo "backup incompleto ou falho: $out" >&2
  exit 1
fi
publicar "$tmp" "$out"
echo "backup: $out ($(du -h "$out" | cut -f1))"
resultado "$out"
aplicar_retencao 'escambo-*.sql.gz'
