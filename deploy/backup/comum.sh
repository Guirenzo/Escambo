# shellcheck shell=bash
# Funções comuns dos scripts de backup do Escambo (RNF-009). Não roda sozinho: os scripts desta
# pasta fazem `source` dele.
#
# Dois modos, escolhidos por BACKUP_MODE (padrão: `direto` quando DB_HOST está definido, senão `compose`):
#   compose  à mão, na VPS ou na máquina de dev, a partir da pasta da stack: o cliente do MySQL e o tar
#            rodam DENTRO dos contêineres db e api (`docker compose exec`), com as credenciais que eles
#            já têm (nada de senha em argumento ou em arquivo aqui). COMPOSE_FILE escolhe a stack.
#   direto   no serviço `backup` do docker-compose.prod.yml, no CI e no teste de restauração: usa o
#            mysqldump/mysql locais em DB_HOST:DB_PORT, como root (DB_ROOT_PASSWORD, que vai para o
#            cliente por MYSQL_PWD, nunca na linha de comando), e lê os arquivos da API de UPLOADS_DIR.
#
# Variáveis comuns: BACKUP_DIR (padrão ./backups, a partir da pasta da stack) · BACKUP_KEEP (padrão 7,
# ver aplicar_retencao) · BACKUP_RESULT (opcional: arquivo onde o script escreve "nome bytes sha256"
# do backup feito, ou "- 0 -" quando não havia o que guardar; é como o agendador.sh sabe o resultado).

# Dump e pacote têm dados pessoais: nenhum arquivo legível por outros usuários da máquina.
umask 077

BACKUP_DIR="${BACKUP_DIR:-backups}"
BACKUP_KEEP="${BACKUP_KEEP:-7}"
if [ -z "${BACKUP_MODE:-}" ]; then
  if [ -n "${DB_HOST:-}" ]; then BACKUP_MODE=direto; else BACKUP_MODE=compose; fi
fi
case "$BACKUP_MODE" in
  compose | direto) ;;
  *)
    echo "BACKUP_MODE inválido: '$BACKUP_MODE' (use compose ou direto)" >&2
    exit 2
    ;;
esac
if ! [[ "$BACKUP_KEEP" =~ ^[1-9][0-9]*$ ]]; then
  echo "BACKUP_KEEP inválido: '$BACKUP_KEEP' (um inteiro, 1 ou mais)" >&2
  exit 2
fi

direto() { [ "$BACKUP_MODE" = direto ]; }

# Cliente do MySQL como root. Os argumentos vão direto para o cliente; o SQL entra pelo stdin ou -e.
mysql_root() {
  if direto; then
    MYSQL_PWD="${DB_ROOT_PASSWORD:?defina DB_ROOT_PASSWORD}" mysql \
      -h"${DB_HOST:?defina DB_HOST}" -P"${DB_PORT:-3306}" -u"${DB_ROOT_USER:-root}" "$@"
  else
    # shellcheck disable=SC2016 # as variáveis são do contêiner do banco, não daqui
    docker compose exec -T db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot "$@"' sh "$@"
  fi
}

mysqldump_root() {
  if direto; then
    MYSQL_PWD="${DB_ROOT_PASSWORD:?defina DB_ROOT_PASSWORD}" mysqldump \
      -h"${DB_HOST:?defina DB_HOST}" -P"${DB_PORT:-3306}" -u"${DB_ROOT_USER:-root}" "$@"
  else
    # shellcheck disable=SC2016 # idem
    docker compose exec -T db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -uroot "$@"' sh "$@"
  fi
}

# Database da aplicação: DB_NAME no modo direto; o MYSQL_DATABASE do contêiner no modo compose.
nome_do_banco() {
  local nome
  if direto; then
    nome="${DB_NAME:-escambo}"
  else
    # shellcheck disable=SC2016 # idem
    nome="$(docker compose exec -T db sh -c 'printf %s "$MYSQL_DATABASE"')"
  fi
  if ! [[ "$nome" =~ ^[A-Za-z0-9_]+$ ]]; then
    echo "nome de banco inválido: '$nome'" >&2
    return 1
  fi
  printf '%s' "$nome"
}

tamanho() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1"; }

# Filtro do dump (no backup e na restauração). Trigger criado por uma conexão multi-statement (o runner
# de migrations manda o arquivo inteiro de uma vez) fica com o ";" final DENTRO do corpo: é o caso dos
# 7 triggers de uma instrução só da 0046. O mysqldump escreve o corpo dentro de um comentário versionado,
#   /*!50003 CREATE*/ /*!50017 DEFINER=...*/ /*!50003 TRIGGER ... SET MESSAGE_TEXT = '...'; */;;
# e o MySQL encerra o comando nesse ";" e recusa o " */" que sobra (ERROR 1064 near ' */'): sem o
# filtro, o dump não volta. Tirar o ";" não muda o trigger. O padrão só casa com o fim de um bloco
# DELIMITER ;; (linhas de dados terminam em ");", e os SET do cabeçalho em "*/;").
corrigir_triggers() { sed -e 's/; \*\/;;$/ *\/;;/'; }

# O serviço `backup` roda como root: o que ele grava na pasta montada da VPS fica com o dono da pasta
# (quem a criou), para o operador ler e restaurar sem sudo. Fora do root, não faz nada.
ajustar_dono() {
  [ "$(id -u)" = 0 ] || return 0
  local dono
  dono="$(stat -c %u:%g "$BACKUP_DIR" 2>/dev/null)" || return 0
  [ "$dono" = 0:0 ] || chown "$dono" "$@" 2>/dev/null || true
}

# Põe no lugar um backup já conferido: o temporário vira o nome final (só então ele "existe" para a
# retenção e para a cópia fora da VPS) e ganha o .sha256 ao lado, no formato do `sha256sum -c`.
publicar() { # temporario final
  local final="$2"
  mv -f "$1" "$final"
  (cd "$(dirname "$final")" && sha256sum "$(basename "$final")" >"$(basename "$final").sha256")
  ajustar_dono "$final" "$final.sha256"
}

# Conta ao agendador.sh o que foi feito (BACKUP_RESULT). Sem argumento: não havia o que guardar.
resultado() { # [arquivo]
  [ -n "${BACKUP_RESULT:-}" ] || return 0
  if [ -z "${1:-}" ]; then
    echo '- 0 -' >"$BACKUP_RESULT"
  else
    printf '%s %s %s\n' "$(basename "$1")" "$(tamanho "$1")" "$(cut -d' ' -f1 "$1.sha256")" >"$BACKUP_RESULT"
  fi
}

# Retenção (RNF-009: 7 dias). Um backup só sai quando, ao mesmo tempo, NÃO está entre os BACKUP_KEEP
# mais recentes E tem mais de BACKUP_KEEP dias. Com um por dia, isso é guardar BACKUP_KEEP dias; um
# backup extra feito à mão não empurra para fora a cópia de uma semana atrás.
# shellcheck disable=SC2012,SC2086 # nomes gerados por estes scripts (sem espaço); o padrão expande de propósito
aplicar_retencao() { # padrão, ex.: 'escambo-*.sql.gz'
  local n=0 f
  while IFS= read -r f; do
    n=$((n + 1))
    [ "$n" -gt "$BACKUP_KEEP" ] || continue
    if [ -n "$(find "$f" -maxdepth 0 -mmin "+$((BACKUP_KEEP * 1440))" 2>/dev/null)" ]; then
      rm -f "$f" "$f.sha256"
      echo "retenção: apagado $(basename "$f")"
    fi
  done < <(ls -1t "$BACKUP_DIR"/$1 2>/dev/null)
}
