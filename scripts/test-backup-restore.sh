#!/usr/bin/env bash
# Teste de ponta a ponta do backup (RNF-009): faz o backup como a produção faz, apaga o banco, restaura
# e confere que tudo voltou igual. Roda no CI (job `backup` do ci.yml) a cada push e na máquina de quem
# desenvolve, sempre contra um MySQL DESCARTÁVEL: cria e apaga o próprio database e um usuário de teste.
#
#   scripts/test-backup-restore.sh            # MySQL 8 em DB_HOST:DB_PORT, root com DB_ROOT_PASSWORD;
#                                             # precisa de mysql e mysqldump 8, node e o `npm ci` feito
#   scripts/test-backup-restore.sh --docker   # sobe um mysql:8.0 temporário (tmp-backup-test-mysql) e
#                                             # roda os clientes num contêiner; precisa de Docker, node e `npm ci`
#
# Variáveis: TEST_DB_NAME (padrão escambo_backup_test) · KEEP_TEST_DB=1 (não apaga o database no fim)
# · MIGRATE_CMD (padrão: o runner de migrations da API, `npm run -s -w @escambo/api db:migrate`).
#
# Passos:
#  1. cria o database e um usuário da aplicação e aplica baseline + migrations + seed de referência com
#     o runner da API, como esse usuário, igual ao job `migrate` da produção: os triggers da 0046 nascem
#     com o DEFINER dele;
#  2. insere dados de exemplo (usuários, carteiras, extratos imutáveis, eventos do gateway, auditoria
#     recente e antiga, texto com acento e emoji, JSON) e arquivos de exemplo em uploads/ e media/;
#  3. fotografa o banco: linhas e CHECKSUM de cada tabela, estrutura (SHOW CREATE TABLE), triggers
#     (com DEFINER e corpo) e schema_migrations;
#  4. roda o backup como o serviço `backup` roda (deploy/backup/agendador.sh agora), com backups antigos
#     falsos na pasta, e confere a retenção, o last-backup.json, a métrica, a saúde e o pacote dos arquivos;
#  5. tenta restaurar um arquivo cortado e um com checksum errado: os dois têm de ser recusados sem
#     tocar no banco;
#  6. apaga o database, recria vazio e restaura (scripts/restore-db.sh, como root) um dump no formato
#     de antes da 1.46.0 (triggers com o ";" que o mysql não reimportava) e depois o backup novo;
#  7. fotografa de novo e compara com a primeira foto; confere, como o usuário da aplicação, que os
#     triggers voltaram funcionando: UPDATE/DELETE no extrato e na auditoria recusados (ERROR 1644),
#     sem mudar nenhuma linha.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here/.."

TEST_DB_NAME="${TEST_DB_NAME:-escambo_backup_test}"
APP_USER="${TEST_APP_USER:-escambo_bkp_app}"
APP_PASSWORD="${TEST_APP_PASSWORD:-senha-do-teste-de-backup}"
DB_PORT="${DB_PORT:-3306}"
[[ "$TEST_DB_NAME" =~ ^[A-Za-z0-9_]+$ && "$APP_USER" =~ ^[A-Za-z0-9_]+$ ]] || {
  echo "TEST_DB_NAME e TEST_APP_USER: só letras, números e _" >&2
  exit 2
}

passo() { printf '\n== %s\n' "$*"; }
ok() { printf '   ok: %s\n' "$*"; }
falha() {
  printf '\nFALHOU: %s\n' "$*" >&2
  exit 1
}

root_sql() {
  MYSQL_PWD="${DB_ROOT_PASSWORD:?defina DB_ROOT_PASSWORD}" mysql --default-character-set=utf8mb4 \
    -h"${DB_HOST:?defina DB_HOST}" -P"$DB_PORT" -uroot "$@"
}
app_sql() {
  MYSQL_PWD="$APP_PASSWORD" mysql --default-character-set=utf8mb4 \
    -h"$DB_HOST" -P"$DB_PORT" -u"$APP_USER" "$TEST_DB_NAME" "$@"
}
q() { root_sql -N -B "$TEST_DB_NAME" -e "$1"; }

work=""
limpar_no_fim=0
conteiner=""
rede=""
fim() {
  local rc=$?
  [ -z "$work" ] || rm -rf "$work"
  if [ "$limpar_no_fim" = 1 ] && [ "${KEEP_TEST_DB:-}" != 1 ]; then limpar >/dev/null 2>&1 || true; fi
  [ -z "$conteiner" ] || docker rm -f "$conteiner" >/dev/null 2>&1 || true
  [ -z "$rede" ] || docker network rm "$rede" >/dev/null 2>&1 || true
  exit "$rc"
}
trap fim EXIT

# --- 1. banco descartável + migrations ------------------------------------------------------------

preparar() {
  passo "1. database $TEST_DB_NAME e usuário $APP_USER (descartáveis)"
  # log_bin_trust_function_creators: o mesmo que o --log-bin-trust-function-creators=1 dos compose;
  # sem ele, com o binlog ligado, só quem tem SUPER cria trigger (a 0046 roda como o usuário da app).
  printf '%s\n' \
    "SET GLOBAL log_bin_trust_function_creators = 1;" \
    "DROP DATABASE IF EXISTS \`$TEST_DB_NAME\`;" \
    "CREATE DATABASE \`$TEST_DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" \
    "DROP USER IF EXISTS '$APP_USER'@'%';" \
    "CREATE USER '$APP_USER'@'%' IDENTIFIED BY '$APP_PASSWORD';" \
    "GRANT ALL PRIVILEGES ON \`$TEST_DB_NAME\`.* TO '$APP_USER'@'%';" | root_sql
  ok "criados"
}

migrar() {
  passo "1. baseline + migrations + seed de referência (runner da API, como $APP_USER)"
  DB_HOST="$DB_HOST" DB_PORT="$DB_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" \
    DB_NAME="$TEST_DB_NAME" NODE_ENV=test LOG_LEVEL=warn \
    JWT_SECRET=segredo-do-teste-de-backup-com-32-caracteres \
    bash -c "${MIGRATE_CMD:-npm run -s -w @escambo/api db:migrate}"
  ok "migrations aplicadas"
}

limpar() {
  printf '%s\n' "DROP DATABASE IF EXISTS \`$TEST_DB_NAME\`;" "DROP USER IF EXISTS '$APP_USER'@'%';" | root_sql
}

# --- 2 a 7. dados, foto, backup, restauração, comparação -------------------------------------------

dados_de_exemplo() {
  passo "2. dados de exemplo (como $APP_USER, igual à API)"
  app_sql <<'SQL'
INSERT INTO users (ulid, email, password_hash, role, status, email_verified_at) VALUES
  ('01JBKPTEST0000000000000C01', 'cliente.backup@escambo.test',
   '$2a$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW', 'client', 'active', NOW()),
  ('01JBKPTEST0000000000000F01', 'freela.backup@escambo.test', NULL, 'freelancer', 'active', NOW());
SET @c = (SELECT id FROM users WHERE email = 'cliente.backup@escambo.test');
SET @f = (SELECT id FROM users WHERE email = 'freela.backup@escambo.test');
INSERT INTO wallets (user_id, balance, balance_pending) VALUES (@c, 150.00, 50.00), (@f, 0.00, 0.00);
INSERT INTO wallet_transactions (user_id, amount, pending_delta, balance_after, pending_after, reason) VALUES
  (@c, 200.00, 0.00, 200.00, 0.00, 'deposit'),
  (@c, -50.00, 50.00, 150.00, 50.00, 'hold');
INSERT INTO credit_transactions (user_id, amount, balance_after, reason) VALUES (@f, 100, 100, 'welcome');
INSERT INTO payment_events (gateway, source, outcome, payload) VALUES
  ('simulado', 'simulation', 'created', JSON_OBJECT('valor', 200.0, 'descricao', 'depósito de teste ✓ 🚀'));
INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_value, ip_address, user_agent, created_at) VALUES
  (@c, 'auth.login', 'user', @c, JSON_OBJECT('ok', TRUE), '203.0.113.7', 'Navegador de teste: ação, coração 🚀', NOW()),
  (@c, 'auth.login', 'user', @c, NULL, '203.0.113.7', 'registro de 120 dias atrás', NOW() - INTERVAL 120 DAY);
SQL
  mkdir -p "$work/dados/uploads/2026/10" "$work/dados/media/2026/10" "$work/dados/exports"
  head -c 70000 /dev/urandom >"$work/dados/uploads/2026/10/01JBKPANEXO.pdf"
  head -c 30000 /dev/urandom >"$work/dados/media/2026/10/01JBKPFOTO.webp"
  echo '{"temporario": true}' >"$work/dados/exports/copia-lgpd.json"
  ok "usuários, carteiras, extratos, eventos do gateway, auditoria e 2 arquivos"
}

fotografar() { # arquivo
  local tabelas t contagem="" lista=""
  tabelas="$(q "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name")"
  [ -n "$tabelas" ] || falha "o database $TEST_DB_NAME não tem tabelas"
  for t in $tabelas; do
    contagem+="SELECT '$t', COUNT(*) FROM \`$t\` UNION ALL "
    lista+="\`$t\`,"
  done
  {
    echo "## linhas por tabela"
    q "${contagem% UNION ALL }"
    echo "## checksum por tabela"
    q "CHECKSUM TABLE ${lista%,}"
    # Estrutura pelo information_schema, não pelo texto do SHOW CREATE TABLE: depois da importação o
    # MySQL passa a escrever "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci" em coluna onde antes
    # escrevia só o COLLATE, com o mesmo charset e a mesma collation.
    echo "## tabelas: engine e collation"
    q "SELECT table_name, engine, table_collation FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name"
    echo "## colunas"
    q "SELECT table_name, ordinal_position, column_name, column_type, is_nullable, IFNULL(column_default, '(null)'), IFNULL(character_set_name, ''), IFNULL(collation_name, ''), extra, generation_expression FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY table_name, ordinal_position"
    echo "## índices"
    q "SELECT table_name, index_name, seq_in_index, column_name, non_unique, IFNULL(sub_part, ''), index_type FROM information_schema.statistics WHERE table_schema = DATABASE() ORDER BY table_name, index_name, seq_in_index"
    echo "## chaves estrangeiras e checks"
    q "SELECT k.constraint_name, k.table_name, k.column_name, k.referenced_table_name, k.referenced_column_name, r.update_rule, r.delete_rule FROM information_schema.key_column_usage k JOIN information_schema.referential_constraints r ON r.constraint_schema = k.table_schema AND r.constraint_name = k.constraint_name AND r.table_name = k.table_name WHERE k.table_schema = DATABASE() ORDER BY k.table_name, k.constraint_name, k.ordinal_position"
    q "SELECT constraint_name, check_clause FROM information_schema.check_constraints WHERE constraint_schema = DATABASE() ORDER BY constraint_name"
    echo "## próximo AUTO_INCREMENT"
    # shellcheck disable=SC2016 # crases: identificador do SQL
    for t in $tabelas; do printf 'SHOW CREATE TABLE `%s`;\n' "$t"; done | root_sql -N -B "$TEST_DB_NAME" |
      awk -F'\t' '{ print $1, (match($2, /AUTO_INCREMENT=[0-9]+/) ? substr($2, RSTART, RLENGTH) : "-") }'
    # O corpo é comparado sem o ";" final (a 0046 grava os triggers com ele, e o backup tira: comum.sh,
    # corrigir_triggers, senão o dump não reimporta) e sem CR (num checkout no Windows as migrations
    # têm CRLF, e o cliente mysql descarta o CR na importação). O resto tem de voltar idêntico.
    echo "## triggers"
    q "SELECT trigger_name, event_manipulation, event_object_table, action_timing, definer, SHA2(TRIM(TRAILING ';' FROM REPLACE(action_statement, '\r', '')), 256) FROM information_schema.triggers WHERE trigger_schema = DATABASE() ORDER BY trigger_name"
    echo "## rotinas"
    q "SELECT routine_name, routine_type, definer FROM information_schema.routines WHERE routine_schema = DATABASE() ORDER BY routine_name"
    echo "## schema_migrations"
    q "SELECT name, checksum FROM schema_migrations ORDER BY name"
  } >"$1"
}

# A imagem mysql:8.0 (onde o teste roda no modo --docker) não tem diff nem cmp: compara por sha256 e,
# na diferença, mostra as linhas que só existem de um lado (comm).
iguais() { [ "$(sha256sum <"$1" | cut -c1-64)" = "$(sha256sum <"$2" | cut -c1-64)" ]; }
# A foto sem a seção dos triggers (do "## triggers" até o cabeçalho seguinte).
sem_triggers() { awk '/^## / { fora = ($0 == "## triggers") } !fora' "$1"; }
mostrar_diferenca() {
  echo "--- só em $1 / +++ só em $2:" >&2
  comm -3 <(sort "$1") <(sort "$2") | awk '{ if (sub(/^\t/, "")) print "+++ " $0; else print "--- " $0 }' | cut -c1-400 >&2
}
arvore() { (cd "$1" && find . -type f -exec sha256sum {} + | sort -k2); }

backup_falso() { # nome idade_em_minutos
  echo "falso" >"$bk/$1"
  echo "0000  $1" >"$bk/$1.sha256"
  touch -d "@$(($(date +%s) - $2 * 60))" "$bk/$1"
}

# Tentativa de escrita que o banco TEM de recusar (ERROR 1644, o SIGNAL dos triggers da 0046): prova
# que os triggers voltaram funcionando, com o DEFINER existente e os grants do usuário da aplicação
# intactos (sem grant o erro seria 1142). Nenhuma linha muda. As 4 tentativas (recusas) são a exceção
# declarada em apps/api/src/modules/audit/audit.retention.test.ts.
espera_recusa() { # sql
  local saida
  if saida="$(app_sql -e "$1" 2>&1)"; then falha "o banco aceitou: $1"; fi
  grep -q 'ERROR 1644' <<<"$saida" || falha "erro inesperado em '$1': $saida"
  ok "recusado pelo trigger: $1"
}
# As 4 escritas que os triggers barram: no extrato em R$, no de créditos, no gateway e na auditoria recente.
recusas() {
  espera_recusa "UPDATE wallet_transactions SET amount = amount"
  espera_recusa "DELETE FROM credit_transactions"
  espera_recusa "UPDATE payment_events SET status = 'x'"
  espera_recusa "DELETE FROM audit_logs WHERE created_at > NOW() - INTERVAL 1 DAY"
}

verificar() {
  work="$(mktemp -d)"
  bk="$work/backups"
  mkdir -p "$bk"
  export BACKUP_MODE=direto DB_HOST DB_PORT DB_ROOT_PASSWORD DB_NAME="$TEST_DB_NAME" BACKUP_DIR="$bk"

  dados_de_exemplo

  passo "3. foto do banco antes do backup"
  fotografar "$work/antes.txt"
  local tabelas triggers migrations esperadas
  tabelas="$(q "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'")"
  triggers="$(q "SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = DATABASE()")"
  migrations="$(q "SELECT COUNT(*) FROM schema_migrations")"
  esperadas=$(($(find apps/api/db/migrations -maxdepth 1 -name '*.sql' | wc -l) + 1))
  [ "$migrations" = "$esperadas" ] || falha "schema_migrations tem $migrations linhas; esperado $esperadas (baseline + migrations)"
  [ "$triggers" -ge 8 ] || falha "só $triggers triggers; a 0046 cria 8"
  q "SELECT DISTINCT definer FROM information_schema.triggers WHERE trigger_schema = DATABASE()" | grep -qx "$APP_USER@%" ||
    falha "os triggers deviam ter DEFINER $APP_USER@%"
  ok "$tabelas tabelas, $triggers triggers (DEFINER $APP_USER@%), $migrations migrations registradas"

  passo "4. backup como o serviço de produção (agendador.sh agora), BACKUP_KEEP=3"
  backup_falso escambo-20000101-000001.sql.gz 60    # 1 h: entre os 3 mais recentes → fica
  backup_falso escambo-20000101-000002.sql.gz 1440  # 1 dia: entre os 3 mais recentes → fica
  backup_falso escambo-20000101-000003.sql.gz 2880  # 2 dias: fora dos 3, mas com menos de 3 dias → fica
  backup_falso escambo-20000101-000004.sql.gz 14400 # 10 dias: fora dos 3 e velho → sai
  backup_falso uploads-20000101-000001.tgz 60
  backup_falso uploads-20000101-000002.tgz 1440
  backup_falso uploads-20000101-000004.tgz 14400 # 4º mais recente e velho → sai
  BACKUP_KEEP=3 UPLOADS_DIR="$work/dados" BACKUP_METRICS_DIR="$work/metricas" \
    bash deploy/backup/agendador.sh agora || falha "o agendador.sh agora falhou"

  local status arquivo pacote sha
  status="$bk/last-backup.json"
  [ -f "$status" ] || falha "sem last-backup.json"
  grep -q '"status": "ok"' "$status" || falha "last-backup.json não diz ok: $(cat "$status")"
  arquivo="$(sed -n 's/^  "db": .*"file": "\([^"]*\)".*/\1/p' "$status")"
  pacote="$(sed -n 's/^  "uploads": .*"file": "\([^"]*\)".*/\1/p' "$status")"
  sha="$(sed -n 's/^  "db": .*"sha256": "\([0-9a-f]*\)".*/\1/p' "$status")"
  [[ "$arquivo" =~ ^escambo-[0-9]{8}-[0-9]{6}\.sql\.gz$ && -f "$bk/$arquivo" ]] || falha "dump não encontrado: '$arquivo'"
  [[ "$pacote" =~ ^uploads-[0-9]{8}-[0-9]{6}\.tgz$ && -f "$bk/$pacote" ]] || falha "pacote não encontrado: '$pacote'"
  (cd "$bk" && sha256sum -c --quiet "$arquivo.sha256" "$pacote.sha256") || falha "checksum dos backups"
  [ "$sha" = "$(cut -d' ' -f1 "$bk/$arquivo.sha256")" ] || falha "sha256 do last-backup.json diferente do .sha256"
  ok "last-backup.json: $arquivo ($(du -h "$bk/$arquivo" | cut -f1)) e $pacote, checksums conferem"
  [ "$(gunzip -c "$bk/$arquivo" | grep -c '^/\*!50003 CREATE\*/ /\*!50017 DEFINER=.* TRIGGER ')" = "$triggers" ] ||
    falha "o dump não traz os $triggers triggers"
  if gunzip -c "$bk/$arquivo" | grep -q '; \*/;;$'; then falha "o dump ainda tem trigger com ';' antes do ' */;;' (não reimporta)"; fi
  ok "o dump traz os $triggers triggers (com DEFINER), no formato que o mysql reimporta"

  for f in escambo-20000101-000001.sql.gz escambo-20000101-000002.sql.gz escambo-20000101-000003.sql.gz \
    uploads-20000101-000001.tgz uploads-20000101-000002.tgz; do
    [ -f "$bk/$f" ] || falha "a retenção apagou $f, que devia ficar"
  done
  for f in escambo-20000101-000004.sql.gz uploads-20000101-000004.tgz; do
    if [ -e "$bk/$f" ] || [ -e "$bk/$f.sha256" ]; then falha "a retenção não apagou $f (e o .sha256)"; fi
  done
  ok "retenção: ficaram os 3 mais recentes e o de 2 dias; saíram os de 10 dias além dos 3"

  local linha prom="$work/metricas/escambo_backup.prom"
  for linha in 'escambo_backup_last_success_timestamp_seconds\{kind="db"\} [0-9]+' \
    'escambo_backup_last_success_timestamp_seconds\{kind="uploads"\} [0-9]+' 'escambo_backup_last_run_success 1'; do
    grep -Eqx "$linha" "$prom" || falha "métrica do textfile sem /$linha/: $(cat "$prom")"
  done
  bash deploy/backup/agendador.sh saude >/dev/null || falha "agendador.sh saude devia dar ok logo depois do backup"
  BACKUP_MAX_AGE_HOURS=1 bash deploy/backup/agendador.sh saude >/dev/null ||
    falha "com 1 h de tolerância, um backup de agora ainda está em dia"
  [ "$(BACKUP_HOUR=3 bash deploy/backup/agendador.sh proximo | cut -d' ' -f2)" = 03:00 ] || falha "BACKUP_HOUR=3 devia agendar às 03:00"
  if BACKUP_HOUR=25:00 bash deploy/backup/agendador.sh proximo >/dev/null 2>&1; then falha "BACKUP_HOUR=25:00 devia ser recusado"; fi
  ok "métrica escambo_backup_*, saúde e horário (BACKUP_HOUR) conferem"

  mkdir -p "$work/extraido"
  tar xzf "$bk/$pacote" -C "$work/extraido"
  if [ "$(arvore "$work/dados/uploads")" != "$(arvore "$work/extraido/uploads")" ] ||
    [ "$(arvore "$work/dados/media")" != "$(arvore "$work/extraido/media")" ]; then
    falha "o pacote não traz uploads/ e media/ iguais aos originais"
  fi
  [ ! -e "$work/extraido/exports" ] || falha "o pacote não devia levar exports/ (cópias LGPD temporárias)"
  ok "pacote dos arquivos: uploads/ e media/ idênticos, sem exports/"

  passo "5. arquivo ruim é recusado antes de tocar no banco"
  mkdir -p "$work/ruim"
  head -c "$(($(stat -c %s "$bk/$arquivo") / 2))" "$bk/$arquivo" >"$work/ruim/escambo-cortado.sql.gz"
  if bash scripts/restore-db.sh "$work/ruim/escambo-cortado.sql.gz" --yes >/dev/null 2>&1; then falha "restaurou um dump cortado"; fi
  cp "$bk/$arquivo" "$work/ruim/escambo-adulterado.sql.gz"
  echo "$(printf '0%.0s' {1..64})  escambo-adulterado.sql.gz" >"$work/ruim/escambo-adulterado.sql.gz.sha256"
  if bash scripts/restore-db.sh "$work/ruim/escambo-adulterado.sql.gz" --yes >/dev/null 2>&1; then falha "restaurou com o checksum errado"; fi
  fotografar "$work/depois-da-recusa.txt"
  iguais "$work/antes.txt" "$work/depois-da-recusa.txt" || falha "uma restauração recusada mexeu no banco"
  ok "dump cortado e checksum errado recusados; banco intacto"

  passo "6. apaga o banco, recria vazio e restaura um dump no formato de antes da 1.46.0"
  printf '%s\n' "DROP DATABASE \`$TEST_DB_NAME\`;" \
    "CREATE DATABASE \`$TEST_DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" | root_sql
  [ "$(q "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()")" = 0 ] || falha "o banco devia estar vazio"
  ok "banco vazio"
  # Os backups feitos entre a 1.45.0 e a 1.46.0 (mysqldump puro) têm os 7 triggers de uma instrução
  # só da 0046, com o ";" dentro do comentário. O dump novo tem esses triggers em BEGIN ... END (0049):
  # o formato antigo é refeito tirando o BEGIN e levando o " */;;" do END para a linha do ";".
  mkdir -p "$work/antigo"
  gunzip -c "$bk/$arquivo" | awk '
    / FOR EACH ROW BEGIN$/ { sub(/ BEGIN$/, "") }
    /^ *END \*\/;;$/ && tem && anterior ~ /;$/ { anterior = anterior " */;;"; next }
    { if (tem) print anterior; anterior = $0; tem = 1 }
    END { if (tem) print anterior }
  ' | gzip >"$work/antigo/escambo-formato-antigo.sql.gz"
  [ "$(gunzip -c "$work/antigo/escambo-formato-antigo.sql.gz" | grep -c '; \*/;;$')" -ge 7 ] ||
    falha "o dump no formato antigo devia ter os 7 triggers com ';' antes do ' */;;'"
  bash scripts/restore-db.sh "$work/antigo/escambo-formato-antigo.sql.gz" --yes | sed 's/^/   /' ||
    falha "a restauração do dump no formato antigo falhou"
  # Os triggers voltam na forma da 0046 (é o que o dump antigo guardava; o job migrate da produção
  # roda a 0049 depois da restauração): aqui eles são conferidos por contagem e pela recusa, e o resto
  # do banco tem de voltar idêntico.
  fotografar "$work/depois-do-antigo.txt"
  if ! iguais <(sem_triggers "$work/antes.txt") <(sem_triggers "$work/depois-do-antigo.txt"); then
    mostrar_diferenca "$work/antes.txt" "$work/depois-do-antigo.txt"
    falha "o dump no formato antigo voltou diferente do original (linhas acima)"
  fi
  [ "$(q "SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = DATABASE()")" = "$triggers" ] ||
    falha "o dump no formato antigo não trouxe os $triggers triggers"
  recusas
  ok "dump antigo restaurado: dados e estrutura iguais ao original, $triggers triggers funcionando"

  passo "7. restaura o backup novo (scripts/restore-db.sh) e compara com a foto de antes"
  bash scripts/restore-db.sh "$bk/$arquivo" --yes | sed 's/^/   /' || falha "a restauração falhou"
  fotografar "$work/depois.txt"
  if ! iguais "$work/antes.txt" "$work/depois.txt"; then
    mostrar_diferenca "$work/antes.txt" "$work/depois.txt"
    falha "o banco restaurado é diferente do original (linhas acima)"
  fi
  ok "$tabelas tabelas com as mesmas linhas, CHECKSUM e estrutura; $triggers triggers e $migrations migrations iguais"
  recusas
  fotografar "$work/depois-das-recusas.txt"
  iguais "$work/antes.txt" "$work/depois-das-recusas.txt" || falha "uma tentativa recusada mudou o banco"
  ok "nenhuma linha mudou com as tentativas"

  printf '\nBackup e restauração conferidos: %s tabelas, %s triggers, %s migrations, dump de %s.\n' \
    "$tabelas" "$triggers" "$migrations" "$(du -h "$bk/$arquivo" | cut -f1)"
}

# --- modo --docker: MySQL e clientes em contêineres temporários -------------------------------------

modo_docker() {
  local imagem=mysql:8.0 senha=raiz-do-teste-de-backup repo porta i
  conteiner=tmp-backup-test-mysql
  rede=tmp-backup-test-net
  repo="$(pwd -W 2>/dev/null || pwd)" # Git Bash no Windows: caminho que o Docker Desktop entende
  export MSYS_NO_PATHCONV=1
  docker rm -f "$conteiner" >/dev/null 2>&1 || true
  docker network create "$rede" >/dev/null 2>&1 || true

  passo "MySQL descartável ($conteiner, $imagem)"
  docker run -d --name "$conteiner" --network "$rede" -p 127.0.0.1::3306 -e MYSQL_ROOT_PASSWORD="$senha" \
    "$imagem" --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci \
    --log-bin-trust-function-creators=1 >/dev/null
  for i in $(seq 1 60); do
    # Durante a inicialização o servidor temporário não escuta TCP: ping no 127.0.0.1 = pronto de verdade.
    docker exec "$conteiner" mysqladmin ping -h127.0.0.1 -uroot -p"$senha" --silent >/dev/null 2>&1 && break
    [ "$i" -lt 60 ] || falha "o MySQL temporário não subiu"
    sleep 2
  done
  porta="$(docker port "$conteiner" 3306/tcp | head -n 1 | sed 's/.*://')"
  ok "no ar (127.0.0.1:$porta)"

  cliente() {
    docker run --rm --network "$rede" -v "$repo:/repo:ro" -w /repo --entrypoint bash \
      -e DB_HOST="$conteiner" -e DB_PORT=3306 -e DB_ROOT_PASSWORD="$senha" -e TEST_DB_NAME="$TEST_DB_NAME" \
      -e TEST_APP_USER="$APP_USER" -e TEST_APP_PASSWORD="$APP_PASSWORD" \
      "$imagem" scripts/test-backup-restore.sh "$@"
  }
  cliente preparar
  DB_HOST=127.0.0.1 DB_PORT="$porta" DB_ROOT_PASSWORD="$senha" migrar
  cliente verificar
}

case "${1:-}" in
  --docker) modo_docker ;;
  preparar) preparar ;;
  migrar) migrar ;;
  verificar) verificar ;;
  "")
    : "${DB_HOST:?defina DB_HOST, DB_PORT e DB_ROOT_PASSWORD (ou use --docker)}"
    limpar_no_fim=1
    preparar
    migrar
    verificar
    ;;
  *)
    echo "uso: scripts/test-backup-restore.sh [--docker]" >&2
    exit 2
    ;;
esac
