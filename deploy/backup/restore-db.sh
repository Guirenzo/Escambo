#!/usr/bin/env bash
# Restaura um backup gerado por backup-db.sh. SOBRESCREVE o banco: ele é apagado e recriado vazio
# antes da importação, para que nada criado depois do backup (uma tabela de migration mais nova, por
# exemplo) fique para trás e atrapalhe as migrations que rodam em seguida.
#
#   scripts/restore-db.sh backups/escambo-20260910-030000.sql.gz
#   COMPOSE_FILE=docker-compose.prod.yml scripts/restore-db.sh backups/escambo-....sql.gz --yes
#
# Antes de tocar no banco, confere o arquivo: o checksum (o .sha256 ao lado, se houver), o gzip e o fim
# do dump ("-- Dump completed"). Arquivo ruim: sai com erro e nada é apagado.
# A importação é como root: recria os triggers do extrato imutável e da retenção da auditoria
# (migration 0046) com o DEFINER original, o que o usuário da aplicação não poderia fazer.
#
# Modo compose (ver comum.sh): para a API e o agendador de backup (ninguém escreve nem copia durante a
# restauração) → recria o banco → importa → roda o job de migrations (o dump pode ser de uma versão
# anterior) → sobe de novo. Modo direto (CI, teste): só recria e importa; as migrations ficam com quem
# chamou.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

arg="${1:?uso: scripts/restore-db.sh <backups/escambo-....sql.gz> [--yes]}"
[ -f "$arg" ] || {
  echo "arquivo não encontrado: $arg" >&2
  exit 1
}
# Caminho absoluto antes do cd para a pasta da stack: vale o caminho de onde o comando foi digitado.
file="$(cd "$(dirname "$arg")" && pwd)/$(basename "$arg")"
cd "$here/../.."
# shellcheck source=deploy/backup/comum.sh
. "$here/comum.sh"

echo "→ conferindo $file"
if [ -f "$file.sha256" ]; then
  (cd "$(dirname "$file")" && sha256sum -c --quiet "$(basename "$file").sha256") || {
    echo "o checksum não confere com $(basename "$file").sha256: arquivo alterado ou corrompido" >&2
    exit 1
  }
fi
if ! gzip -t "$file" 2>/dev/null || ! gunzip -c "$file" | tail -n 1 | grep -q '^-- Dump completed'; then
  echo "arquivo corrompido ou dump incompleto: $file" >&2
  exit 1
fi
banco="$(nome_do_banco)"

if [ "${2:-}" != "--yes" ]; then
  read -r -p "Isto APAGA o banco '$banco' e põe no lugar o conteúdo de $file. Continuar? [s/N] " ok
  case "${ok:-}" in s | S) ;; *)
    echo "cancelado"
    exit 1
    ;;
  esac
fi

parados=()
if ! direto; then
  for s in api backup; do
    if docker compose ps --services --status running | grep -qx "$s"; then parados+=("$s"); fi
  done
  if [ "${#parados[@]}" -gt 0 ]; then
    echo "→ parando: ${parados[*]}"
    docker compose stop "${parados[@]}" >/dev/null
  fi
fi

echo "→ recriando o banco '$banco' vazio"
# shellcheck disable=SC2016 # crases: identificador do SQL, não substituição de comando
printf 'DROP DATABASE IF EXISTS `%s`;\nCREATE DATABASE `%s` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n' \
  "$banco" "$banco" | mysql_root

echo "→ importando $(basename "$file")"
# corrigir_triggers (comum.sh): dumps de antes da 1.46.0 trazem os triggers da 0046 num formato que o
# MySQL não reimporta; os novos já saem corrigidos, e o filtro não muda nada neles.
gunzip -c "$file" | corrigir_triggers | mysql_root "$banco"

triggers="$(echo "SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = '$banco'" | mysql_root -N -B)"
echo "→ triggers recriados: $triggers"
# Trigger com DEFINER que não existe neste servidor (dump de outra instalação, com outro DB_USER) é
# criado, mas falha toda vez que dispara: avisa aqui em vez de deixar para o primeiro lançamento.
orfaos="$(
  mysql_root -N -B <<SQL
SELECT DISTINCT t.definer FROM information_schema.triggers t
 WHERE t.trigger_schema = '$banco'
   AND NOT EXISTS (SELECT 1 FROM mysql.user u WHERE CONCAT(u.user, '@', u.host) = t.definer);
SQL
)"
if [ -n "$orfaos" ]; then
  echo "AVISO: triggers com DEFINER que não existe neste MySQL: $orfaos" >&2
  echo "       crie o usuário (o mesmo DB_USER da instalação de origem) ou rode as migrations de novo." >&2
fi

if ! direto; then
  echo "→ migrations pendentes (o dump pode ser de uma versão anterior)"
  docker compose run --rm migrate >/dev/null
  echo "→ subindo a API"
  docker compose up -d api >/dev/null
  for s in "${parados[@]}"; do
    if [ "$s" != api ]; then
      echo "→ subindo: $s"
      docker compose start "$s" >/dev/null
    fi
  done
fi
echo "restaurado: $file"
