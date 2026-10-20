#!/usr/bin/env bash
# Higiene de segredos do repositório (RNF-020). Roda no CI (job `segredos`) e à mão:
#
#   scripts/segredos.sh              # .gitignore + arquivos versionados + gitleaks no histórico (Docker)
#   scripts/segredos.sh --sem-docker # só as duas primeiras partes (sem Docker na máquina)
#
# 1. O .gitignore cobre o que guarda segredo ou dado pessoal: os .env de cada pasta (menos os
#    modelos .example), chaves (.pem, .key), os backups (dumps com dados pessoais) e os dados da API
#    (anexos, cópias LGPD). Confere com `git check-ignore`, que aplica as regras como o git aplica.
# 2. Nenhum arquivo desse tipo está versionado (um `git add -f` passa pelo .gitignore).
# 3. gitleaks (regras padrão + .gitleaks.toml) em todos os commits: um segredo apagado num commit
#    seguinte continua no histórico e continua vazado. Na falha, o valor sai mascarado.
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash no Windows: não converter /repo em caminho do Windows
cd "$(dirname "$0")/.."

GITLEAKS_IMAGE='ghcr.io/gitleaks/gitleaks:v8.28.0@sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854'
falhou=0
erro() {
  printf 'FALHOU: %s\n' "$*" >&2
  falhou=1
}

echo "== 1. o .gitignore cobre os arquivos de segredo"
for caminho in .env .env.local .env.production apps/api/.env apps/api/.env.test apps/web/.env \
  apps/web/.env.local deploy/.env certificado.pem chave.key apps/api/chave.pem \
  backups/escambo-20260101-030000.sql.gz backups/last-backup.json \
  apps/api/data/uploads/2026/10/anexo.pdf apps/api/data/exports/copia.json; do
  git check-ignore -q --no-index "$caminho" || erro "o .gitignore não cobre $caminho"
done
for modelo in .env.example .env.prod.example apps/api/.env.example apps/web/.env.example; do
  if git check-ignore -q --no-index "$modelo"; then erro "o .gitignore esconde o modelo $modelo"; fi
done
[ "$falhou" = 0 ] && echo "   ok"

echo "== 2. nenhum arquivo de segredo versionado"
versionados="$(git ls-files | grep -E '(^|/)\.env($|\.)|\.(pem|key|p12|pfx)$|(^|/)id_(rsa|ed25519|ecdsa)($|\.)|(^|/)backups/' |
  grep -vE '(^|/)\.env(\.prod)?\.example$' || true)"
if [ -n "$versionados" ]; then
  erro "arquivos de segredo no repositório:"
  printf '   %s\n' "$versionados" >&2
else
  echo "   ok"
fi

if [ "${1:-}" != --sem-docker ]; then
  echo "== 3. gitleaks no histórico inteiro"
  # Monta a pasta dona do histórico: num worktree, o .git é um arquivo que aponta para o repositório
  # principal, fora do contêiner. O config vai à parte (o do repositório principal pode ser outro), e
  # `--all` lê todas as branches. O safe.directory vai por variável (configuração de linha de
  # comando do git): a pasta montada tem outro dono, e o git do contêiner a recusaria.
  dono="$(cd "$(git rev-parse --git-common-dir)/.." && (pwd -W 2>/dev/null || pwd))"
  config="$(pwd -W 2>/dev/null || pwd)/.gitleaks.toml"
  saida="$(mktemp)"
  if docker run --rm -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0=/repo -v "$dono:/repo:ro" -v "$config:/gitleaks.toml:ro" \
    "$GITLEAKS_IMAGE" git /repo --config /gitleaks.toml --log-opts=--all --no-banner --no-color --redact \
    --exit-code 1 >"$saida" 2>&1; then rc=0; else rc=$?; fi
  sed 's/^/   /' "$saida"
  # Erro do git dentro do contêiner não muda o código de saída: "0 commits" seria um falso verde.
  if grep -q ' ERR ' "$saida" || ! grep -Eq ' [1-9][0-9]* commits scanned' "$saida"; then
    erro "o gitleaks não leu o histórico (linhas acima)"
  elif [ "$rc" != 0 ]; then
    erro "o gitleaks achou segredo no histórico (acima, mascarado). Se for dado de teste, acrescente o valor a .gitleaks.toml"
  else
    echo "   ok"
  fi
  rm -f "$saida"
fi

[ "$falhou" = 0 ] || exit 1
echo "Sem segredo no repositório."
