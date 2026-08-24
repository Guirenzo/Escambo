# Web — Escambo

Frontend do Escambo em **React + Vite + TypeScript**. Consome a API (`@escambo/api`) e reusa os
contratos de tipos de **`@escambo/types`** (nada de tipo duplicado entre back e front).

## Rodando

Na raiz do monorepo (sobe API + Web juntos):

```bash
npm run dev
```

Ou só o front (precisa da API na 3333):

```bash
npm run dev --workspace @escambo/web   # http://localhost:5173
```

O Vite faz proxy de `/api` → `http://localhost:3333`, então não há CORS no desenvolvimento.

## Estrutura

```
src/
├── main.tsx              # bootstrap do React
├── App.tsx               # layout + status da API
├── styles.css            # tema (verde #0D5C3A / âmbar #F59E0B)
├── lib/
│   └── api.ts            # client HTTP tipado (usa @escambo/types)
└── features/
    └── auth/
        ├── useAuth.ts    # hook de login
        └── LoginForm.tsx # formulário de login
```

> Organização **por feature**: cada domínio (auth, services, contracts…) tem sua própria pasta.
