# API — Escambo

Backend do Escambo em **Node + Express + TypeScript**, em camadas **Controller → Service → Repository**
(igual ao C4 nível 3 do RFC). Banco: o MySQL 8 de `infra/docker-compose.yml`.

## Rodando

```bash
# 1. Suba o banco (na raiz do repo)
cd infra && docker compose up -d && cd ..

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
    ├── reviews/           # avaliações + nota média (RF-051..056, RN-041..046)
    ├── gamification/      # XP/níveis/badges/ranking/streak (RF-063..068, RN-051..060)
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

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/health` · `/api/health/live` | Readiness (com banco) · Liveness (sem banco) |
| GET | `/api/docs` · `/api/openapi.json` | **Swagger UI** + spec OpenAPI (RNF-010) |
| POST | `/api/auth/register` | Cria usuário (`email`, `password`, `role`) |
| POST | `/api/auth/login` | Autentica → `accessToken` (1h) + `refreshToken` (7d) + sessão |
| POST | `/api/auth/refresh` | Rotaciona o refresh token → novo par de tokens |
| POST | `/api/auth/logout` | Revoga a sessão do `refreshToken` enviado |
| POST | `/api/auth/logout-all` | **(protegida)** encerra todas as sessões (RN-008) |
| GET | `/api/auth/me` | **(protegida)** dados do usuário do token — exige `Authorization: Bearer <jwt>` |
| GET | `/api/categories` | árvore de categorias (pública) |
| GET | `/api/profiles/freelancer/:ulid` | perfil público do freelancer (nota + nível) |
| GET | `/api/profiles/me` | **(auth)** meus perfis (freelancer/cliente) |
| PUT | `/api/profiles/freelancer` · `/client` | **(auth)** cria/edita meu perfil |
| GET | `/api/services` | Lista/busca serviços (`categoryId`, `q`, `isRemote`, `page`, `limit`) |
| GET | `/api/services/:id` | Detalhe de um serviço |
| POST | `/api/services` | **(protegida)** cria serviço (dono = token) |
| PATCH | `/api/services/:id` | **(protegida, dono)** atualiza |
| DELETE | `/api/services/:id` | **(protegida, dono)** soft delete |
| POST | `/api/contracts` | **(auth)** cliente cria proposta (calcula taxa 15%) |
| GET | `/api/contracts` | **(auth)** minhas contratações |
| GET | `/api/contracts/:id` | **(auth, parte)** detalhe + histórico de status |
| POST | `/api/contracts/:id/accept` · `/reject` | **(freelancer)** aceita / recusa |
| POST | `/api/contracts/:id/deliver` | **(freelancer)** registra entrega |
| POST | `/api/contracts/:id/approve` | **(cliente)** aprova → concluído |
| POST | `/api/contracts/:id/request-revision` | **(cliente)** solicita revisão |
| POST | `/api/contracts/:id/cancel` | **(parte)** cancela — reembolso RN-025 |
| GET | `/api/wallet` | **(auth)** saldo disponível + retido em escrow |
| POST | `/api/reviews` | **(auth, cliente)** avalia contratação concluída (1–5) |
| GET | `/api/reviews?freelancerId=` | avaliações de um freelancer (pública) |
| POST | `/api/reviews/:id/response` | **(auth, avaliado)** responde uma avaliação |
| GET | `/api/gamification/me` | **(auth)** XP, nível, progresso, streak, ranking, badges |
| GET | `/api/gamification/me/history` | **(auth)** feed dos ganhos de XP |
| GET | `/api/gamification/leaderboard` | **(auth)** ranking por XP |
| POST | `/api/barters` | **(auth)** propõe troca de serviços (calcula torna + taxa) |
| GET | `/api/barters` | **(auth)** minhas trocas |
| GET | `/api/barters/:id` | **(auth, parte)** detalhe da troca |
| POST | `/api/barters/:id/accept` | **(receptor)** aceita → gera 2 contratos + torna em escrow |
| POST | `/api/barters/:id/reject` · `/cancel` | **(receptor/parte)** recusa / cancela |
| POST | `/api/withdrawals` | **(auth)** solicita saque (débito atômico, mín. R$20) |
| GET | `/api/withdrawals` | **(auth)** meus saques |
| GET | `/api/notifications` | **(auth)** minhas notificações + total não lidas |
| POST | `/api/notifications/:id/read` · `/read-all` | **(auth)** marca como lida(s) |
| GET · POST | `/api/messaging/contracts/:id` | **(auth, parte)** histórico e envio de mensagens do contrato |
| WS | `/socket.io` | **(auth)** chat em tempo real: `contract:join`, `message:send` → `message:new` |
| POST · GET | `/api/lgpd/consents` | **(auth)** registra/lista consentimentos (RN-071) |
| POST · GET | `/api/lgpd/deletion-requests` | **(auth)** direito ao esquecimento (RN-072) |
| POST · GET | `/api/lgpd/export-requests` | **(auth)** portabilidade dos dados (Art. 18, V) |
| POST · GET · DELETE | `/api/favorites` | **(auth)** favoritar serviços/freelancers |
| POST · GET · DELETE | `/api/saved-searches` | **(auth)** buscas salvas (filtros + alerta) |
| POST · GET | `/api/reports` | **(auth)** denúncias (trust & safety) |
| POST · GET | `/api/disputes` | **(auth, parte)** abre/lista disputas de contrato |
| GET | `/api/disputes/:id` | **(auth, parte)** detalhe da disputa |
| POST | `/api/admin/disputes/:id/resolve` | **(admin)** resolve com decisão de escrow |
| GET | `/api/admin/disputes` · `/api/admin/metrics` | **(admin)** disputas abertas / métricas |
| POST | `/api/admin/users/:ulid/suspend`·`/ban`·`/reactivate` | **(admin)** moderação (RN-007) |

> O módulo `auth` é o **molde**: cada novo módulo (services, contracts, payments…) segue o mesmo
> formato de pastas e camadas.

## Scripts

| Script | O que faz |
|---|---|
| `npm run dev` | Sobe com reload (tsx watch) |
| `npm run build` | Compila para `dist/` (tsc) |
| `npm start` | Roda o build |
| `npm run typecheck` | Checagem de tipos sem emitir |
| `npm test` | Testes unitários (Vitest) — services com repository mockado, sem banco |
| `npm run test:int` | Testes de integração (Supertest) — app real contra MySQL, fluxo de escrow ponta a ponta |

### Testes de integração

Sobem o app Express real (`createApp()`) via **Supertest** contra um MySQL de
verdade, num database dedicado `escambo_test` recriado a cada execução (schema +
seed carregados pelo `test/integration/global-setup.ts`). Cobrem o fluxo de
contratação cash com escrow ponta a ponta: `create → accept → deliver → approve`
(libera o retido e concede XP), estorno do escrow no cancelamento, autorização/
autenticação das transições e a regra de auto-contratação.

```bash
# precisa do banco no ar (docker compose -f infra/docker-compose.yml up -d db)
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
- **Health** — `GET /api/health` (readiness, com banco) e `GET /api/health/live` (liveness, sem banco) para orquestradores.
- **Container** — imagem multi-stage, roda como usuário `node` (não-root), `tini` como init e `HEALTHCHECK` no liveness.

Todos os parâmetros ficam em variáveis de ambiente (ver [`.env.example`](.env.example)).
