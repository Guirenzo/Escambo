# Banco de Dados — Escambo

Esquema relacional do Escambo em **MySQL 8** (50 tabelas, 15 módulos). A modelagem completa, comentada,
está em [`docs/modelagem-banco.md`](../../../docs/modelagem-banco.md) — esta pasta contém os scripts
executáveis derivados dela.

## Arquivos

| Arquivo | O que faz |
|---|---|
| `schema.sql` | DDL completo: cria o banco `escambo` e as 50 tabelas (gerado a partir de `docs/modelagem-banco.md`). É o **baseline** das migrations. |
| `seed.sql`   | Dados de referência: categorias, badges, missões, planos de impulsionamento e configurações da plataforma. |
| `migrations/` | Mudanças incrementais de schema após o baseline, aplicadas pelo runner (`npm run db:migrate`). Ver [`migrations/README.md`](./migrations/README.md). |

## Como rodar

### Opção A — Docker (recomendada)

Sobe um MySQL 8 já com schema + seed carregados:

```bash
docker compose up -d db
# MySQL sobe com schema + seed carregados
# MySQL em localhost:3306 — db: escambo · user: escambo · senha: escambo
```

Recarregar do zero (apaga os dados):

```bash
docker compose down -v && docker compose up -d
```

### Opção B — MySQL local

```bash
mysql -u root -p < apps/api/db/schema.sql
mysql -u root -p escambo < apps/api/db/seed.sql
```

## Convenções

- PK `BIGINT UNSIGNED AUTO_INCREMENT`; ID público via `ulid` (`VARCHAR(26)`) nas entidades expostas.
- `created_at` / `updated_at` em todas as tabelas; `deleted_at` (soft delete) nas críticas.
- Valores monetários em `DECIMAL(10,2)` (nunca `FLOAT`).
- Encoding `utf8mb4` / `utf8mb4_unicode_ci`; engine `InnoDB`.
- A chave PIX e os dados bancários dos saques são cifrados pela aplicação em **AES-256-GCM** desde a
  1.44.0 (RNF-017, migration 0039, `utils/field-crypto.ts`), quando a `FIELD_ENCRYPTION_KEY` está
  configurada. A chave fica no `.env` da VPS, nunca no banco. O segredo da 2FA (1.48.0, `user_mfa`)
  e o CPF do freelancer (1.53.0, migration 0052, `profiles_freelancer.cpf_encrypted`) usam o mesmo
  utilitário e são gravados **sempre** cifrados (sem a chave, os recursos ficam indisponíveis); o CPF
  tem ainda um índice cego (HMAC-SHA256 com chave derivada da mesma, `cpf_index`, chave única) para
  a unicidade entre contas. Não há token OAuth no código. O `schema.sql` (baseline) mostra os
  tamanhos originais das colunas do saque; a 0039 os aumenta.

> `schema.sql` é **gerado**. Não edite à mão: ajuste `docs/modelagem-banco.md` e regenere extraindo
> os blocos `sql` em ordem (ver histórico do repositório).
