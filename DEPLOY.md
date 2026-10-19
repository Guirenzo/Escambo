# Deploy do Escambo numa VPS

Uma VPS pequena (1 vCPU / 2 GB) com Docker e um domínio bastam. O CI publica as imagens no GitHub
Container Registry a cada merge em `main`, e o workflow **Deploy** as põe no ar na VPS (seção 3). Nada é
compilado no servidor, e ninguém entra nele para atualizar.

```
                     ┌───────────────────────────── VPS ──────────────────────────────┐
  navegador ──443──▶ │ caddy (HTTPS automático) ──▶ web (nginx: SPA + proxy) ──▶ api ──▶ db │
                     │                                    /api, /socket.io        │      MySQL 8 │
                     │  volumes: escambo_db_data · escambo_api_data · caddy_data              │
                     └────────────────────────────────────────────────────────────────┘
```

| Peça         | Imagem                               | Quem constrói                                                                          |
| ------------ | ------------------------------------ | -------------------------------------------------------------------------------------- |
| API          | `ghcr.io/guirenzo/escambo-api:<tag>` | job **Publicar imagens** do CI, só em `main` com os testes, o E2E e a cobertura verdes |
| Web          | `ghcr.io/guirenzo/escambo-web:<tag>` | idem                                                                                   |
| Banco, borda | `mysql:8.0`, `caddy:2-alpine`        | oficiais                                                                               |

Tags publicadas: `latest`, o sha curto do commit (ex.: `a1b2c3d`) e a versão do `package.json` (ex.: `1.2.0`).
`GET /api/health` devolve `version` e `commit` — é assim que se confere o que está no ar.

**1.42.0 (ADR 61):** a etapa 11 corrigiu a ordem de contas/carteiras e construiu novas imagens API/web do snapshot `966ef3956e2fe90a`, rótulo `local-adr61-966ef3956e2fe90a`. Smoke MySQL/migração/reparo idempotente, exportação persistente e 34 E2Es desktop/mobile passaram nessas imagens. Imagens, cobertura e seis E2Es da etapa 10 identificam o snapshot anterior, sem a correção posterior. A validação `config -q` do Compose de produção/monitoramento também pertence à etapa 10. Essas provas locais não publicam imagens nem validam o destino da VPS, o Caddy/HTTPS ou a restauração de backup. Provas completas, identificação dos snapshots e limites em [validação de entrega](./docs/validacao-entrega-adr61.md). A demonstração pública permanece na 1.41.1.

## 1. Pré-requisitos

- VPS Ubuntu 22.04+ (ou qualquer Linux com Docker Engine 24+ e o plugin `docker compose` v2.24+).
- Um domínio com registro **A** (e AAAA, se houver IPv6) apontando para o IP da VPS.
- Portas **80** e **443** abertas (o Caddy precisa da 80 para emitir o certificado).
- Um SMTP para os e-mails transacionais (confirmação de e-mail, redefinição de senha, avisos). Qualquer
  provedor com SMTP serve; sem ele, `MAIL_PROVIDER=simulated` guarda os e-mails na caixa de saída do admin.

```bash
# Docker (script oficial) + usuário no grupo docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER" && newgrp docker
# Firewall mínimo
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp && sudo ufw enable
```

## 2. Primeira subida

Poucos arquivos vão para a VPS: o compose de produção, o `Caddyfile` e a página de fora do ar, o `.env` e (opcional) os
scripts de backup. Não precisa clonar o repositório. A configuração do monitoramento (`deploy/monitoring/`,
opcional) chega sozinha no primeiro deploy pelo workflow Deploy (seção 3).

```bash
sudo mkdir -p /opt/escambo && sudo chown "$USER" /opt/escambo && cd /opt/escambo
base=https://raw.githubusercontent.com/Guirenzo/Escambo/main
curl -fsSLO "$base/docker-compose.prod.yml"
mkdir -p deploy/status scripts
curl -fsSL "$base/deploy/Caddyfile" -o deploy/Caddyfile
curl -fsSL "$base/deploy/status/fora-do-ar.html" -o deploy/status/fora-do-ar.html
curl -fsSL "$base/scripts/backup-db.sh"  -o scripts/backup-db.sh
curl -fsSL "$base/scripts/backup-uploads.sh" -o scripts/backup-uploads.sh
curl -fsSL "$base/scripts/restore-db.sh" -o scripts/restore-db.sh
chmod +x scripts/*.sh
curl -fsSL "$base/.env.prod.example" -o .env
```

Edite o `.env` (tudo marcado como obrigatório precisa de valor; o compose se recusa a subir sem):

```bash
nano .env
# DOMAIN, ACME_EMAIL, ADMIN_EMAILS, MAIL_FROM, SMTP_*  →  os seus
# DB_PASSWORD, DB_ROOT_PASSWORD, JWT_SECRET            →  openssl rand -base64 48
```

As imagens são privadas por padrão no GHCR. Ou torne-as públicas uma vez (GitHub → seu perfil →
**Packages** → `escambo-api` / `escambo-web` → _Package settings_ → _Change visibility_), ou faça login
na VPS com um token que tenha `read:packages`:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u guirenzo --password-stdin
```

Suba:

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps          # db, api, web, caddy "healthy"; migrate "exited (0)"
curl -s https://SEU_DOMINIO/api/health                # {"status":"ok","db":"up","version":"…","commit":"…"}
```

A ordem é `db` (healthy) → `migrate` (baseline + migrations + seed do catálogo, e sai) → `api` → `web` →
`caddy`. O Caddy emite o certificado no primeiro acesso (alguns segundos; a porta 80 precisa estar aberta).

**Primeiro admin:** cadastre-se no app com um e-mail que esteja em `ADMIN_EMAILS` — a conta já nasce admin
(painel `/admin`: métricas, mediação, fila de saques, caixa de saída de e-mails, pedidos LGPD).

> Para operar sem um SMTP no começo, use `MAIL_PROVIDER=simulated`: os e-mails ficam na caixa de saída do
> painel admin (com os links de confirmação e de redefinição de senha), e nada é enviado.

> O relatório diário da meta da moderação (ADR 55) vai por e-mail a **toda conta admin** que consegue entrar,
> a partir das `DIGEST_HOUR` de Brasília, só quando a meta estoura — inclusive antes de o e-mail ser
> confirmado. Com o provedor simulado ele fica na caixa de saída; a linha "Relatório diário da meta" no
> cartão de saúde da moderação diz o que ele está fazendo, e a chave "Relatório da meta da moderação" nos
> parâmetros da plataforma o desliga.

## 3. Atualizar e voltar atrás

**Automático (ADR 59).** Cada merge em `main` com o CI verde dispara o workflow **Deploy**
(`.github/workflows/deploy.yml`). Ele descobre o commit da imagem, copia para a VPS o
`docker-compose.prod.yml` e a pasta `deploy/` daquele commit, puxa as imagens, grava `IMAGE_TAG=<sha curto>`
no `.env`, faz `up -d` (o job de migrations roda antes da API, como sempre), recarrega o Caddy, reinicia o
monitoramento se a configuração dele mudou e só fica verde quando o `GET /api/health` mostra o commit
esperado. Se a subida ou a conferência falham, a VPS volta sozinha para a tag e a configuração anteriores. Um
deploy por vez. O SSH é só o transporte do pipeline, com uma chave exclusiva: ninguém entra na VPS para
atualizar.

Para ligar, uma vez: crie o ambiente `production` em **Settings → Environments** com os segredos
`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` (uma chave só do deploy) e `DEPLOY_KNOWN_HOSTS` (a saída
conferida de `ssh-keyscan -H SEU_HOST`; com outra porta, `ssh-keyscan -p PORTA -H SEU_HOST`), e a variável
`DEPLOY_URL` (`https://SEU_DOMINIO`); `DEPLOY_PATH` e `DEPLOY_PORT` se não forem `/opt/escambo` e 22. O
passo a passo está em [Deploy e CI/CD](./docs/wiki/Deploy-e-CI-CD.md). Sem esses valores o workflow termina
verde avisando que o deploy está desligado.

**Rollback:** **Actions → Deploy → Run workflow** (na `main`), com a tag anterior (sha curto ou versão,
visíveis na página do pacote no GitHub). Vai junto a configuração do commit daquela imagem. As migrations são
aditivas (forward-only), então uma imagem anterior continua funcionando sobre o schema mais novo.

**À mão** (só se o GitHub Actions estiver fora do ar): na VPS, troque a tag e suba. O workflow deixa a tag
fixa no `.env`, então `pull` e `up -d` sozinhos não atualizam nada.

```bash
cd /opt/escambo
sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=<sha curto ou versão>/' .env
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml exec caddy caddy reload --config /etc/caddy/Caddyfile   # se o Caddyfile mudou
curl -s https://SEU_DOMINIO/api/health   # confira o commit
```

Se o compose ou a pasta `deploy/` mudaram naquela versão, baixe-os de novo antes (os `curl` da seção 2).

**Fora do ar (RNF-010):** se o web (nginx) não responde, o Caddy serve `deploy/status/fora-do-ar.html`, que tenta de novo sozinha a cada 30 s. Se a API cai e o web está de pé, o nginx devolve às chamadas do app um 503 em JSON (`service_unavailable`), e o app troca a tela pela de fora do ar até a API voltar. O modo de manutenção (ADR 33) continua sendo o caminho para uma parada planejada.

Guarde a tag que está no ar antes de uma mudança grande:

```bash
curl -s https://SEU_DOMINIO/api/health | grep -o '"commit":"[^"]*"'
```

### Atualizar para a 1.39.0 (prazos, ADR 57)

A 1.39.0 muda como os prazos das contratações contam e traz duas migrations, a 0027 e a 0028, com um
reparo no fim do `migrate` que preenche as horas das contratações em andamento. A atualização é a de
sempre (pelo workflow Deploy ou, à mão, como na seção 3); os passos abaixo são as conferências em volta dela.

**1. Antes: fotografia do banco.** Consultas só de leitura, no console do MySQL (tabela da seção 5).
Mesmo sem alterar nada, é o banco de produção: mostre o comando a quem responde pelo deploy e espere
o ok antes de rodar. Anote os números para comparar no passo 3.

```sql
-- contratações já avisadas do atraso, por status (em revisão, saem da disputa automática)
SELECT status, COUNT(*) FROM contracts WHERE overdue_notified_at IS NOT NULL GROUP BY status;
-- pedidos de extensão pendentes: há quantas horas foram feitos e se a data pedida está perto
SELECT id, status, TIMESTAMPDIFF(HOUR, extension_requested_at, NOW()) AS horas,
       extension_deadline_at < NOW() + INTERVAL 12 HOUR AS data_perto
  FROM contracts WHERE extension_status = 'pending';
-- entregas e marcos esperando o cliente (ganham a hora da aprovação tácita)
SELECT COUNT(*) FROM contracts WHERE status = 'delivered';
SELECT COUNT(*) FROM contract_milestones WHERE status = 'delivered';
```

Os pedidos pendentes passam a contar como o primeiro dos dois, e o cliente tem até 48 h a partir do
deploy para responder (nunca de madrugada, e antes da data pedida); os com `data_perto = 1` (data
pedida perto ou passada) expiram na primeira rodada de dia, e os de contratações que já saíram da vez
de quem entrega (em revisão, por exemplo) são encerrados (`closed`).

**2. O deploy.** Pelo workflow Deploy; à mão, com `IMAGE_TAG=1.39.0` no `.env`:

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

O job `migrate` aplica a 0027 (contratações: cinco colunas, dois valores novos no status do pedido
de extensão e quatro índices) e a 0028 (marcos: a hora da aprovação tácita e um índice), um ALTER
cada, e no fim roda o reparo dos prazos; a API nova só sobe depois dele. Por alguns segundos a API
antiga ainda está no ar sobre o esquema novo: o que ela gravar nesse intervalo o reparo acerta na
primeira rodada dos jobs da API nova, mas uma disputa aberta por ela não volta sozinha (passo 4).
`JOBS_INTERVAL_MS` passa a ter teto de 30 min: se você o define fora do compose com valor maior, o
`migrate` e a API nova recusam o valor e não sobem.

**3. Depois: conferir o reparo.**

```bash
docker compose -f docker-compose.prod.yml logs migrate | grep 'Prazos reparados'
curl -s https://SEU_DOMINIO/api/health   # "version":"1.39.0"
```

A linha traz, em `reparo`, quantas linhas cada caso preencheu. `graceEnds` (carências em curso, que
terminam na hora já prometida, levada para as 9h se cairia de noite) deve bater com as linhas
`accepted` e `in_progress` da primeira consulta do passo 1; `approvalDue` e `milestoneApprovalDue`,
com as contagens de `delivered`; `respondBy` mais `closedExtensions`, com os pedidos pendentes (salvo
o que mudou no intervalo). Se no lugar dela aparecer "Reparo dos prazos falhou", a API tenta de novo
na primeira rodada dos jobs. No console do MySQL, as quatro consultas abaixo precisam dar 0:

```sql
SELECT COUNT(*) FROM contracts WHERE status = 'delivered' AND approval_due_at IS NULL;
SELECT COUNT(*) FROM contracts WHERE extension_status = 'pending' AND extension_respond_by IS NULL;
SELECT COUNT(*) FROM contracts WHERE status IN ('accepted','in_progress') AND overdue_notified_at IS NOT NULL AND grace_ends_at IS NULL;
SELECT COUNT(*) FROM contracts WHERE status = 'pending' AND barter_agreement_id IS NULL AND proposal_expires_at IS NULL;
```

O reparo trata até 200 linhas por caso a cada rodada: se alguma der mais que 0, espere uma rodada
dos jobs e rode de novo; se não baixar, veja o log da API (`"job":"repair-deadlines"`).

**4. Disputas automáticas abertas por engano.** A regra nova não mexe em disputa já aberta. Esta
consulta, só de leitura, lista as disputas automáticas por prazo ainda não resolvidas numa
contratação que já tinha entrega antes da disputa, ou, por marcos, sem nenhum marco financiado
nunca entregue — as que a 1.39.0 não teria aberto. Não há correção automática: o admin resolve cada
uma pela fila de mediação do painel (liberar, devolver ou dividir), olhando a linha do tempo. Rode
de novo alguns minutos depois do deploy, para pegar alguma que a API antiga tenha aberto na troca.

```sql
SELECT d.id, d.contract_id, d.created_at
  FROM disputes d JOIN contracts c ON c.id = d.contract_id
 WHERE d.reason = 'deadline' AND d.status <> 'resolved'
   AND d.description LIKE 'Aberta automaticamente%'
   AND ( EXISTS (SELECT 1 FROM deliveries x WHERE x.contract_id = c.id AND x.created_at < d.created_at)
      OR ( EXISTS (SELECT 1 FROM contract_milestones m WHERE m.contract_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM contract_milestones m
                            WHERE m.contract_id = c.id AND m.status = 'funded' AND m.delivered_at IS NULL) ) );
```

**5. Jobs desligados.** O reparo roda também em toda rodada dos jobs. O compose de produção deixa os
jobs ligados; se em outra instalação `JOBS_ENABLED=false` em todas as instâncias da API, rode os jobs
uma vez depois do deploy (`npm run jobs:run`; no container, o comando abaixo) ou espere o cron
externo que os roda:

```bash
docker compose -f docker-compose.prod.yml run --rm --no-deps api node dist/scripts/run-jobs.js
```

**6. Voltar para a 1.38.0** é seguro: pelo workflow Deploy com a tag `1.38.0` (ou à mão, seção 3). A API antiga ignora
as colunas novas; um pedido de extensão `expired` ou `closed` aparece para ela como status
desconhecido, e o web antigo não mostra nada dele. As migrations são só para frente: a 0027 e a 0028
continuam aplicadas, e o `migrate` da 1.38.0 não as desfaz. Com a versão antiga voltam as regras
antigas de prazo.

**7. Voltar de novo para a 1.39.0 depois de a 1.38.0 ter ficado no ar** pede um passo antes do
deploy. A 1.38.0 grava entregas, pedidos de extensão e avisos sem mexer nas horas que a 1.39.0 guarda
(`approval_due_at`, `extension_respond_by`, `grace_ends_at`) nem no contador de pedidos. O reparo só
preenche o que está vazio, então essas horas ficariam velhas: uma entrega refeita na 1.38.0 seria
aprovada pela hora da entrega anterior, um pedido feito nela expiraria na hora, e um aviso novo teria
a carência do aviso antigo. Com o backup feito, esvazie as horas das contratações que a 1.38.0 tocou
(`@desde` = quando a 1.38.0 voltou ao ar, em UTC) e deixe o reparo do `migrate` recalcular:

```sql
SET @desde = '2026-10-01 12:00:00';
UPDATE contracts SET approval_due_at = NULL WHERE status = 'delivered';
UPDATE contract_milestones SET approval_due_at = NULL WHERE status = 'delivered';
UPDATE contracts SET extension_requests = LEAST(extension_requests + 1, 2), extension_respond_by = NULL
 WHERE extension_status = 'pending' AND extension_requested_at >= @desde;
UPDATE contracts SET grace_ends_at = NULL WHERE overdue_notified_at >= @desde;
```

As entregas voltam a contar da última entrega registrada, os pedidos feitos na 1.38.0 ganham as 48 h
a partir do deploy, e os avisos dados nela ganham a carência a partir deles.

### Atualizar para a 1.45.0 (ADR 63)

Oito migrations (0040 a 0047), todas aditivas e seguras de rodar de novo, e nenhum script manual.

**1. Backup antes** (`scripts/backup-db.sh`, seção 4).

**2. O banco precisa aceitar trigger.** A 0046 cria os triggers que tornam o extrato imutável (RNF-036). Com o binlog ligado (padrão do MySQL 8), só quem tem SUPER cria trigger, e o job `migrate` roda com o usuário da aplicação. Por isso o `db` do `docker-compose.prod.yml` passa a subir com `--log-bin-trust-function-creators=1`. O deploy (workflow ou `up -d`) recria o container do banco por causa disso: alguns segundos fora do ar, com os dados intactos no volume. Para não recriar o banco agora, rode antes, como root:

```bash
docker compose -f docker-compose.prod.yml exec db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "SET PERSIST log_bin_trust_function_creators = 1"'
```

Se a 0046 falhar com o erro 1419, foi esse passo que faltou: o runner diz isso na mensagem, e o workflow volta à versão anterior.

**3. Log com rotação.** O compose de produção passa a girar o log de cada container (RNF-037: API e web até 40 × 100 MB, o resto até 5 × 20 MB, comprimidos). O `up -d` recria os containers que ganharam a configuração (Caddy, web e monitoramento inclusive).

**4. Jobs novos.**
- `report-snapshots`: grava o resumo do dia, da semana e do mês fechados para o relatório de uso do admin. Liga sozinho com os jobs (`JOBS_ENABLED`).
- `purge-audit-logs`: desligado por padrão. Para apagar o `audit_logs` antigo, configure `AUDIT_LOG_PURGE_DAYS` no `.env` com pelo menos 90 (prefira 180, o prazo do Marco Civil para registro de acesso). A API não sobe com um valor entre 1 e 89, e o banco recusa apagar linha com menos de 90 dias.

**5. Conferir.** `curl -s https://SEU_DOMINIO/api/health` mostra o commit da 1.45.0. No banco, `SHOW TRIGGERS LIKE 'wallet_transactions'` lista dois triggers. As missões começam a contar no primeiro acesso de cada freelancer depois do deploy; quem já tinha concluído uma troca ganha a missão "Primeira troca" na primeira vez que abrir o Início.

### Atualizar para a 1.44.0 (ADR 62)

Cinco migrations (0035 a 0039, todas aditivas e seguras de rodar de novo) e dois scripts, uma vez só.

**1. Chave de cifragem (opcional, recomendada, RNF-017).** Gere a chave e guarde uma cópia **fora da VPS** (no gerenciador de senhas, por exemplo): sem ela, os destinos de saque já cifrados não são mais lidos.

```bash
openssl rand -base64 32
```

No `.env` da VPS: `FIELD_ENCRYPTION_KEY=<o valor>`. Sem a chave, a API sobe e grava a chave PIX e os dados bancários em texto puro, como antes, e avisa no log na subida. Chave mal formatada (que não seja 32 bytes em base64) impede a subida, sem repetir o valor no log. Para trocar a chave: a nova em `FIELD_ENCRYPTION_KEY`, a antiga em `FIELD_ENCRYPTION_OLD_KEYS` (separadas por vírgula, só para ler), e o passo 4 de novo.

**2. Backup antes** (`scripts/backup-db.sh`, seção 4). A 0035 recria a tabela `services` (1,5 s com 20 mil serviços, 5,4 s com 100 mil) e a 0039 recria `withdrawals`: as gravações nessas tabelas esperam o fim do ALTER.

**3. Deploy normal** (workflow ou à mão, acima). O job `migrate` aplica as migrations. No deploy à mão, baixe também a página de fora do ar (o compose agora monta `deploy/status` no Caddy):

```bash
mkdir -p deploy/status
curl -fsSL "https://raw.githubusercontent.com/Guirenzo/Escambo/main/deploy/status/fora-do-ar.html" -o deploy/status/fora-do-ar.html
```

**4. Uma vez, com a API já no ar:**

```bash
# Badges que quem já cumpria o critério antes da 1.44.0 ainda não ganhou (RF-065)
docker compose -f docker-compose.prod.yml run --rm --no-deps api node dist/scripts/reevaluate-badges.js
# Só com a FIELD_ENCRYPTION_KEY: cifra os saques antigos, ainda em texto puro (RNF-017)
docker compose -f docker-compose.prod.yml run --rm --no-deps api node dist/scripts/encrypt-withdrawal-fields.js
```

Os dois são idempotentes: rodar de novo não concede nem regrava nada. O segundo sai com código 1 se algum valor cifrado não puder ser lido (chave errada); nesse caso, confira a chave antes de rodar de novo.

**5. Conferir.** `curl -s https://SEU_DOMINIO/api/health` mostra o commit da 1.44.0, e o log da API na subida diz se a cifragem está ligada (`docker compose -f docker-compose.prod.yml logs api | grep -i cifr`). No painel do admin aparecem os parâmetros novos: prazos do saque por PIX e por transferência, e a previsão de volta da manutenção.

### Atualizar para a 1.42.0 (ADR 61)

**Estado em 13/10/2026:** código e documentação locais, sem publicação/tag/deploy. A etapa 11 passou com 4.382 unitários API, 376 integrações MySQL completas e 34 E2Es desktop/mobile sobre as novas imagens Docker; união de cobertura com 99,06% das linhas e gate de 75% aprovado. Lint/typecheck/build passaram. Revisão de produção sem achado acionável, snapshot identificado e recursos QA exclusivos encerrados. A campanha G.5, os 176 E2Es completos da etapa 8 e a reprodução dos prints 23–26 são provas históricas separadas, não somadas a esses totais. Resultados, hashes e limites estão em [validação de entrega](./docs/validacao-entrega-adr61.md), [evidencias-validacao.md](./docs/evidencias-validacao.md) e [mutacoes-adr61.md](./docs/mutacoes-adr61.md). As instruções abaixo são para a futura implantação aprovada. Antes de executá-la, confira o candidato, backup, imagem/commit efetivamente publicados e mostre o comando e destino a quem autoriza. Não trate o número de versão local como uma imagem disponível no GHCR.

Conferência operacional local: 200 aceites sequenciais sem divergência de reserva e alternância 1.42.0→1.41.1→1.42.0 em banco exclusivo, com detector limpo nos quatro checkpoints, reparo sem mudanças em carteira/ledger e segunda execução idempotente. Isso não valida a infraestrutura de produção nem torna a versão antiga funcionalmente equivalente. As verificações abaixo continuam necessárias no destino real.

A etapa 11 reproduziu ciclos reais 1213 entre operações financeiras concorrentes e ordenou contas e depois carteiras por ID, após o agregado existente. Foram quatro casos RED→GREEN de carteiras, quatro de contas e dois controles adicionais de acordo, com esperas reais no InnoDB; cálculos e lançamentos foram preservados. Não há migration adicional nessa correção. O laço sequencial anterior não é prova de concorrência, e estes dez cenários não garantem ausência de todo deadlock. Consulte os resultados próprios da etapa 11 na [validação de entrega](./docs/validacao-entrega-adr61.md) ao selecionar o snapshot a publicar.

**1. Conferir antes, somente leitura.** O mysql2 lê/grava DATETIME como UTC; confira também sessão e servidor do MySQL. O histórico de entrega é usado para recuperar a primeira evidência, sem deslocamento fixo de fuso. As contagens dão dimensão do reparo e dos contratos que passarão a mostrar uma espera manual; nenhuma desistência antiga será importada.

```sql
SELECT @@session.time_zone, @@global.time_zone, @@system_time_zone;
SELECT status, COUNT(*) FROM contracts
 WHERE status IN ('pending','accepted','in_progress','delivered','revision_requested','disputed')
 GROUP BY status;
SELECT COUNT(*) FROM contracts WHERE status = 'pending' AND barter_agreement_id IS NULL;
SELECT COUNT(*) FROM contracts c WHERE c.status IN ('delivered','revision_requested')
 AND (SELECT MIN(d.created_at) FROM deliveries d WHERE d.contract_id = c.id)
     > UTC_TIMESTAMP() - INTERVAL 48 HOUR;
-- Detector de reserva do cliente: deve retornar zero linhas antes e depois.
-- LEFT JOIN também encontra proposta sem nenhuma linha de reserva.
SELECT c.id, c.status, c.price, COALESCE(SUM(t.pending_delta), 0) AS held
 FROM contracts c LEFT JOIN wallet_transactions t
   ON t.contract_id = c.id AND t.user_id = c.client_id
 WHERE c.payment_mode = 'cash' AND c.barter_agreement_id IS NULL
 GROUP BY c.id, c.status, c.price
 HAVING held <> IF(c.status = 'pending', c.price, 0);
```

Essa consulta confere a reserva do cliente, e não a totalidade de todos os ledgers. Se já encontrar divergência antes da implantação, investigue a contratação e o histórico; não corrija saldo por um UPDATE inferido desta página. A lista de entregas recentes acima cobre entrega única; a conferência completa de evidências também inclui marcos e histórico, como o reparo.

**2. Aplicar o candidato aprovado.** O workflow padrão confere commit no health. Para atualização manual, depois de definir IMAGE_TAG para a imagem aprovada no .env e confirmar o destino, os comandos continuam os da seção 3:

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```

O serviço migrate aplica 0031 (ofertas/desistências, taxa/vez/revisões/entrega, duas configurações), 0032 (revisões e janela por marco) e 0033 (kind counter_offer no livro de lembretes), e chama repair-deadlines. O reparo recupera primeira entrega e snapshots **antes** de inferir tácitas ausentes; no final cria oferta 1 de pending não troca/seq 1 e fecha ofertas abertas de contratos fora de pending. Taxa/valores históricos são preservados. Contratos já registrados com limite NULL continuam ilimitados; novas contratações gravam dois. Uma proposta de troca antiga aceita após a implantação cria dois contratos novos, cada um com duas revisões incluídas; a data da proposta de troca não torna esses contratos novos ilimitados. freelancer_dropouts nasce vazia.

**3. Conferir depois.** Use o endereço real do ambiente em GET /api/health; confira version 1.42.0 e commit da imagem aprovada, saída zero do migrate e os contadores firstDelivery, deliveryDisputeSnapshot, milestoneDisputeSnapshot, offerOne e closedOffers no log do reparo. Ele é limitado a 200 candidatas por passo e volta em toda rodada; grandes bases podem precisar de mais de uma rodada para zerar pendências.

```sql
SELECT COUNT(*) FROM contracts c
 WHERE c.status = 'pending' AND c.barter_agreement_id IS NULL AND c.offer_seq = 1
   AND NOT EXISTS (SELECT 1 FROM contract_offers o WHERE o.contract_id = c.id);
SELECT COUNT(*) FROM contracts c
 WHERE c.status IN ('accepted','in_progress','delivered','revision_requested','disputed')
   AND c.first_delivery_at IS NULL
   AND (EXISTS (SELECT 1 FROM deliveries d WHERE d.contract_id = c.id)
     OR EXISTS (SELECT 1 FROM contract_milestones m WHERE m.contract_id = c.id AND m.delivered_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM contract_status_history h WHERE h.contract_id = c.id
                 AND (h.new_status = 'delivered' OR h.note LIKE 'Marco «%» entregue:%')));
SELECT COUNT(*) FROM contract_offers o JOIN contracts c ON c.id = o.contract_id
 WHERE o.outcome = 'open' AND c.status <> 'pending';
SELECT key_name, value FROM platform_settings
 WHERE key_name IN ('counter_offer_response_hours','extension_response_hours');
SELECT COUNT(*) AS reviews_to_reconcile FROM freelancer_dropouts WHERE review_checked_at IS NULL;
SELECT kind, COUNT(*) FROM deadline_reminders GROUP BY kind;
-- Repetir o detector de reserva do passo 1: zero linhas.
```

As três primeiras consultas zeram após o reparo das candidatas, salvo novas mudanças concorrentes. Os parâmetros devem existir com valores dentro de 24–168 h; o padrão é 48 e a reaplicação conserva escolha do admin. Pendências review_checked_at são processadas pelo novo reconcile-dropout-reviews, lote normal de 100; falha deixa pendência para nova rodada. Há 15 jobs, habilitados em **uma instância**. Conferir no app parâmetros, hora de contraproposta/extensão, revisões/abertura manual e faixas legais: Política 1.5 primeiro (aceitar/não aceitar), Termos 1.5 depois (informativa). A recusa da Política não deve ocultar contagem pública.

**4. Reverter para 1.41.1.** Siga a seção 3 com a imagem/commit anteriores, sem desfazer migrations ou apagar tabelas. A API antiga lê o último preço do cliente, que é sua reserva: continua financeiramente consistente. Há limitações funcionais declaradas: ela não registra desistências nem consome revisões novas; numa negociação na vez do cliente oferece ao freelancer a última oferta do cliente e a expiração usa o fuso do freelancer. Isso pode encerrar uma negociação de noite para o cliente (RN-078) enquanto permanecer revertida. As propostas criadas na versão antiga mantêm limite NULL.

**5. Retornar ao candidato.** Não pede SQL manual: o reparo recupera evidências, ofertas faltantes de seq 1 e ofertas abertas de contratos que a API antiga encerrou. Refaça consultas e detector. Os eventos reputacionais que não foram registrados na versão antiga não são recriados. A reversão protege saldo; ela não conserva todas as regras novas de interface/negociação/reputação.

### Atualizar para a 1.41.1 (correções, ADR 60)

Sem migration: a atualização é a de sempre. Um ponto muda a subida: com `PUSH_PROVIDER=webpush`, a API
exige `PUSH_PUBLIC_KEY` e `PUSH_PRIVATE_KEY` no `.env` e não sobe sem elas, dizendo qual falta (antes subia
e todo aviso no navegador falhava em silêncio). O padrão do compose de produção é `simulated`, que não pede
chave. Para gerar o par: `npx web-push generate-vapid-keys`.

### Atualizar para a 1.41.0 (lembretes de prazo, ADR 58)

A 1.41.0 traz os lembretes antes de cada vencimento, o aviso da aprovação automática às duas partes e o
de revisão parada, e duas migrations, a 0029 e a 0030. Nenhum instante gravado muda. A atualização é a de
sempre (pelo workflow Deploy ou, à mão, como na seção 3); os passos abaixo são as conferências em volta dela.

**1. Antes: o tamanho da primeira rodada.** Consultas só de leitura, no console do MySQL (tabela da seção
5); mostre o comando a quem responde pelo deploy e espere o ok antes de rodar. Na primeira rodada de dia
de cada pessoa saem de uma vez os lembretes do que vence nas próximas 48 h, e as revisões paradas há mais
de 7 dias recebem o aviso, às duas partes, uma vez (a de um marco cujo título se repete na contratação conta
7 dias a partir do deploy). Estas contagens dão a ordem de grandeza:

```sql
-- vencimentos nas próximas 48 h (cada um pode ganhar um lembrete)
SELECT COUNT(*) FROM contracts WHERE status = 'pending' AND proposal_expires_at BETWEEN NOW() AND NOW() + INTERVAL 48 HOUR;
SELECT COUNT(*) FROM contracts WHERE status IN ('accepted','in_progress') AND deadline_at BETWEEN NOW() AND NOW() + INTERVAL 48 HOUR;
SELECT COUNT(*) FROM contracts WHERE status = 'delivered' AND approval_due_at BETWEEN NOW() AND NOW() + INTERVAL 48 HOUR;
SELECT COUNT(*) FROM contract_milestones WHERE status = 'delivered' AND approval_due_at BETWEEN NOW() AND NOW() + INTERVAL 48 HOUR;
SELECT COUNT(*) FROM contracts WHERE extension_status = 'pending';
-- revisões em curso (as paradas há mais de 7 dias recebem o aviso de revisão parada)
SELECT COUNT(*) FROM contracts WHERE status = 'revision_requested';
SELECT COUNT(*) FROM contract_milestones m JOIN contracts c ON c.id = m.contract_id
 WHERE m.status = 'funded' AND m.delivered_at IS NOT NULL AND c.status IN ('accepted','in_progress');
```

**2. O deploy.** Pelo workflow Deploy; à mão, com `IMAGE_TAG=1.41.0` no `.env`:

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

O job `migrate` aplica a 0029 (a tabela `deadline_reminders`, o livro dos lembretes, e na contratação a
hora do pedido de revisão, com um índice) e a 0030 (a mesma hora no marco, com um índice), e no fim roda o
reparo dos prazos, que ganhou dois passos: a contratação em revisão recebe a hora do último pedido de
revisão da linha do tempo; o marco em revisão, a do último pedido dele na linha do tempo, quando o título
do marco é único na contratação, e senão a hora do deploy (o aviso dele sai 7 dias depois). Nenhuma das
duas fica antes da última entrega.

**3. Depois: conferir o reparo.**

```bash
docker compose -f docker-compose.prod.yml logs migrate | grep 'Prazos reparados'
curl -s https://SEU_DOMINIO/api/health   # "version":"1.41.0"
```

Em `reparo`, `revisionRequested` e `milestoneRevisionRequested` devem bater com as duas últimas contagens
do passo 1 (salvo o que mudou no intervalo). No console do MySQL, as duas consultas abaixo precisam dar 0
(o reparo trata até 200 linhas por passo a cada rodada: se não derem, espere as próximas rodadas dos jobs e
rode de novo):

```sql
SELECT COUNT(*) FROM contracts WHERE status = 'revision_requested' AND revision_requested_at IS NULL;
SELECT COUNT(*) FROM contract_milestones m JOIN contracts c ON c.id = m.contract_id
 WHERE m.status = 'funded' AND m.delivered_at IS NOT NULL AND m.revision_requested_at IS NULL
   AND c.status IN ('accepted','in_progress');
```

Os lembretes enviados ficam em `deadline_reminders` (uma linha por lembrete; `kind` diz o tipo):

```sql
SELECT kind, COUNT(*) FROM deadline_reminders GROUP BY kind;
```

**4. Voltar para a 1.40.0** é seguro: pelo workflow Deploy com a tag `1.40.0` (ou à mão, seção 3). A API
antiga ignora a tabela e as colunas novas e volta a não mandar lembretes. As migrations são só para frente.

**5. Voltar de novo para a 1.41.0 depois de a 1.40.0 ter ficado no ar** não pede passo manual. A 1.40.0
registra pedidos de revisão sem gravar a hora, e uma revisão pedida nela fica com a hora de um pedido
anterior, de antes da última entrega. O reparo reconhece essa hora como sobra de outro ciclo e a recalcula
(a da contratação pela linha do tempo; a do marco também, quando o título dele é único, e senão a partir do
deploy); as revisões com a hora certa não são tocadas, e o aviso de revisão parada não se repete.

## 4. Backup e restauração

`scripts/backup-db.sh` faz um `mysqldump --single-transaction` **dentro** do container do banco (não expõe
senha), comprime em `backups/` e mantém os 14 mais recentes (`BACKUP_KEEP`). Agende no cron e copie a
pasta para fora da VPS (rclone, scp, S3…) — backup na mesma máquina não é backup.

```bash
COMPOSE_FILE=docker-compose.prod.yml scripts/backup-db.sh
crontab -e
# 0 3 * * * cd /opt/escambo && COMPOSE_FILE=docker-compose.prod.yml scripts/backup-db.sh >> backups/backup.log 2>&1
# 10 3 * * * cd /opt/escambo && COMPOSE_FILE=docker-compose.prod.yml scripts/backup-uploads.sh >> backups/backup.log 2>&1
```

Restaurar (para a API, importa, roda migrations pendentes e sobe de novo):

```bash
COMPOSE_FILE=docker-compose.prod.yml scripts/restore-db.sh backups/escambo-20260910-030000.sql.gz
```

O volume `escambo_api_data` guarda os **anexos do chat** (`uploads/`) e as **fotos de perfil e imagens do portfólio** (`media/`, com as miniaturas geradas ao lado de cada original) e as **imagens removidas pela moderação** em quarentena (`quarantine/`, nunca servidas em público e apagadas quando não cabe mais contestação), permanentes — o banco só tem a
chave de cada arquivo) e as cópias de dados LGPD (temporárias, `EXPORT_TTL_DAYS`). Os anexos precisam
de backup tanto quanto o banco: `scripts/backup-uploads.sh` empacota a pasta de dentro do container
(`backups/uploads-*.tgz`, mesma retenção) — agende no mesmo cron. Os certificados ficam em
`caddy_data` e são reemitidos se sumirem. As imagens são processadas pela sharp, que já traz o binário
da libvips para Alpine: a imagem da API não precisa de pacote extra nem de compilador.

O volume não cresce para sempre: o job `purge-attachments` apaga, uma vez por dia a partir de
`ATTACHMENT_PURGE_HOUR` (4h, Brasília), os anexos com mais de `attachment_retention_days` dias
(180, em `platform_settings`) em conversas sem contratação aberta, além de arquivos órfãos. O
painel admin mostra o uso do volume e tem o botão "Rodar expurgo agora".

```bash
COMPOSE_FILE=docker-compose.prod.yml scripts/backup-uploads.sh
# restaurar, com a API parada:
docker compose -f docker-compose.prod.yml stop api
docker compose -f docker-compose.prod.yml run --rm --no-deps -T --entrypoint sh api -c 'cd /repo/apps/api/data && tar xzf -' < backups/uploads-20260914-030000.tgz
docker compose -f docker-compose.prod.yml start api
```

## 5. Operação

| Tarefa                  | Comando                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Estado dos serviços     | `docker compose -f docker-compose.prod.yml ps`                                                                      |
| Logs (JSON estruturado) | `docker compose -f docker-compose.prod.yml logs -f api` (ou `web`, `caddy`)                                         |
| O que está no ar        | `curl -s https://SEU_DOMINIO/api/health`                                                                            |
| Migrations aplicadas    | `docker compose -f docker-compose.prod.yml run --rm migrate node dist/scripts/migrate.js --status`                  |
| Reiniciar só a API      | `docker compose -f docker-compose.prod.yml restart api`                                                             |
| Console do MySQL        | `docker compose -f docker-compose.prod.yml exec db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"'` |
| Atualizar MySQL/Caddy   | `docker compose -f docker-compose.prod.yml pull && up -d` (imagens oficiais, mesmas majors)                         |
| Painel de monitoramento | `ssh -L 3000:127.0.0.1:3000 usuario@vps` e abra `http://localhost:3000` (perfil `monitoring`)                       |

- **Monitoramento (ADR 59):** com `COMPOSE_PROFILES=monitoring` e `GRAFANA_ADMIN_PASSWORD` no `.env`, sobem o
  Prometheus (lê o `/metrics` da API na rede interna), uma sonda de uptime (o `/api/health` pelo domínio, como um
  usuário) e o Grafana com o painel "Escambo" e cinco alertas, que saem por e-mail pelo SMTP do sistema para
  `ALERT_EMAIL_TO` (padrão: o `ACME_EMAIL`). Ligue depois do primeiro deploy pelo workflow Deploy, que é quem
  copia `deploy/monitoring/` para a VPS. Com `SENTRY_DSN`, as falhas do servidor vão ao Sentry sem dados
  pessoais. Detalhes em [Observabilidade](./docs/wiki/Observabilidade.md).

- **Jobs em background** (aprovação tácita, expiração de depósitos e de cópias LGPD) rodam dentro da API a
  cada 5 min (`JOBS_ENABLED`, `JOBS_INTERVAL_MS`, no máximo 30 min). Com mais de uma réplica da API, deixe
  ligado em uma só.
- **Rate limit** por IP usa o IP real do usuário: o compose já configura `TRUST_PROXY=2` (Caddy → nginx → API).
- **Pagamentos:** não existe gateway real ainda (ADR 15). Em produção `PAYMENTS_SIMULATE=false`: depósitos só
  se confirmam pelo webhook (`PAYMENT_WEBHOOK_SECRET`). Num piloto sem dinheiro de verdade, `true` libera o
  botão "Simular pagamento".
- **Saque** exige e-mail confirmado (a API responde 403 `email_not_verified`): o SMTP precisa estar funcionando
  para os freelancers sacarem — ou o admin confirma pela caixa de saída no modo simulado.

## 6. Checklist de segurança

- [ ] Senhas e `JWT_SECRET` gerados aleatoriamente; `.env` com permissão `600` (`chmod 600 .env`).
- [ ] `PAYMENTS_SIMULATE=false` (ou piloto explicitamente sem dinheiro real).
- [ ] `ADMIN_EMAILS` só com endereços seus; confirme o e-mail da conta admin.
- [ ] Firewall: só 22, 80 e 443. Banco e API não publicam porta (o compose de produção já não publica).
- [ ] Backup diário no cron (banco **e** anexos do chat) **e** cópia fora da VPS; restauração testada uma vez.
- [ ] Atualizações do sistema (`unattended-upgrades`) e das imagens oficiais (`pull` periódico).
- [ ] 2FA na conta do GitHub: quem controla `main` controla o que a VPS puxa.

## 7. Problemas comuns

| Sintoma                                      | Causa provável e o que fazer                                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Certificado não emitido / aviso no navegador | DNS ainda não propagou ou porta 80 fechada. `docker compose … logs caddy`; o Caddy tenta de novo sozinho.                          |
| 502 no site                                  | `api` não está healthy: `docker compose … logs api`. Quase sempre banco (senha do `.env` ≠ do volume já criado) ou migration.      |
| `migrate` saiu com erro e a API não sobe     | `docker compose … logs migrate`. Corrija e rode `docker compose … up -d` de novo (o job é idempotente).                            |
| `denied` ao fazer `pull`                     | Pacote privado no GHCR: torne público ou `docker login ghcr.io` com token `read:packages`.                                         |
| E-mails não chegam                           | Painel admin → **E-mails**: status `failed` traz o erro do SMTP. Confira `SMTP_*`, porta 587 liberada, `SMTP_SECURE` (465 = true). |
| Rate limit pegando todo mundo junto          | Proxy extra na frente do Caddy (Cloudflare etc.): aumente `TRUST_PROXY` para o número real de saltos.                              |
| Trocou `DB_PASSWORD` e o banco não sobe      | A senha vale só na criação do volume. Ou volte a senha, ou altere o usuário dentro do MySQL, ou recrie o volume (com backup).      |
