#!/usr/bin/env bash
# Backup dos arquivos da API (anexos do chat, fotos e portfólio, quarentena da moderação), à mão. Em
# produção ele já roda sozinho todo dia, junto com o do banco: o serviço `backup` do
# docker-compose.prod.yml. A implementação mora em deploy/backup/ (a pasta que o workflow Deploy leva
# para a VPS); este atalho só a chama, a partir da pasta da stack:
#
#   scripts/backup-uploads.sh                                       # → backups/uploads-YYYYmmdd-HHMMSS.tgz + .sha256
#   COMPOSE_FILE=docker-compose.prod.yml scripts/backup-uploads.sh  # stack de produção
#
# Variáveis: BACKUP_DIR (padrão ./backups) · BACKUP_KEEP (padrão 7) · COMPOSE_FILE.
# Restauração (com a API parada, para não gravar por cima):
#   docker compose stop api
#   docker compose run --rm --no-deps -T --entrypoint sh api -c 'cd /repo/apps/api/data && tar xzf -' < backups/uploads-XXXX.tgz
#   docker compose start api
exec bash "$(dirname "$0")/../deploy/backup/backup-uploads.sh" "$@"
