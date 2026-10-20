#!/usr/bin/env bash
# Backup do banco (RNF-009), à mão. Em produção ele já roda sozinho todo dia: o serviço `backup` do
# docker-compose.prod.yml (deploy/backup/agendador.sh). A implementação mora em deploy/backup/, a
# pasta que o workflow Deploy leva para a VPS; este atalho só a chama, a partir da pasta da stack:
#
#   scripts/backup-db.sh                                       # → backups/escambo-YYYYmmdd-HHMMSS.sql.gz + .sha256
#   COMPOSE_FILE=docker-compose.prod.yml scripts/backup-db.sh  # stack de produção
#
# Variáveis: BACKUP_DIR (padrão ./backups) · BACKUP_KEEP (padrão 7: mantém as 7 cópias mais recentes e
# tudo com menos de 7 dias) · COMPOSE_FILE. Detalhes em deploy/backup/backup-db.sh e comum.sh.
exec bash "$(dirname "$0")/../deploy/backup/backup-db.sh" "$@"
