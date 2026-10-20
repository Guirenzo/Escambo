#!/bin/sh
# Cópia dos backups para fora da VPS (RNF-009): backup só na mesma máquina não sobrevive a um disco
# perdido nem a um Droplet apagado. Entrypoint do serviço `backup-offsite` do docker-compose.prod.yml,
# perfil opcional `offsite` (desligado por padrão: COMPOSE_PROFILES=offsite no .env liga). Roda na
# imagem oficial do rclone, configurado só por variáveis de ambiente (RCLONE_CONFIG_OFFSITE_*, que o
# compose monta a partir das OFFSITE_S3_* do .env): DigitalOcean Spaces, AWS S3, Backblaze B2, MinIO…
#
# A cada OFFSITE_INTERVAL_MINUTES (padrão 60) manda para OFFSITE_S3_BUCKET/OFFSITE_S3_PREFIX o que
# ainda não está lá: os dumps, os pacotes de arquivos e os .sha256 de cada um (o `rclone copy` só
# envia o que falta e confere o checksum de cada envio). Nada é apagado no destino, a não ser com
# OFFSITE_KEEP_DAYS: aí sai o que tem mais dias que isso. O recomendado é deixar vazio, usar uma regra
# de ciclo de vida no bucket e uma chave sem permissão de apagar: quem invadir a VPS não leva junto
# as cópias de fora.
# Resultado: log no stdout (docker compose logs backup-offsite) e, em BACKUP_METRICS_DIR, a métrica
# escambo_backup_offsite_last_success_timestamp_seconds (regra BackupForaDaVpsAtrasado do Grafana).
set -u

DIR="${BACKUP_DIR:-/backups}"
DESTINO="offsite:${OFFSITE_S3_BUCKET:-}/${OFFSITE_S3_PREFIX:-escambo}"
INTERVALO="${OFFSITE_INTERVAL_MINUTES:-60}"
METRICAS="${BACKUP_METRICS_DIR:-}"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S %z') [offsite] $*"; }

metrica() { # epoch_do_sucesso(ou vazio) 1|0
  [ -n "$METRICAS" ] || return 0
  mkdir -p "$METRICAS"
  tmp="$METRICAS/.escambo_backup_offsite.prom.$$"
  anterior="$(sed -n 's/^escambo_backup_offsite_last_success_timestamp_seconds //p' \
    "$METRICAS/escambo_backup_offsite.prom" 2>/dev/null)"
  sucesso="${1:-$anterior}"
  {
    if [ -n "$sucesso" ]; then
      echo '# HELP escambo_backup_offsite_last_success_timestamp_seconds Fim da última cópia bem-sucedida dos backups para fora da VPS (epoch).'
      echo '# TYPE escambo_backup_offsite_last_success_timestamp_seconds gauge'
      echo "escambo_backup_offsite_last_success_timestamp_seconds $sucesso"
    fi
    echo '# HELP escambo_backup_offsite_last_run_success 1 se a última cópia para fora da VPS terminou bem, 0 se falhou.'
    echo '# TYPE escambo_backup_offsite_last_run_success gauge'
    echo "escambo_backup_offsite_last_run_success $2"
  } >"$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$METRICAS/escambo_backup_offsite.prom"
}

enviar() {
  if [ -z "${OFFSITE_S3_BUCKET:-}" ] || [ -z "${RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID:-}" ] ||
    [ -z "${RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY:-}" ] || [ -z "${RCLONE_CONFIG_OFFSITE_ENDPOINT:-}" ]; then
    log "ERRO: defina OFFSITE_S3_ENDPOINT, OFFSITE_S3_BUCKET, OFFSITE_S3_ACCESS_KEY e OFFSITE_S3_SECRET_KEY no .env"
    return 1
  fi
  # Só o que os scripts publicam: nada de temporário (.parcial-*), estado, log ou status. Com -v, o log
  # mostra cada arquivo enviado ("Copied (new)"); o que já está lá não aparece.
  if ! rclone copy "$DIR" "$DESTINO" --max-depth 1 -v --stats 0 \
    --include 'escambo-*.sql.gz' --include 'escambo-*.sql.gz.sha256' \
    --include 'uploads-*.tgz' --include 'uploads-*.tgz.sha256'; then
    log "ERRO: a cópia para $DESTINO falhou (ver acima)"
    return 1
  fi
  if [ -n "${OFFSITE_KEEP_DAYS:-}" ]; then
    rclone delete "$DESTINO" --min-age "${OFFSITE_KEEP_DAYS}d" --max-depth 1 -v --stats 0 \
      --include 'escambo-*' --include 'uploads-*' ||
      log "AVISO: a retenção no destino (OFFSITE_KEEP_DAYS=$OFFSITE_KEEP_DAYS) falhou; as cópias ficaram"
  fi
  log "cópia em dia em $DESTINO"
}

main() {
  trap 'log "parando (sinal recebido)"; exit 0' TERM INT
  case "$INTERVALO" in
    '' | *[!0-9]* | 0)
      log "ERRO: OFFSITE_INTERVAL_MINUTES inválido: '$INTERVALO'"
      INTERVALO=60
      ;;
  esac
  if enviar; then metrica "$(date +%s)" 1; else metrica "" 0; fi
  if [ "${1:-}" = agora ]; then return 0; fi
  sleep $((INTERVALO * 60)) &
  wait $!
  # Próxima rodada com a versão do script que o Deploy tiver trazido.
  exec sh "$0"
}

# Numa linha só: o sh lê o arquivo enquanto executa, e o Deploy pode trocá-lo com o laço rodando.
main "$@"; exit $?
