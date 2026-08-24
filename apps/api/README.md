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
│   └── db.ts              # pool MySQL (mysql2) + pingDb()
├── middlewares/
│   └── error-handler.ts   # resposta de erro padronizada (RNF-039)
├── utils/
│   ├── http-error.ts      # erro de domínio com status HTTP
│   └── async-handler.ts   # try/catch automático nos controllers
└── modules/
    ├── health/            # GET /api/health (ping no banco)
    └── auth/              # register + login (molde dos demais módulos)
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
