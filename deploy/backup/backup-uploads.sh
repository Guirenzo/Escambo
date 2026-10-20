#!/usr/bin/env bash
# Backup dos arquivos que vivem fora do banco, no volume da API (DATA_DIR):
#   uploads/     anexos do chat (ADR 29): o banco só tem a chave de cada um
#   media/       fotos de perfil e imagens do portfólio (ADR 36): o banco só tem a URL
#   quarantine/  imagens tiradas do ar pela moderação, guardadas enquanto o dono pode contestar
# Sem elas, as mensagens mostram "arquivo indisponível" e os perfis ficam sem foto. As cópias LGPD
# (exports/) são temporárias (EXPORT_TTL_DAYS) e ficam de fora.
#
#   scripts/backup-uploads.sh                                       # → backups/uploads-YYYYmmdd-HHMMSS.tgz + .sha256
#   COMPOSE_FILE=docker-compose.prod.yml scripts/backup-uploads.sh  # stack de produção
#
# Modo compose: empacota DE DENTRO do contêiner da API (tar do próprio Alpine). Modo direto (serviço
# `backup`): lê UPLOADS_DIR, o volume da API montado só para leitura. Ver comum.sh.
# Variáveis: BACKUP_DIR (padrão ./backups) · BACKUP_KEEP (padrão 7) · UPLOADS_DIR (modo direto).
#
# Restauração (com a API parada, para não gravar por cima):
#   docker compose stop api
#   docker compose run --rm --no-deps -T --entrypoint sh api -c 'cd /repo/apps/api/data && tar xzf -' < backups/uploads-XXXX.tgz
#   docker compose start api
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here/../.."
# shellcheck source=deploy/backup/comum.sh
. "$here/comum.sh"

pastas="uploads media quarantine"

# Só as pastas que existem; instância nova, sem nenhuma, não tem o que guardar (e não é erro).
if direto; then
  dirs="$(cd "${UPLOADS_DIR:?defina UPLOADS_DIR}" && for d in $pastas; do [ -d "$d" ] && printf '%s ' "$d"; done; true)"
else
  dirs="$(docker compose exec -T api sh -c "cd /repo/apps/api/data && for d in $pastas; do [ -d \"\$d\" ] && printf '%s ' \"\$d\"; done; true")"
fi
if [ -z "${dirs// /}" ]; then
  echo "sem uploads, media nem quarantine ainda; nada a fazer"
  resultado
  exit 0
fi

stamp="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
out="$BACKUP_DIR/uploads-$stamp.tgz"
tmp="$BACKUP_DIR/.parcial-uploads-$stamp.tgz"
trap 'rm -f "$tmp"' EXIT

if direto; then
  # A API segue gravando durante o backup: o GNU tar sai com 1 quando um arquivo muda ou some no meio
  # da leitura (um anexo novo, o expurgo apagando outro). O pacote fica bom assim mesmo; 2 é erro.
  rc=0
  # shellcheck disable=SC2086 # $dirs é a lista de pastas, separada por espaço de propósito
  tar czf "$tmp" --warning=no-file-changed --warning=no-file-removed -C "$UPLOADS_DIR" $dirs || rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "tar falhou (código $rc): $out" >&2
    exit 1
  fi
else
  # shellcheck disable=SC2086 # idem
  docker compose exec -T api sh -c "cd /repo/apps/api/data && tar czf - $dirs" >"$tmp"
fi

if ! gzip -t "$tmp" 2>/dev/null; then
  echo "pacote vazio ou falho: $out" >&2
  exit 1
fi
publicar "$tmp" "$out"
echo "backup: $out ($(du -h "$out" | cut -f1)), pastas: $dirs"
resultado "$out"
aplicar_retencao 'uploads-*.tgz'
