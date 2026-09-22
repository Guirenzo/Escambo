# API — Escambo

Backend do Escambo em **Node + Express + TypeScript**, em camadas **Controller → Service → Repository**
(igual ao C4 nível 3 do RFC). Banco: o MySQL 8 de `docker-compose.yml` (raiz).

## Rodando

```bash
# 1. Suba o banco (na raiz do repo)
docker compose up -d db

# 2. Configure e rode a API
cd apps/api
cp .env.example .env      # ajuste se precisar
npm install
npm run dev               # http://localhost:3333/api
```

## Estrutura

```
src/
├── server.ts              # entrypoint (sobe o HTTP)
├── app.ts                 # monta o Express (middlewares + rotas)
├── routes.ts              # agrega as rotas dos módulos sob /api
├── config/
│   ├── env.ts             # validação das envs com Zod
│   ├── db.ts              # pool MySQL (mysql2) + pingDb()
│   ├── logger.ts          # Pino (log estruturado, RFC §7.5)
│   └── openapi.ts         # documento OpenAPI + Swagger UI (RNF-010)
├── middlewares/
│   ├── error-handler.ts   # resposta de erro padronizada (RNF-039)
│   ├── authenticate.ts    # JWT Bearer (req.user)
│   ├── require-admin.ts   # exige role admin (RN-007)
│   └── rate-limit.ts      # anti brute-force (RNF-005 / RN-002)
├── utils/
│   ├── http-error.ts      # erro de domínio com status HTTP
│   └── async-handler.ts   # try/catch automático nos controllers
└── modules/
    ├── health/            # GET /api/health (ping no banco)
    ├── auth/              # register/login/refresh/logout/me (molde)
    ├── categories/        # árvore de categorias (RF-021)
    ├── profiles/          # perfis freelancer/cliente (RF-011..020)
    ├── services/          # CRUD de serviços (RF-021..030)
    ├── contracts/         # máquina de estados + histórico (RF-031..040)
    ├── wallet/            # carteira + escrow atômico (RF-044, RN-032)
    ├── credits/           # Créditos Escambo (time-bank): moeda interna + ledger
    ├── boosts/            # Impulsionamento pago em créditos (ranqueia no topo)
    ├── reviews/           # avaliações + nota média (RF-051..056, RN-041..046)
    ├── gamification/      # XP/níveis/badges/ranking/streak (RF-063..068, RN-051..060)
    ├── score/             # Escambo Score: reputação multifator (função pura, testável)
    ├── barter/            # troca de serviços / escambo (RF-083..085, RN-066..067)
    ├── withdrawal/        # saques (RF-045, RN-034)
    ├── notifications/     # avisos in-app disparados nos eventos (RF-069)
    ├── messaging/         # chat do contrato (REST + Socket.IO em tempo real)
    ├── audit/             # trilha de auditoria de ações críticas (RN-010)
    ├── lgpd/              # consentimento + exclusão/exportação (RF-079/080, RN-071/072)
    ├── favorites/         # favoritos de serviços/freelancers
    ├── saved-searches/    # buscas salvas + alerta
    ├── reports/           # denúncias / trust & safety (RF-089)
    ├── disputes/          # abertura de disputa de contrato (RF-071..073, RN-062)
    └── admin/             # resolução de escrow + moderação + métricas (RF-076..078, RN-063)
        ├── auth.routes.ts
        ├── auth.controller.ts
        ├── auth.service.ts      # bcrypt + JWT (RF-001, RF-003)
        ├── auth.repository.ts   # acesso à tabela users
        └── auth.schema.ts       # validação Zod (RNF-015)
```

## Endpoints atuais

| Método              | Rota                                                                            | Descrição                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET                 | `/api/health` · `/api/health/live`                                              | Readiness (com banco) · Liveness (sem banco) — ambos com `version`, `commit` e `uptime`                                                        |
| GET                 | `/api/docs` · `/api/openapi.json`                                               | **Swagger UI** + spec OpenAPI (RNF-010)                                                                                                          |
| POST                | `/api/auth/register`                                                            | Cria usuário (`email`, `password`, `role`)                                                                                                       |
| POST                | `/api/auth/login`                                                               | Autentica → `accessToken` (1h) + `refreshToken` (7d) + sessão                                                                                    |
| POST                | `/api/auth/refresh`                                                             | Rotaciona o refresh token → novo par de tokens                                                                                                   |
| POST                | `/api/auth/logout`                                                              | Revoga a sessão do `refreshToken` enviado                                                                                                        |
| POST                | `/api/auth/logout-all`                                                          | **(protegida)** encerra todas as sessões (RN-008)                                                                                                |
| GET                 | `/api/auth/me`                                                                  | **(protegida)** dados do usuário do token — exige `Authorization: Bearer <jwt>`                                                                  |
| POST                | `/api/auth/verify-email`                                                        | confirma o e-mail pelo token do link (uso único, 24 h)                                                                                           |
| POST                | `/api/auth/resend-verification`                                                 | **(auth)** reenvia o link de confirmação                                                                                                         |
| POST                | `/api/auth/forgot-password` · `/reset-password`                                 | esqueci minha senha (resposta igual exista ou não a conta) · nova senha pelo token (uso único, 1 h; encerra as sessões)                          |
| GET                 | `/api/admin/emails`                                                             | **(admin)** caixa de saída de e-mails (`limit`, `userId`)                                                                                        |
| GET                 | `/api/categories`                                                               | árvore de categorias (pública)                                                                                                                   |
| GET                 | `/api/profiles/freelancer/:ulid`                                                | perfil público do freelancer (nota + nível + **Escambo Score**)                                                                                  |
| GET                 | `/api/profiles/me`                                                              | **(auth)** meus perfis (freelancer/cliente)                                                                                                      |
| PUT                 | `/api/profiles/freelancer` · `/client`                                          | **(auth)** cria/edita meu perfil                                                                                                                 |
| GET · POST          | `/api/profiles/portfolio`                                                       | **(auth)** meu portfólio; adiciona item (título, descrição, imagem e/ou link; máx. 12) — o público sai em `GET /profiles/freelancer/:ulid`     |
| PUT                 | `/api/profiles/portfolio/order`                                                 | **(auth)** reordena meu portfólio: ids de todos os trabalhos, do primeiro ao último; 409 se a lista não bate com o portfólio (ADR 43) |
| PUT · DELETE        | `/api/profiles/portfolio/:id`                                                   | **(auth)** edita / remove item do meu portfólio                                                                                                 |
| GET                 | `/api/services`                                                                 | Lista/busca serviços (`q`, `categoryId`, `isRemote`, `lat`/`lng`/`radiusKm`, `minPrice`/`maxPrice`, `maxDeliveryDays`, `minRating`, `day` (0=dom … 6=sáb: atende no dia), `period` (`morning`/`afternoon`/`evening`, com `day`; dia e período valem no fuso de cada freelancer), `now=true` (atende agora, no fuso de cada freelancer — ADR 48), `sort=relevance\|price_asc\|price_desc\|rating\|newest\|distance`, `page`, `limit`)                                                                            |
| GET                 | `/api/services/:id`                                                             | Detalhe de um serviço                                                                                                                            |
| POST                | `/api/services`                                                                 | **(protegida)** cria serviço (dono = token)                                                                                                      |
| PATCH               | `/api/services/:id`                                                             | **(protegida, dono)** atualiza                                                                                                                   |
| DELETE              | `/api/services/:id`                                                             | **(protegida, dono)** soft delete                                                                                                                |
| POST                | `/api/contracts`                                                                | **(auth)** cliente cria proposta (taxa 15%; em dinheiro reserva o valor — 402 sem saldo; `milestones` opcional: 2–10 marcos cuja soma é o valor) |
| GET                 | `/api/contracts`                                                                | **(auth)** minhas contratações                                                                                                                   |
| GET                 | `/api/contracts/:id`                                                            | **(auth, parte)** detalhe + histórico de status                                                                                                  |
| POST                | `/api/contracts/:id/accept` · `/reject`                                         | **(freelancer)** aceita / recusa                                                                                                                 |
| POST                | `/api/contracts/:id/deliver`                                                    | **(freelancer)** registra entrega                                                                                                                |
| POST                | `/api/contracts/:id/approve`                                                    | **(cliente)** aprova → concluído                                                                                                                 |
| POST                | `/api/contracts/:id/request-revision`                                           | **(cliente)** solicita revisão                                                                                                                   |
| POST                | `/api/contracts/:id/cancel`                                                     | **(parte)** cancela — reembolso RN-025                                                                                                           |
| POST                | `/api/contracts/:id/extension`                                                  | **(freelancer)** pede a única extensão de prazo (RN-028): `deadlineAt` e `reason`; 409 `extension_used` / `extension_pending`                         |
| POST                | `/api/contracts/:id/extension/accept` · `/decline`                              | **(cliente)** aceita (troca o prazo, registra na linha do tempo) ou recusa o pedido pendente                                                     |
| POST                | `/api/contracts/:id/milestones/:mid/deliver` · `/approve` · `/request-revision` | **(freelancer / cliente)** escrow por marcos (RN-069, em R$ ou créditos): entrega, aprovação que libera só aquele marco (o último conclui) e revisão por marco      |
| GET                 | `/api/wallet`                                                                   | **(auth)** saldo R$ + **créditos Escambo** (disponível e em escrow)                                                                              |
| GET                 | `/api/wallet/transactions`                                                      | **(auth)** extrato de R$ (depósitos, reservas, escrow, reembolsos, saques)                                                                       |
| POST · GET          | `/api/wallet/deposits`                                                          | **(auth)** gera cobrança PIX de depósito (gateway) / meus depósitos                                                                              |
| GET · POST          | `/api/wallet/deposits/:id` · `/simulate`                                        | **(auth)** situação da cobrança / demo: confirma sem gateway (`PAYMENTS_SIMULATE`)                                                               |
| POST                | `/api/payments/webhook`                                                         | gateway → API: cobrança paga/falhou (`x-webhook-secret`), idempotente                                                                            |
| GET                 | `/api/credits/transactions`                                                     | **(auth)** extrato de créditos Escambo (time-bank)                                                                                               |
| GET · POST          | `/api/boosts/plans` · `/api/boosts`                                             | **(auth)** planos e compra de impulsionamento (paga em créditos)                                                                                 |
| POST                | `/api/reviews`                                                                  | **(auth, cliente)** avalia contratação concluída (1–5)                                                                                           |
| GET                 | `/api/reviews?freelancerId=`                                                    | avaliações de um freelancer (pública)                                                                                                            |
| POST                | `/api/reviews/:id/response`                                                     | **(auth, avaliado)** responde uma avaliação                                                                                                      |
| GET                 | `/api/gamification/me`                                                          | **(auth)** XP, nível, progresso, streak, ranking, badges                                                                                         |
| GET                 | `/api/gamification/me/history`                                                  | **(auth)** feed dos ganhos de XP                                                                                                                 |
| GET                 | `/api/gamification/leaderboard`                                                 | **(auth)** ranking por XP                                                                                                                        |
| POST                | `/api/barters`                                                                  | **(auth)** propõe troca (torna + taxa de 15% sobre ela; reserva a torna se o proponente paga — 402 sem saldo)                                    |
| GET                 | `/api/barters`                                                                  | **(auth)** minhas trocas                                                                                                                         |
| GET                 | `/api/barters/:id`                                                              | **(auth, parte)** detalhe da troca                                                                                                               |
| POST                | `/api/barters/:id/accept`                                                       | **(receptor)** aceita → gera 2 contratos; reserva a torna se o receptor paga (402 sem saldo)                                                     |
| POST                | `/api/barters/:id/reject` · `/cancel`                                           | **(receptor/parte)** recusa / cancela                                                                                                            |
| POST                | `/api/withdrawals`                                                              | **(auth)** solicita saque (débito atômico, mín. R$20; exige e-mail confirmado → 403 `email_not_verified`)                                        |
| GET                 | `/api/withdrawals`                                                              | **(auth)** meus saques                                                                                                                           |
| POST                | `/api/withdrawals/:id/cancel`                                                   | **(auth, titular)** cancela saque ainda não processado (valor volta)                                                                             |
| GET                 | `/api/notifications`                                                            | **(auth)** minhas notificações + total não lidas                                                                                                 |
| POST                | `/api/notifications/:id/read` · `/read-all`                                     | **(auth)** marca como lida(s)                                                                                                                    |
| GET · PUT           | `/api/notifications/preferences`                                                | **(auth)** preferência de e-mail, hora do resumo do dia (`digestHour`, 0 a 23, ADR 42) e fuso da conta (`timezone`, um dos fusos do Brasil, ADR 46): `instant` (por evento), `daily` (resumo diário) ou `off` (só senha e confirmação)                              |
| GET · POST          | `/api/messaging/contracts/:id`                                                  | **(auth, parte)** histórico e envio de mensagens do contrato; texto com chave Pix, CPF, telefone, e-mail, WhatsApp ou "por fora" sai com `signals` e entra sozinho na fila de denúncias (ADR 45)                                                                                     |
| POST                | `/api/messaging/contracts/:id/attachments`                                      | **(auth, parte)** imagem ou arquivo (multipart `file` + `content`): JPG, PNG, GIF, WebP, PDF, ZIP reconhecidos pelo conteúdo, até `UPLOAD_MAX_MB` |
| GET                 | `/api/messaging/attachments/:id`                                                | **(auth, parte)** baixa o anexo da mensagem (inline para imagem, download para arquivo)                                                         |
| POST                | `/api/media`                                                                    | **(auth)** imagem para avatar ou portfólio (`purpose`): JPG, PNG, GIF ou WebP até 5 MB e 50 MP, reencodada em WebP sem EXIF/GPS (avatar quadrado de até 512 px, portfólio de até 1600 px); devolve URL, largura e altura; recusa imagem removida pela moderação e, durante o bloqueio por reincidência, qualquer envio (`uploads_restricted`, ADR 41)     |
| GET                 | `/api/media/:ano/:mês/:arquivo`                                                 | imagem pública de perfil ou portfólio, com cache imutável (fora do rate limit); `?w=128`, `?w=480` ou `?w=960` devolve a miniatura, gerada na primeira leitura                                                                  |
| WS                  | `/socket.io`                                                                    | **(auth)** chat em tempo real: `contract:join`, `message:send` → `message:new`                                                                   |
| POST · GET          | `/api/lgpd/consents`                                                            | **(auth)** registra/lista consentimentos (RN-071)                                                                                                |
| POST · GET          | `/api/lgpd/deletion-requests`                                                   | **(auth)** direito ao esquecimento (RN-072): pedido barrado por contratação aberta ou saldo (409 deletion_blocked)                               |
| POST · GET          | `/api/lgpd/export-requests`                                                     | **(auth)** portabilidade (Art. 18, V): cópia JSON gerada na hora, válida por `EXPORT_TTL_DAYS`                                                   |
| GET                 | `/api/lgpd/export-requests/:id/download`                                        | **(auth, titular)** baixa a cópia (410 se expirou)                                                                                               |
| GET · POST          | `/api/admin/deletion-requests` · `/:id/complete` · `/:id/reject`                | **(admin)** fila de exclusões; concluir anonimiza e bloqueia; recusar exige justificativa                                                        |
| POST · GET · DELETE | `/api/favorites`                                                                | **(auth)** favoritar serviços/freelancers                                                                                                        |
| GET · POST          | `/api/moderation/removals` · `/:id/appeal`                                      | **(auth)** minhas imagens removidas pela moderação, com prazo e situação da contestação e a reincidência (remoções na janela e bloqueio de envio); contestação única, dentro do prazo (ADR 41) |
| POST · GET · PATCH · DELETE | `/api/saved-searches` · `/:id`                                           | **(auth)** buscas salvas: texto + filtros validados (até 20), PATCH renomeia, liga/desliga o alerta de serviço novo e troca a frequência: na hora, de hora em hora ou diária (ADR 35 e 37)          |
| POST · GET          | `/api/reports`                                                                  | **(auth)** denúncias (trust & safety): usuário, serviço, avaliação, mensagem, foto de perfil e imagem do portfólio (ADR 39)                                                                                                            |
| POST · GET          | `/api/disputes`                                                                 | **(auth, parte)** abre/lista disputas de contrato                                                                                                |
| GET                 | `/api/disputes/:id`                                                             | **(auth, parte)** detalhe da disputa                                                                                                             |
| POST                | `/api/admin/disputes/:id/resolve`                                               | **(admin)** resolve com decisão de escrow                                                                                                        |
| GET                 | `/api/admin/disputes` · `/api/admin/metrics`                                    | **(admin)** disputas abertas / métricas                                                                                                          |
| GET · POST          | `/api/admin/storage` · `/storage/purge`                                        | **(admin)** uso do volume (anexos do chat, cópias LGPD, órfãos, último expurgo) e expurgo imediato                                            |
| GET · PUT           | `/api/admin/settings` · `/settings/:key`                                       | **(admin)** parâmetros da plataforma (comissão, aprovação tácita, validade da proposta, carência do prazo, retenção dos anexos, mínimos de saque e de serviço, trocas on/off, modo de manutenção) com limites e auditoria |
| GET                 | `/api/settings/public`                                                          | parâmetros públicos: comissão (%), aprovação tácita (dias), validade da proposta (horas), mínimos (R$), trocas ligadas, modo de manutenção      |
| GET                 | `/api/admin/finance?from&to&granularity=day\|month`                             | **(admin)** relatório por período: receita (taxas retidas, derivadas do ledger), depósitos, saques, reembolsos, contratações concluídas e GMV; fotografia do escrow |
| GET                 | `/api/admin/finance/export.csv?from&to`                                         | **(admin)** ledger de R$ do período em CSV (ponto e vírgula, vírgula decimal, BOM); ação registrada                                        |
| GET                 | `/api/admin/moderation/health`                                                  | **(admin)** saúde da moderação (ADR 47): fila e contestações esperando agora e, em `?days=` (1 a 365, padrão 30), tempo até decidir (mediana e p90), sinalizações automáticas por resultado e por sinal com o acerto, contestações e remoções por tipo, com a série por dia (Brasília) e a meta de tempo `moderation_sla_hours` (ADR 50) |
| POST                | `/api/admin/users/:ulid/suspend`·`/ban`·`/reactivate`                           | **(admin)** moderação de contas (RN-007); a fila de denúncias fica em `GET /api/admin/reports` e `POST /api/admin/reports/:id/dismiss`·`/resolve`·`/remove-image`·`/remove-content` (ADR 39 e 44); as contestações em `GET /api/admin/appeals`, `GET /api/admin/appeals/:id/image` e `POST /api/admin/appeals/:id/uphold`·`/overturn` (ADR 41)                                                                                                                   |
| GET                 | `/api/admin/withdrawals?status=open\|all`                                       | **(admin)** fila de saques com destino completo e titular                                                                                        |
| POST                | `/api/admin/withdrawals/:id/process`·`/complete`·`/fail`                        | **(admin)** assume / marca pago / falha com estorno (titular notificado)                                                                         |

> O módulo `auth` é o **molde**: cada novo módulo (services, contracts, payments…) segue o mesmo
> formato de pastas e camadas.

## Scripts

| Script               | O que faz                                                                               |
| -------------------- | --------------------------------------------------------------------------------------- |
| `npm run dev`        | Sobe com reload (tsx watch)                                                             |
| `npm run build`      | Compila para `dist/` (tsc)                                                              |
| `npm start`          | Roda o build                                                                            |
| `npm run typecheck`  | Checagem de tipos sem emitir                                                            |
| `npm test`           | Testes unitários (Vitest) — services com repository mockado, sem banco                  |
| `npm run test:int`   | Testes de integração (Supertest) — app real contra MySQL, fluxo de escrow ponta a ponta |
| `npm run db:migrate` | Aplica migrations pendentes (`-- --status` lista aplicadas x pendentes)                 |

### Testes de integração

Sobem o app Express real (`createApp()`) via **Supertest** contra um MySQL de
verdade, num database dedicado `escambo_test` recriado a cada execução (schema +
seed carregados pelo `test/integration/global-setup.ts`). Cobrem o fluxo de
contratação cash com escrow ponta a ponta: `create → accept → deliver → approve`
(libera o retido e concede XP), estorno do escrow no cancelamento, autorização/
autenticação das transições e a regra de auto-contratação.

```bash
# precisa do banco no ar (docker compose up -d db)
npm run -w @escambo/api test:int
```

Credenciais do banco de teste vêm de `TEST_DB_USER`/`TEST_DB_PASSWORD`/
`TEST_DB_NAME` (default: `root` / `escambo_root` / `escambo_test`). No CI, um
serviço MySQL é provisionado e o job **Integração** roda esta suíte.

## 🔒 Produção / Hardening

O backend é pensado para rodar em produção, não só em dev:

- **Encerramento gracioso** — em `SIGTERM`/`SIGINT` a API para de aceitar conexões, fecha o Socket.IO e drena o pool MySQL antes de sair (timeout `SHUTDOWN_TIMEOUT_MS`).
- **Atrás de proxy** — `TRUST_PROXY` faz o Express confiar no `X-Forwarded-For` (IP e rate-limit corretos atrás de load balancer/nginx).
- **CORS restrito** — `CORS_ORIGINS` aceita `*` (reflete a origem) ou uma lista fixa em produção; vale para REST e Socket.IO.
- **Limites** — corpo JSON limitado por `BODY_LIMIT` (JSON malformado → 400, corpo grande → 413) e rate limiting configurável (`RATE_LIMIT_*`, `LOGIN_RATE_LIMIT_*`).
- **Segurança** — `helmet`, `x-powered-by` desligado, e o logger **redige** `authorization`/senha/token dos logs.
- **Observabilidade** — log estruturado (pino) com `X-Request-Id` correlacionável em toda resposta; compressão gzip.
- **Health** — `GET /api/health` (readiness, com banco) e `GET /api/health/live` (liveness, sem banco) para orquestradores; os dois devolvem `version` (package.json) e `commit` (`GIT_SHA`, gravado na imagem pelo CI) para conferir o que está no ar.
- **Container** — imagem multi-stage, roda como usuário `node` (não-root), `tini` como init e `HEALTHCHECK` no liveness.

Todos os parâmetros ficam em variáveis de ambiente (ver [`.env.example`](.env.example)).

## Jobs em background

O processo da API agenda jobs (`src/jobs/`) a cada `JOBS_INTERVAL_MS` (padrão 5 min) quando
`JOBS_ENABLED=true` (padrão). Em cluster, deixe ligado em **uma** instância, ou desligue e rode
`npm run jobs:run` num cron externo.

| Job               | O que faz                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tacit-approval`  | Entregas sem resposta do cliente há mais de `platform_settings.tacit_approval_days` dias (padrão 5) são aprovadas em nome dele, liberando o escrow na mesma transação da aprovação manual. |
| `expire-deposits` | Cobranças PIX de depósito vencidas (`DEPOSIT_EXPIRES_MINUTES`, padrão 30) viram `cancelled`; a API já as mostra vencidas antes disso.                                                      |
| `expire-exports`  | Cópias de dados (LGPD) vencidas (`EXPORT_TTL_DAYS`, padrão 7): arquivo apagado de `DATA_DIR` e pedido marcado como expirado.                                                               |
| `purge-attachments` | Anexos do chat com mais de `platform_settings.attachment_retention_days` dias (padrão 180) em conversas sem contratação aberta: arquivo apagado, mensagem marcada (ADR 31). Também remove arquivos órfãos. Uma vez por dia a partir de `ATTACHMENT_PURGE_HOUR` (padrão 4h, Brasília). |
| `saved-search-alerts` | Buscas salvas com alerta, na frequência de cada busca (a cada rodada, de hora em hora ou uma vez por dia no `DIGEST_HOUR`): serviços criados desde o último aviso que casam com o texto e os filtros (fora os do próprio dono) viram uma notificação `saved_search_match` com até 5 títulos; o cursor avança mesmo sem resultado (ADR 35 e 37). |
| `expire-proposals` | Propostas sem resposta do freelancer há mais de `platform_settings.proposal_expiry_hours` horas (padrão 72) são encerradas e a reserva volta ao cliente (RN-021).                        |
| `overdue-contracts` | Prazo estourado: avisa as duas partes uma vez; `deadline_grace_hours` (padrão 24) depois, sem entrega nem extensão aprovada, abre a disputa por prazo em nome do cliente (RN-029). Marco em escrow com prazo vencido avisa as duas partes uma vez, sem disputa. |
| `daily-digest`     | A partir da hora de cada pessoa (`digest_hour`, ou `DIGEST_HOUR`) no fuso dela (`timezone`, ou Brasília), um fuso por vez, um e-mail por dia para quem escolheu resumo diário, com as notificações desde o resumo anterior; sem novidades, só marca o dia. O mesmo horário vale para o alerta diário das buscas salvas.                    |

## Administradores

`ADMIN_EMAILS` (e-mails separados por vírgula; `@dominio` libera o domínio inteiro) define quem
nasce ou é promovido a `admin` no cadastro/login. Admins acessam `/api/admin/*` (métricas, fila
de disputas, fila de saques, moderação) e o painel `/admin` do web.

## Pagamentos (carteira pré-paga)

O cliente **deposita via PIX** e a proposta em dinheiro **reserva** o valor na carteira já na
criação (`402 insufficient_balance` sem saldo); no aceite a reserva paga a contratação (líquido
→ escrow do freelancer, taxa → plataforma). Recusa, cancelamento e disputa devolvem dinheiro de
verdade ao cliente. Toda movimentação vira linha em `wallet_transactions` (extrato). Ver ADR 15.

O gateway fica atrás de `src/modules/payments/gateway.ts` (`PaymentGateway`). A única
implementação é a **simulada**: gera um BR Code válido (EMV + CRC16) e a confirmação chega pelo
**webhook** (`POST /api/payments/webhook`, header `x-webhook-secret`) — o mesmo caminho de um
gateway real — ou pelo endpoint de simulação, só para demo/dev.

| Variável                  | Padrão | Uso                                                                                              |
| ------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| `PAYMENTS_SIMULATE`       | `true` | Libera `POST /wallet/deposits/:id/simulate` (o próprio usuário "paga"). **`false` em produção.** |
| `PAYMENT_WEBHOOK_SECRET`  | vazio  | Segredo do webhook do gateway; vazio = webhook desligado (503).                                  |
| `DATA_DIR`                | `data` | Pasta dos arquivos gerados (cópias de dados LGPD); volume `api_data` no compose.                 |
| `EXPORT_TTL_DAYS`         | `7`    | Dias em que a cópia de dados fica disponível para download.                                      |
| `DEPOSIT_EXPIRES_MINUTES` | `30`   | Validade da cobrança PIX de depósito.                                                            |
