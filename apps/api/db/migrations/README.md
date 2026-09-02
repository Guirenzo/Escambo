# Migrations

Evolução incremental do schema **depois** do baseline (`../schema.sql`).

## Convenção

- Um arquivo por mudança: `NNNN_descricao_curta.sql` (ex.: `0001_add_index_services_created.sql`).
- Numeração sequencial de 4 dígitos, aplicada em ordem crescente.
- **Forward-only e aditivas** sempre que possível (add coluna/índice/tabela). Evite
  alterações destrutivas; quando inevitáveis, escreva-as com cuidado e teste em cópia.
- SQL puro, **sem** `CREATE DATABASE`/`USE` — o runner já conecta no database certo.
- Cada arquivo pode conter múltiplos statements separados por `;`.

## Como funciona

O runner (`src/scripts/migrate.ts`) registra cada migration aplicada em
`schema_migrations` (nome + checksum + data). O baseline (`schema.sql`) entra como
`0000_baseline`: em banco vazio ele é executado; se as tabelas já existem (init do
Docker/CI), é apenas marcado como aplicado.

```bash
npm run -w @escambo/api db:migrate            # aplica pendentes
npm run -w @escambo/api db:migrate -- --status  # lista aplicadas x pendentes
```

Usa as mesmas credenciais da API (`DB_*`). Idempotente: rodar de novo não repete nada.
