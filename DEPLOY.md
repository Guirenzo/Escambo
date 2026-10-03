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

| Peça         | Imagem                                         | Quem constrói                                                    |
| ------------ | ---------------------------------------------- | ---------------------------------------------------------------- |
| API          | `ghcr.io/guirenzo/escambo-api:<tag>`           | job **Publicar imagens** do CI, só em `main` com os testes, o E2E e a cobertura verdes |
| Web          | `ghcr.io/guirenzo/escambo-web:<tag>`           | idem                                                             |
| Banco, borda | `mysql:8.0`, `caddy:2-alpine`                  | oficiais                                                         |

Tags publicadas: `latest`, o sha curto do commit (ex.: `a1b2c3d`) e a versão do `package.json` (ex.: `1.2.0`).
`GET /api/health` devolve `version` e `commit` — é assim que se confere o que está no ar.

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

Poucos arquivos vão para a VPS: o compose de produção, o `Caddyfile`, o `.env` e (opcional) os
scripts de backup. Não precisa clonar o repositório. A configuração do monitoramento (`deploy/monitoring/`,
opcional) chega sozinha no primeiro deploy pelo workflow Deploy (seção 3).

```bash
sudo mkdir -p /opt/escambo && sudo chown "$USER" /opt/escambo && cd /opt/escambo
base=https://raw.githubusercontent.com/Guirenzo/Escambo/main
curl -fsSLO "$base/docker-compose.prod.yml"
mkdir -p deploy scripts
curl -fsSL "$base/deploy/Caddyfile" -o deploy/Caddyfile
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
**Packages** → `escambo-api` / `escambo-web` → *Package settings* → *Change visibility*), ou faça login
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

| Tarefa                     | Comando                                                                         |
| -------------------------- | ------------------------------------------------------------------------------- |
| Estado dos serviços        | `docker compose -f docker-compose.prod.yml ps`                                  |
| Logs (JSON estruturado)    | `docker compose -f docker-compose.prod.yml logs -f api` (ou `web`, `caddy`)     |
| O que está no ar           | `curl -s https://SEU_DOMINIO/api/health`                                        |
| Migrations aplicadas       | `docker compose -f docker-compose.prod.yml run --rm migrate node dist/scripts/migrate.js --status` |
| Reiniciar só a API         | `docker compose -f docker-compose.prod.yml restart api`                         |
| Console do MySQL           | `docker compose -f docker-compose.prod.yml exec db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"'` |
| Atualizar MySQL/Caddy      | `docker compose -f docker-compose.prod.yml pull && up -d` (imagens oficiais, mesmas majors) |
| Painel de monitoramento    | `ssh -L 3000:127.0.0.1:3000 usuario@vps` e abra `http://localhost:3000` (perfil `monitoring`) |

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

| Sintoma                                          | Causa provável e o que fazer                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Certificado não emitido / aviso no navegador     | DNS ainda não propagou ou porta 80 fechada. `docker compose … logs caddy`; o Caddy tenta de novo sozinho.                       |
| 502 no site                                      | `api` não está healthy: `docker compose … logs api`. Quase sempre banco (senha do `.env` ≠ do volume já criado) ou migration.     |
| `migrate` saiu com erro e a API não sobe         | `docker compose … logs migrate`. Corrija e rode `docker compose … up -d` de novo (o job é idempotente).                          |
| `denied` ao fazer `pull`                         | Pacote privado no GHCR: torne público ou `docker login ghcr.io` com token `read:packages`.                                       |
| E-mails não chegam                               | Painel admin → **E-mails**: status `failed` traz o erro do SMTP. Confira `SMTP_*`, porta 587 liberada, `SMTP_SECURE` (465 = true). |
| Rate limit pegando todo mundo junto              | Proxy extra na frente do Caddy (Cloudflare etc.): aumente `TRUST_PROXY` para o número real de saltos.                            |
| Trocou `DB_PASSWORD` e o banco não sobe          | A senha vale só na criação do volume. Ou volte a senha, ou altere o usuário dentro do MySQL, ou recrie o volume (com backup).    |
