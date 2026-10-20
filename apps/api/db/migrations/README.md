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

## ADR 61 — 1.42.0

| Migration                                 | Efeito                                                                                                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0031_negociacao_revisoes_desistencias.sql | Ofertas privadas e desistências após aceite; seis colunas de taxa/vez/revisão/primeira entrega/janela em contracts; CHECK 1..5; parâmetros de resposta à contraproposta/extensão |
| 0032_revisoes_marcos.sql                  | Limite/consumo de revisões por marco e snapshot de abertura da disputa                                                                                                           |
| 0033_lembrete_contraproposta.sql          | Novo kind counter_offer no livro de lembretes, conservando a posição dos membros antigos                                                                                         |

Os ALTERs são únicos e atômicos por arquivo no MySQL 8. Não há backfill de desistências nem limite retroativo de revisões: limite NULL mantém contratos já registrados ilimitados. Uma proposta de troca antiga aceita após a implantação cria dois contratos novos, cada um com duas revisões incluídas; a data da proposta de troca não torna esses contratos novos ilimitados. O runner chama repair-deadlines no final; snapshots de entrega vêm antes da inferência de tácitas, oferta 1 faltante é recuperada e ofertas abertas fora de pending são fechadas. Esse reparo também roda a cada rodada dos jobs. Confira as consultas e o detector de reserva no DEPLOY.md; não execute migrations em produção como parte de uma simples revisão local.

## 1.42.0 e 1.44.0

| Migration                         | Efeito                                                                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0034_suporte_sla.sql              | Chamados de suporte: primeira resposta pública, prazo do SLA e o aviso de prazo vencido (1.42.0)                                                               |
| 0035_modalidade_ambos.sql         | `services.is_onsite` com DEFAULT `1 - is_remote`: "remoto e presencial" passa a existir (RF-023). O ALTER recria a tabela e trava gravações em `services` por alguns segundos |
| 0036_prazo_saque.sql              | `withdrawals.due_at` e o índice (status, due_at); as duas chaves de prazo do saque; prazo preenchido nos saques ainda abertos (RN-035)                         |
| 0037_leitura_chat.sql             | Índice das mensagens não lidas por conversa, para marcar como lida (RF-059)                                                                                    |
| 0038_badges_automaticas.sql       | Índice (freelancer_id, status, client_id) em `contracts`, para os critérios das badges (RF-065)                                                                |
| 0039_cifra_destino_saque.sql      | Aumenta as colunas de chave PIX e dados bancários dos saques para caber o valor cifrado (RNF-017); não cifra nada sozinha                                      |

As cinco conferem o `information_schema` antes de cada mudança e podem rodar de novo sem erro. Depois de aplicá-las na 1.44.0, rode uma vez a reavaliação das badges (`badges:reevaluate`) e, com a `FIELD_ENCRYPTION_KEY` configurada, a cifragem dos saques antigos (`fields:encrypt`). Os dois scripts são idempotentes; o passo a passo está no DEPLOY.md.

## 1.45.0

| Migration                                   | Efeito                                                                                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0040_listagem_rapida.sql                    | Índices de cobertura `idx_svc_listing` e `idx_svc_owner_listing` em `services`, para a página de ids da listagem (RNF-004); online, sem travar        |
| 0041_snapshots_relatorios.sql               | Garante `report_snapshots` e cria índices por data em `user_sessions`, `messages` e `contract_status_history` para o uso por período (RF-081)          |
| 0042_eventos_gateway.sql                    | Tabela `payment_events`: o histórico de cada resposta e webhook do gateway, sem dado pessoal (RF-050)                                               |
| 0043_entrega_arquivos_troca_estimada.sql    | Tabela `delivery_files` (arquivo do chat ligado à entrega ou ao marco, RF-035) e a origem do valor de cada lado da troca (RF-084)                    |
| 0044_troca_email.sql                        | Tabela `email_change_requests`: pedidos de troca de e-mail com o hash do token de confirmação (RF-017)                                              |
| 0045_missoes_periodo.sql                    | `user_missions.period_key` e a chave única por período, no lugar da antiga por `expires_at` (RF-066)                                                |
| 0046_ledger_imutavel.sql                    | Triggers que recusam UPDATE e DELETE nos extratos e em `payment_events`, e DELETE de `audit_logs` com menos de 90 dias (RNF-036, RNF-037)            |
| 0047_catalogo_unico.sql                     | Junta missões e planos repetidos (o seed reaplicado duplicava o catálogo e a missão pagava em dobro) e cria as chaves únicas que faltavam              |

Todas podem rodar de novo sem erro. A 0046 cria triggers: com o binlog ligado (padrão do MySQL 8), o usuário das migrations precisa de `log_bin_trust_function_creators=1` no servidor, que os dois compose passam ao `db` a partir da 1.45.0. Passo a passo no DEPLOY.md ("Atualizar para a 1.45.0").
