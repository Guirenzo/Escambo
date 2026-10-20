#!/usr/bin/env bash
# Agendador do backup do Escambo (RNF-009): o entrypoint do serviço `backup` do docker-compose.prod.yml.
# Sem cron na VPS: o contêiner dorme até BACKUP_HOUR (horário de Brasília, padrão 03:00), roda o
# backup do banco (backup-db.sh) e o dos arquivos da API (backup-uploads.sh), cada um com a sua
# retenção (BACKUP_KEEP), e registra o resultado em três lugares:
#   - no log (docker compose -f docker-compose.prod.yml logs backup);
#   - em BACKUP_DIR/last-backup.json: status, horários e, de cada parte, o último sucesso com o
#     arquivo, o tamanho e o sha256;
#   - em BACKUP_METRICS_DIR/escambo_backup.prom, no formato do Prometheus: o node-exporter do perfil
#     monitoring lê, e a regra BackupAtrasado do Grafana avisa quando o último sucesso fica velho.
# O healthcheck do contêiner (`agendador.sh saude`) fica "unhealthy" no mesmo caso, sem monitoramento.
#
# Ao subir, se o último backup bem-sucedido do banco tem mais de 24 h (ou não existe), faz um na hora:
# VPS nova, ou contêiner que estava parado na hora marcada, não espera o dia seguinte. Uma falha não
# derruba nada: fica no log e no status, e o agendador tenta de novo em BACKUP_RETRY_MINUTES (60),
# sem passar do próximo horário. Depois de cada backup bem-sucedido, recomeça com a versão do script
# que estiver na pasta (o workflow Deploy atualiza deploy/backup/ sem recriar o contêiner).
#
#   agendador.sh           laço (o que o contêiner roda)
#   agendador.sh agora     um backup agora, fora do horário, com o mesmo registro do laço:
#       docker compose -f docker-compose.prod.yml exec backup bash /opt/escambo/deploy/backup/agendador.sh agora
#   agendador.sh status    mostra o last-backup.json
#   agendador.sh proximo   quando roda o próximo backup
#   agendador.sh saude     sai com 0 se o último sucesso de cada parte tem menos de BACKUP_MAX_AGE_HOURS h
#
# Variáveis: BACKUP_HOUR (HH:MM, padrão 03:00, no fuso TZ) · BACKUP_KEEP · BACKUP_DIR (padrão /backups)
# · BACKUP_METRICS_DIR (vazio = sem métrica) · BACKUP_RETRY_MINUTES (60) · BACKUP_MAX_AGE_HOURS (26)
# · as de comum.sh (BACKUP_MODE, DB_*, UPLOADS_DIR).
set -uo pipefail # sem -e: a falha de um backup não pode matar o laço
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export BACKUP_DIR="${BACKUP_DIR:-/backups}"
# shellcheck source=deploy/backup/comum.sh
. "$here/comum.sh"
export BACKUP_MODE BACKUP_KEEP

BACKUP_HOUR="${BACKUP_HOUR:-03:00}"
RETRY_MINUTES="${BACKUP_RETRY_MINUTES:-60}"
MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-26}"
METRICS_DIR="${BACKUP_METRICS_DIR:-}"
# Último sucesso de cada parte, uma linha "epoch arquivo bytes sha256" ("-" quando não havia arquivo),
# e a última rodada, "epoch 1|0". Texto simples: sobrevive a reinícios e não precisa de jq.
ESTADO="$BACKUP_DIR/.estado"
STATUS="$BACKUP_DIR/last-backup.json"

log() { printf '%s [backup] %s\n' "$(date '+%Y-%m-%d %H:%M:%S %z')" "$*"; }
iso() { date -d "@$1" '+%Y-%m-%dT%H:%M:%S%:z'; }

# BACKUP_HOUR → HORA (HH:MM). Aceita "3", "03" e "03:00".
validar_hora() {
  if ! [[ "$BACKUP_HOUR" =~ ^([01]?[0-9]|2[0-3])(:([0-5][0-9]))?$ ]]; then
    echo "BACKUP_HOUR inválido: '$BACKUP_HOUR' (use HH:MM, por exemplo 03:00)" >&2
    return 2
  fi
  HORA="$(printf '%02d:%02d' "$((10#${BASH_REMATCH[1]}))" "$((10#${BASH_REMATCH[3]:-0}))")"
  if ! [[ "$RETRY_MINUTES" =~ ^[1-9][0-9]*$ && "$MAX_AGE_HOURS" =~ ^[1-9][0-9]*$ ]]; then
    echo "BACKUP_RETRY_MINUTES e BACKUP_MAX_AGE_HOURS precisam ser inteiros positivos" >&2
    return 2
  fi
}

proximo_horario() {
  local alvo
  alvo="$(date -d "today $HORA" +%s)"
  [ "$alvo" -gt "$(date +%s)" ] || alvo="$(date -d "tomorrow $HORA" +%s)"
  echo "$alvo"
}

# `sleep` em segundo plano + `wait`: o SIGTERM do `docker stop` interrompe na hora.
esperar_ate() {
  local falta=$(($1 - $(date +%s)))
  if [ "$falta" -gt 0 ]; then
    sleep "$falta" &
    wait $!
  fi
}

# Depois de um boot da VPS o Docker sobe tudo junto, sem esperar o banco ficar pronto. ERRO_BANCO
# guarda a última resposta do cliente (senha errada, host fora do ar…) para o log.
esperar_banco() {
  local i
  for i in $(seq 1 24); do
    ERRO_BANCO="$(mysql_root -e 'SELECT 1' 2>&1 >/dev/null)" && return 0
    [ "$i" = 24 ] || {
      sleep 5 &
      wait $!
    }
  done
  return 1
}

# Roda backup-db.sh ou backup-uploads.sh, com o log prefixado, e guarda o resultado em $ESTADO.
rodar_parte() { # tipo script
  local tipo="$1" res arquivo bytes sha
  res="$(mktemp)"
  if BACKUP_RESULT="$res" bash "$here/$2" 2>&1 | while IFS= read -r linha; do log "$tipo: $linha"; done; then
    read -r arquivo bytes sha <"$res"
    rm -f "$res"
    echo "$(date +%s) ${arquivo:--} ${bytes:-0} ${sha:--}" >"$ESTADO/$tipo"
    echo "$(date +%s) 1" >"$ESTADO/$tipo.rodada"
    return 0
  fi
  rm -f "$res"
  echo "$(date +%s) 0" >"$ESTADO/$tipo.rodada"
  log "$tipo: FALHOU"
  return 1
}

rodar() {
  local inicio ok=1
  inicio="$(date +%s)"
  mkdir -p "$ESTADO"
  # Sobra de um backup interrompido no meio (contêiner morto durante o dump): nunca foi publicado.
  find "$BACKUP_DIR" -maxdepth 1 -name '.parcial-*' -mmin +720 -delete 2>/dev/null
  log "backup iniciado (banco + arquivos; retenção: $BACKUP_KEEP)"
  if direto && ! esperar_banco; then
    log "db: sem conexão com o banco em ${DB_HOST:-?}:${DB_PORT:-3306} por 2 minutos: ${ERRO_BANCO:-sem resposta}"
    echo "$(date +%s) 0" >"$ESTADO/db.rodada"
    ok=0
  else
    rodar_parte db backup-db.sh || ok=0
  fi
  rodar_parte uploads backup-uploads.sh || ok=0
  echo "$(date +%s) $ok" >"$ESTADO/rodada"
  gravar_status "$inicio"
  publicar_metricas
  if [ "$ok" = 1 ]; then
    log "backup concluído em $(($(date +%s) - inicio)) s"
    return 0
  fi
  log "backup com FALHA (ver as linhas acima); $STATUS registra o último sucesso de cada parte"
  return 1
}

parte_json() { # tipo
  local tipo="$1" ep arquivo bytes sha rodada=null rep rok
  if read -r rep rok 2>/dev/null <"$ESTADO/$tipo.rodada"; then
    rodada="{\"at\": \"$(iso "$rep")\", \"ok\": $([ "$rok" = 1 ] && echo true || echo false)}"
  fi
  if read -r ep arquivo bytes sha 2>/dev/null <"$ESTADO/$tipo"; then
    [ "$arquivo" = - ] && arquivo=null || arquivo="\"$arquivo\""
    [ "$sha" = - ] && sha=null || sha="\"$sha\""
    printf '{"last_run": %s, "last_success_at": "%s", "last_success_epoch": %s, "file": %s, "bytes": %s, "sha256": %s}' \
      "$rodada" "$(iso "$ep")" "$ep" "$arquivo" "$bytes" "$sha"
  else
    printf '{"last_run": %s, "last_success_at": null, "last_success_epoch": null, "file": null, "bytes": null, "sha256": null}' "$rodada"
  fi
}

gravar_status() { # inicio
  local fim ok tmp="$BACKUP_DIR/.last-backup.json.tmp"
  read -r fim ok <"$ESTADO/rodada"
  {
    printf '{\n'
    printf '  "status": "%s",\n' "$([ "$ok" = 1 ] && echo ok || echo falhou)"
    printf '  "started_at": "%s",\n' "$(iso "$1")"
    printf '  "finished_at": "%s",\n' "$(iso "$fim")"
    printf '  "duration_seconds": %s,\n' "$((fim - $1))"
    printf '  "schedule": "%s",\n' "$HORA"
    printf '  "keep": %s,\n' "$BACKUP_KEEP"
    printf '  "db": %s,\n' "$(parte_json db)"
    printf '  "uploads": %s\n' "$(parte_json uploads)"
    printf '}\n'
  } >"$tmp"
  mv -f "$tmp" "$STATUS"
  ajustar_dono "$STATUS"
}

# Textfile do node-exporter: arquivo novo inteiro e `mv` (o coletor nunca lê um pela metade); o
# temporário não termina em .prom, então o coletor o ignora. Legível pelo node-exporter (nobody).
publicar_metricas() {
  [ -n "$METRICS_DIR" ] || return 0
  mkdir -p "$METRICS_DIR"
  local tmp="$METRICS_DIR/.escambo_backup.prom.$$" tipo ep arquivo bytes sha ok
  {
    echo '# HELP escambo_backup_last_success_timestamp_seconds Fim do último backup bem-sucedido (epoch), por parte (db, uploads).'
    echo '# TYPE escambo_backup_last_success_timestamp_seconds gauge'
    for tipo in db uploads; do
      if read -r ep arquivo bytes sha 2>/dev/null <"$ESTADO/$tipo"; then
        echo "escambo_backup_last_success_timestamp_seconds{kind=\"$tipo\"} $ep"
      fi
    done
    echo '# HELP escambo_backup_last_size_bytes Tamanho do último backup bem-sucedido, por parte (0 quando não havia o que guardar).'
    echo '# TYPE escambo_backup_last_size_bytes gauge'
    for tipo in db uploads; do
      if read -r ep arquivo bytes sha 2>/dev/null <"$ESTADO/$tipo"; then
        echo "escambo_backup_last_size_bytes{kind=\"$tipo\"} $bytes"
      fi
    done
    if read -r ep ok 2>/dev/null <"$ESTADO/rodada"; then
      echo '# HELP escambo_backup_last_run_success 1 se a última rodada (banco e arquivos) terminou bem, 0 se falhou.'
      echo '# TYPE escambo_backup_last_run_success gauge'
      echo "escambo_backup_last_run_success $ok"
      echo '# HELP escambo_backup_last_run_timestamp_seconds Fim da última rodada de backup (epoch), com sucesso ou não.'
      echo '# TYPE escambo_backup_last_run_timestamp_seconds gauge'
      echo "escambo_backup_last_run_timestamp_seconds $ep"
    fi
    echo '# HELP escambo_backup_keep Retenção configurada (BACKUP_KEEP): cópias e dias.'
    echo '# TYPE escambo_backup_keep gauge'
    echo "escambo_backup_keep $BACKUP_KEEP"
  } >"$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$METRICS_DIR/escambo_backup.prom"
}

ultimo_sucesso() { # tipo → epoch (0 se nunca)
  local ep
  read -r ep _ 2>/dev/null <"$ESTADO/$1" || ep=0
  echo "${ep:-0}"
}

saude() {
  local tipo idade falhou=0
  for tipo in db uploads; do
    idade=$(($(date +%s) - $(ultimo_sucesso "$tipo")))
    if [ "$idade" -gt $((MAX_AGE_HOURS * 3600)) ]; then
      echo "$tipo: ATRASADO (último sucesso há mais de $MAX_AGE_HOURS h; ver docker compose logs backup)"
      falhou=1
    else
      echo "$tipo: ok, último sucesso há $((idade / 3600)) h"
    fi
  done
  return "$falhou"
}

laco() { # [--continua]
  trap 'log "parando (sinal recebido)"; exit 0' TERM INT
  local proximo tentativa agenda
  publicar_metricas
  if [ "${1:-}" != --continua ] && [ $(($(date +%s) - $(ultimo_sucesso db))) -gt 86400 ]; then
    log "último backup do banco com mais de 24 h (ou nenhum): rodando um agora"
    proximo="$(date +%s)"
  else
    proximo="$(proximo_horario)"
  fi
  while :; do
    [ "$proximo" -le "$(date +%s)" ] || log "próximo backup: $(date -d "@$proximo" '+%Y-%m-%d %H:%M %Z')"
    esperar_ate "$proximo"
    if rodar; then
      exec bash "${BASH_SOURCE[0]}" laco --continua
    fi
    tentativa=$(($(date +%s) + RETRY_MINUTES * 60))
    agenda="$(proximo_horario)"
    proximo=$((tentativa < agenda ? tentativa : agenda))
  done
}

main() {
  validar_hora || return $?
  case "${1:-laco}" in
    laco) laco "${2:-}" ;;
    agora) rodar ;;
    saude) saude ;;
    status) cat "$STATUS" ;;
    proximo) date -d "@$(proximo_horario)" '+%Y-%m-%d %H:%M %Z' ;;
    *)
      echo "uso: agendador.sh [laco|agora|status|proximo|saude]" >&2
      return 2
      ;;
  esac
}

# Numa linha só: o bash lê o arquivo enquanto executa, e o Deploy pode trocá-lo com o laço rodando.
main "$@"; exit $?
