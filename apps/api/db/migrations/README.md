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

## ADR 61 — candidata 1.42.0

| Migration                                 | Efeito                                                                                                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0031_negociacao_revisoes_desistencias.sql | Ofertas privadas e desistências após aceite; seis colunas de taxa/vez/revisão/primeira entrega/janela em contracts; CHECK 1..5; parâmetros de resposta à contraproposta/extensão |
| 0032_revisoes_marcos.sql                  | Limite/consumo de revisões por marco e snapshot de abertura da disputa                                                                                                           |
| 0033_lembrete_contraproposta.sql          | Novo kind counter_offer no livro de lembretes, conservando a posição dos membros antigos                                                                                         |

Os ALTERs são únicos e atômicos por arquivo no MySQL 8. Não há backfill de desistências nem limite retroativo de revisões: limite NULL mantém contratos já registrados ilimitados. Uma proposta de troca antiga aceita após a implantação cria dois contratos novos, cada um com duas revisões incluídas; a data da proposta de troca não torna esses contratos novos ilimitados. O runner chama repair-deadlines no final; snapshots de entrega vêm antes da inferência de tácitas, oferta 1 faltante é recuperada e ofertas abertas fora de pending são fechadas. Esse reparo também roda a cada rodada dos jobs. Confira as consultas e o detector de reserva no DEPLOY.md; não execute migrations em produção como parte de uma simples revisão local.
