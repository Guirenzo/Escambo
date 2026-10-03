#!/bin/sh
# Subida do Grafana do Escambo (ADR 59): recusa subir sem senha e liga o envio dos alertas por
# e-mail pelo mesmo SMTP dos avisos do sistema (variáveis SMTP_* e MAIL_FROM do .env).
set -eu

if [ -z "${GF_SECURITY_ADMIN_PASSWORD:-}" ]; then
  echo 'Grafana: defina GRAFANA_ADMIN_PASSWORD no .env (o padrão dele seria admin/admin).' >&2
  exit 1
fi

# Sem SMTP_HOST os alertas continuam aparecendo em Alerting → Alert rules; só não saem por e-mail.
if [ -n "${SMTP_HOST:-}" ]; then
  from="$(printf '%s' "${MAIL_FROM:-}" | sed -n 's/.*<\(.*\)>.*/\1/p')"
  export GF_SMTP_ENABLED=true
  export GF_SMTP_HOST="${SMTP_HOST}:${SMTP_PORT:-587}"
  export GF_SMTP_USER="${SMTP_USER:-}"
  export GF_SMTP_PASSWORD="${SMTP_PASS:-}"
  export GF_SMTP_FROM_ADDRESS="${from:-${MAIL_FROM:-alertas@localhost}}"
  export GF_SMTP_FROM_NAME='Escambo (monitoramento)'
fi

# O ponto de contato provisionado exige um endereço, mesmo quando nada é enviado.
export ALERT_EMAIL_TO="${ALERT_EMAIL_TO:-alertas@localhost}"

exec /run.sh
