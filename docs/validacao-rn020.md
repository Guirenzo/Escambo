# Validação da RN-020 — etapa 14 da ADR 61

Registro da candidata local **1.42.0**, iniciado em **16/10/2026** e atualizado em **19/10/2026**. A RN-020 impede uma nova proposta direta ao mesmo freelancer enquanto o cliente tem uma contratação direta aberta com ele. A interface conserva o formulário e permite abrir a contratação existente. O trabalho continua no checkout `C:/Users/guilherme/Documents/EscamboRepo-regras`, ramo `feat/regras-pendentes`, base `60e983e78db2a2691fd3bfdb5b9d2832e1843818`.

**Estado deste registro em 19/10/2026:** rascunho técnico; a integração completa final, a verificação final da demonstração, a conferência de fontes e o encerramento dos recursos temporários ainda precisam ser consolidados abaixo. Os resultados já concluídos estão separados dos pendentes. Não houve commit, push, tag, PR, merge, publicação, deploy ou SSH nesta etapa.

Regras e decisões: [RN-020](./regras-de-negocio.md#rn-020--proposta-única-por-par-cliente-freelancer) e [complemento da ADR 61, etapa 14](./decisoes.md#complemento-da-adr-61--proposta-única-etapa-14-16102026). As provas de suporte da etapa 13 permanecem históricas em [validação de entrega](./validacao-entrega-adr61.md).

## Escopo e comportamento

A unidade da regra é o **par ordenado cliente→freelancer** na contratação direta UC-04, em dinheiro (`cash`) ou créditos (`credits`). Outro título, serviço ou meio de pagamento não cria exceção. A direção inversa e os demais pares são independentes.

| Estado da contratação direta existente                                              | Efeito sobre uma nova proposta do mesmo cliente ao mesmo freelancer |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `pending`, `accepted`, `in_progress`, `delivered`, `revision_requested`, `disputed` | Bloqueia                                                            |
| `rejected`, `cancelled`, `completed`                                                | Não bloqueia                                                        |

O prazo de uma proposta pode ter vencido sem que sua transição tenha ocorrido. Enquanto o estado permanecer `pending`, ela continua ocupando o par; a retirada ou a expiração efetiva é que o libera. Trabalho adicional pago no mesmo par depende do encerramento da contratação direta atual, conforme a RN-023.

Trocas UC-07 e seus contratos gerados são independentes da RN-020. A consulta de duplicidade considera somente `payment_mode IN ('cash', 'credits')` com `barter_agreement_id IS NULL`. A etapa não altera propostas, acordos, estados ou reservas do fluxo de troca.

Não há saneamento retroativo: contratos anteriores não são cancelados, mesclados ou editados por essa regra. Havendo várias contratações diretas abertas da mesma dupla no legado, todas precisam encerrar antes de outra proposta. Não há migration, dependência ou mudança da versão candidata nesta etapa.

## Transação, resposta HTTP e interface

Em `contracts.repository.ts`, a criação inicia a transação e adquire as contas dos participantes em ordem numérica por `lockWalletUsers`: trava exclusiva no cliente e compartilhada no freelancer. A conta do cliente serializa novas propostas. A primeira leitura consistente dos contratos acontece **depois** dessa aquisição e de eventual espera, de modo que a requisição seguinte enxergue a proposta recém-confirmada.

A consulta não trava contratos existentes depois de travar as contas. Isso evita inverter a ordem contrato→contas das transições já existentes. Encontrada uma contratação direta aberta, a transação responde antes de inserir a nova contratação, oferta, histórico, marcos ou reserva. Erro por saldo insuficiente também desfaz a criação e não deixa uma proposta parcial ocupando o par.

O conflito de `POST /api/contracts` é:

```json
{
  "error": "active_contract_exists",
  "message": "Você já tem uma proposta ou contratação em aberto com este freelancer. Acompanhe a contratação existente antes de enviar outra.",
  "contractId": 123
}
```

O status é **409**. O ID pertence a uma contratação do próprio cliente com aquele destinatário; o número acima é apenas ilustrativo. O middleware serializa `contractId` somente nesse código/status e somente se for inteiro positivo seguro. Os demais campos internos do erro não são propagados. A regra anterior de `opensAt`, usada pela RN-062, permanece separada.

`ApiError` nos tipos compartilhados documenta o campo opcional. Na Web, `ApiRequestError` preserva status, código e o ID validado. `ContratarModal` reconhece o conflito, mantém os dados preenchidos e oferece **Abrir contratação existente**, com destino `/contratos/ID`. A navegação só ocorre por essa ação explícita; a aplicação não reenvia a proposta nem redireciona automaticamente. Uma nova tentativa limpa a indicação anterior antes de processar a resposta.

A OpenAPI documenta a resposta 409 por `anyOf` entre `ActiveContractError` e o erro genérico. O schema genérico também pode corresponder ao conflito específico, por isso `oneOf` não representaria corretamente essa sobreposição.

## Dados de demonstração e fixtures históricas

O seed de demonstração tinha cenários simultâneos de Ana com Rafael. Para uma base nova, os cenários passam a usar clientes distintos: Beatriz no motion graphics, Ana na abertura com extensão de prazo e Caio na vinheta. O seletor `demoClientFor` procura o cenário já existente na conta principal e na alternativa antes de escolher uma conta, preservando cenários de execuções anteriores. Os perfis e saldos fictícios das contas adicionais são preparados pelo mesmo script.

**Validação final do seed: pendente de consolidação.** A execução inicial, a recuperação de base parcial e a repetição devem ser registradas com seus resultados e artefatos antes do fechamento. A mudança descrita acima não é, por si só, prova de idempotência.

A regressão antiga também construía múltiplos contratos ativos da mesma dupla para testar prazos, mensagens, notificações e concorrência financeira. Esses dados podem existir antes da RN-020 e continuam precisando de cobertura. Quando o cenário permite, a preparação passou a usar participantes distintos. Quando o histórico paralelo é necessário, `test/integration/helpers/legacy-parallel-contracts.ts` prepara a fixture explicitamente:

- aceita somente ambiente `test`, banco terminado em `_test` e IDs positivos seguros;
- impede a preparação concorrente da mesma dupla;
- salva apenas os contratos diretos ativos da dupla, com status e `updated_at` exatos;
- afasta temporariamente esses estados da guarda durante a criação sequencial pela API real, conservando a geração de reserva, oferta e histórico;
- restaura os valores no `finally`, inclusive quando a criação falha.

Esse helper só participa da montagem de dados de teste, antes dos jobs ou corridas. Não existe flag de bypass na aplicação. As assertions dos fluxos financeiros, de prazo e de notificações foram preservadas. A integração focal verifica a restauração exata do estado e do financeiro quando a montagem falha.

## Resultados registrados

Datas abaixo são as datas locais de execução em Brasília (`America/Sao_Paulo`). Os JSONs de Vitest/Playwright guardam o início em UTC. A pasta de evidências é `C:/Users/guilherme/Documents/Escambo/qa-rn020-stage14`.

| Execução                                                  | Data       | Resultado                                                                                      | Evidência                                         |
| --------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| API unitária completa final                               | 19/10/2026 | **4.616/4.616**, 203 arquivos, sem falhas ou pendências                                        | `api-unit-final.json`                             |
| Web unitária completa                                     | 16/10/2026 | **2.105 aprovados**, 97 arquivos, zero falhas e **16 TODO preexistentes**                      | `web-unit.json`                                   |
| API focal de repositório e middleware                     | 16/10/2026 | **98/98**, dois arquivos                                                                       | `api-focal.json`                                  |
| Web focal de cliente HTTP e modal                         | 16/10/2026 | **74 aprovados**, dois arquivos, zero falhas e dois TODO já incluídos nos 16 da suíte completa | `web-focal.json`                                  |
| Integração RN-020 inicial, MySQL 8                        | 16/10/2026 | **18/18**, um arquivo                                                                          | `integration-focal.json`                          |
| Integração focal após ajustes de fixtures                 | 19/10/2026 | **59/59**, cinco arquivos, incluindo **20 casos RN-020**                                       | `integration-root-final.json`                     |
| Integração completa final, MySQL 8                        | 19/10/2026 | **Pendente de consolidação**                                                                   | A preencher após a rodada completa                |
| E2E selecionado, desktop e celular                        | 16/10/2026 | **22/22**, quatro specs, um worker; zero retries, falhas, skipped ou flaky                     | `e2e-final.json`, `e2e-final.log`                 |
| Typecheck, ESLint e build das aplicações                  | 16/10/2026 | Aprovados; build local em Windows                                                              | `typecheck.log`, `lint.log`, `build.log`          |
| TypeScript explícito de integração/E2E e lint das adições | 16/10/2026 | Aprovados                                                                                      | `extra-typecheck.log`, `lint-final-additions.log` |

Os focais não são somados às suítes completas. O build Web manteve o aviso de chunk acima de 500 kB: JavaScript principal de 713,41 kB antes de gzip. O aviso não impediu o build.

Os quatro specs E2E são `proposta-unica.smoke.spec.ts`, `financeiro.smoke.spec.ts`, `negociacao.smoke.spec.ts` e `trocas.smoke.spec.ts`. Os quatro casos de proposta única, dinheiro/créditos em desktop/celular, estão incluídos nos 22. Eles verificam o conflito real, a conservação dos campos, o vínculo para a contratação original, a carteira inalterada e a nova proposta após cancelamento. A repetição final começou em `2026-10-16T21:28:08.324Z` e terminou em aproximadamente 81,79 segundos.

Os 20 casos RN-020 da rodada focal de 19/10 incluem a matriz de estados, independência de pares/direção/trocas, múltiplos legados, recusa/retirada real, ausência de efeitos parciais e acesso negado a terceiro. Duas corridas disparam quatro propostas em dinheiro e quatro em créditos: cada grupo produz uma criação e três conflitos. A espera real é observada em `performance_schema.data_lock_waits` antes de liberar a conta bloqueadora. Também são exercitados envios recíprocos simultâneos e cancelamento concorrente com nova proposta. Esses casos demonstram as interleavings testadas; não constituem promessa universal de ausência de deadlocks.

## Falhas intermediárias preservadas

A primeira API completa, em 16/10, teve **4.615 aprovados e uma falha**, em 203 arquivos (`api-unit.json`). A expectativa exata de respostas da OpenAPI ainda continha somente 201 e foi atualizada para incluir o 409 documentado. O focal OpenAPI passou com **27/27** no mesmo dia (`openapi-final.json`), e a execução completa de 19/10 passou com 4.616/4.616.

A primeira integração completa, em 16/10, registrou **394 aprovados, 37 falhas e 14 pendentes**, de 445 casos declarados em 72 arquivos; 15 arquivos tiveram falha (`integration-all-first.json`). A nova guarda recusou fixtures que tentavam criar vários contratos diretos abertos da mesma dupla. No reparo de prazos, a falha na preparação impediu a execução dos 14 casos. Os testes foram adaptados para participantes independentes ou para histórico pré-RN-020 explícito, sem remover a guarda da aplicação e sem relaxar as assertions de negócio. A rodada completa final permanece a preencher na tabela.

O primeiro E2E terminou com **20/22**, em 16/10 (`e2e-first.json`). Os dois casos em créditos tentavam clicar diretamente no radio nativo oculto pela apresentação visual. O seletor passou a clicar no texto visível exato **Créditos Escambo**; a requisição também confere `paymentMode`. A rodada final passou com 22/22. As tentativas anteriores e seus logs não são apresentadas como execuções aprovadas.

## Proveniência, recursos temporários e limites

O teste usa MySQL 8 isolado e um runtime HTTP local com dados fictícios, pagamentos/e-mail/push simulados e jobs automáticos desativados. A preparação prevê somente um container temporário identificado como `escambo-qa-rn020`, com label `codex.task=escambo-rn020-stage14`, porta local 3314 e runtime na porta 5179. A integração usa banco terminado em `_test`; a demonstração usa banco separado no mesmo servidor temporário. O agendador não é alterado pela RN-020.

**Conferência final de fontes, hashes, seed, recursos e limpeza: pendente de consolidação.** O manifesto de origem está em `runtime-source-manifest.json`; é necessário compará-lo ao checkout final e registrar os IDs efetivamente removidos, o encerramento do runtime e a preservação das demais stacks. Este rascunho não declara a limpeza concluída.

Não foi medida uma nova cobertura percentual nesta etapa. As métricas de cobertura e o smoke Linux da etapa 13 pertencem àquele snapshot e não são reapresentados como provas da RN-020. A etapa 14 também não valida CI publicado, servidor público, gateway real ou a infraestrutura/backup de destino. O resultado permanece uma candidata local, com as pendências de fechamento identificadas neste documento.
