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
│   └── logger.ts          # Pino (log estruturado, RFC §7.5)
├── middlewares/
│   ├── error-handler.ts   # resposta de erro padronizada (RNF-039)
│   ├── authenticate.ts    # JWT Bearer (req.user)
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
    ├── audit/             # trilha de auditoria de ações críticas (RN-010)
    └── lgpd/              # consentimento + exclusão/exportação (RF-079/080, RN-071/072)
        ├── auth.routes.ts
        ├── auth.controller.ts
        ├── auth.service.ts      # bcrypt + JWT (RF-001, RF-003)
        ├── auth.repository.ts   # acesso à tabela users
        └── auth.schema.ts       # validação Zod (RNF-015)
```

## Endpoints atuais

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/health` | Status da API + ping no MySQL |
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
| POST · GET | `/api/lgpd/consents` | **(auth)** registra/lista consentimentos (RN-071) |
| POST · GET | `/api/lgpd/deletion-requests` | **(auth)** direito ao esquecimento (RN-072) |
| POST · GET | `/api/lgpd/export-requests` | **(auth)** portabilidade dos dados (Art. 18, V) |

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
