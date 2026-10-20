#!/usr/bin/env bash
# Restaura um backup gerado por backup-db.sh. APAGA o banco atual e põe no lugar o do arquivo.
# A implementação mora em deploy/backup/restore-db.sh (a pasta que o workflow Deploy leva para a VPS);
# este atalho só a chama, a partir da pasta da stack:
#
#   scripts/restore-db.sh backups/escambo-20260910-030000.sql.gz
#   COMPOSE_FILE=docker-compose.prod.yml scripts/restore-db.sh backups/escambo-....sql.gz --yes
#
# Passos: confere o arquivo (checksum, gzip, fim do dump) → para a API e o agendador de backup →
# recria o banco vazio → importa como root (os triggers da 0046 voltam com o DEFINER original) →
# roda o job de migrations (o dump pode ser de uma versão anterior) → sobe tudo de novo.
# Testado no CI a cada push: scripts/test-backup-restore.sh.
exec bash "$(dirname "$0")/../deploy/backup/restore-db.sh" "$@"
