# Deploy do Escambo numa VPS

Uma VPS pequena (1 vCPU / 2 GB) com Docker e um domínio bastam. O CI publica as imagens no GitHub
Container Registry a cada merge em `main`; a VPS só as puxa. Nada é compilado no servidor.

```
                     ┌───────────────────────────── VPS ──────────────────────────────┐
  navegador ──443──▶ │ caddy (HTTPS automático) ──▶ web (nginx: SPA + proxy) ──▶ api ──▶ db │
                     │                                    /api, /socket.io        │      MySQL 8 │
                     │  volumes: escambo_db_data · escambo_api_data · caddy_data              │
                     └────────────────────────────────────────────────────────────────┘
```

| Peça         | Imagem                                         | Quem constrói                                                    |
| ------------ | ---------------------------------------------- | ---------------------------------------------------------------- |
| API          | `ghcr.io/guirenzo/escambo-api:<tag>`           | job **Publicar imagens** do CI, só em `main` com os 3 jobs verdes |
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

Só quatro arquivos vão para a VPS: o compose de produção, o `Caddyfile`, o `.env` e (opcional) os
scripts de backup. Não precisa clonar o repositório.

```bash
sudo mkdir -p /opt/escambo && sudo chown "$USER" /opt/escambo && cd /opt/escambo
base=https://raw.githubusercontent.com/Guirenzo/Escambo/main
curl -fsSLO "$base/docker-compose.prod.yml"
mkdir -p deploy scripts
curl -fsSL "$base/deploy/Caddyfile" -o deploy/Caddyfile
curl -fsSL "$base/scripts/backup-db.sh"  -o scripts/backup-db.sh
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

## 3. Atualizar e voltar atrás

Cada merge em `main` com CI verde publica uma imagem nova. Atualizar é puxar e subir; o job de migrations
roda de novo (idempotente) e a API só reinicia depois dele:

```bash
cd /opt/escambo
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
curl -s https://SEU_DOMINIO/api/health   # confira o commit
```

**Rollback:** aponte `IMAGE_TAG` no `.env` para a tag anterior (sha curto ou versão, visíveis na página do
pacote no GitHub) e rode `up -d` de novo. As migrations são aditivas (forward-only), então uma imagem
anterior continua funcionando sobre o schema mais novo. Guarde a tag que está no ar antes de atualizar:

```bash
curl -s https://SEU_DOMINIO/api/health | grep -o '"commit":"[^"]*"'
```

## 4. Backup e restauração

`scripts/backup-db.sh` faz um `mysqldump --single-transaction` **dentro** do container do banco (não expõe
senha), comprime em `backups/` e mantém os 14 mais recentes (`BACKUP_KEEP`). Agende no cron e copie a
pasta para fora da VPS (rclone, scp, S3…) — backup na mesma máquina não é backup.

```bash
COMPOSE_FILE=docker-compose.prod.yml scripts/backup-db.sh
crontab -e
# 0 3 * * * cd /opt/escambo && COMPOSE_FILE=docker-compose.prod.yml scripts/backup-db.sh >> backups/backup.log 2>&1
```

Restaurar (para a API, importa, roda migrations pendentes e sobe de novo):

```bash
COMPOSE_FILE=docker-compose.prod.yml scripts/restore-db.sh backups/escambo-20260910-030000.sql.gz
```

O volume `escambo_api_data` guarda só as cópias de dados LGPD (arquivos temporários, com validade de
`EXPORT_TTL_DAYS`); não precisa de backup. Os certificados ficam em `caddy_data` e são reemitidos se
sumirem.

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

- **Jobs em background** (aprovação tácita, expiração de depósitos e de cópias LGPD) rodam dentro da API a
  cada 5 min (`JOBS_ENABLED`, `JOBS_INTERVAL_MS`). Com mais de uma réplica da API, deixe ligado em uma só.
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
- [ ] Backup diário no cron **e** cópia fora da VPS; restauração testada uma vez.
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
