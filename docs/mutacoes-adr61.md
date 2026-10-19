# ADR61 — campanha dirigida de mutação G.5

Executada em **12/10/2026**, sobre o snapshot local da candidata **1.42.0**, baseado no commit 60e983e. As **30 linhas da G.5** foram cobertas por **31 variantes detectadas**; a linha sobre decisões de desistência foi dividida em upheld e excused. Não é uma medição de mutation score global nem de todos os operadores possíveis.

## Método e isolamento

Três cópias independentes receberam o código atual, inclusive alterações ainda não commitadas. Cada grupo usou cache próprio, dependências instaladas compartilhadas sem modificação e database exclusivo no MySQL 8 descartável da porta local 3314. O checkout de desenvolvimento não recebeu código mutante. Uma regra foi modificada por vez, com baseline verde, diff exato, execução do detector e restauração dos bytes em finally. Guardas redundantes da mesma regra foram removidas juntas em R01/R02.

O critério de detecção foi falha de assertiva relacionada à regra, com saída 1. Erros de sintaxe, importação, infraestrutura e timeout geral não contam. Um preflight inválido por LF/CRLF em R01 ficou preservado e foi excluído dos resultados válidos. D02 usa uma janela de observação de cinco segundos para contar esperas no performance_schema: falhou por **zero esperas contra duas exigidas**, dentro do timeout de 30 segundos do teste.

## Negociação e dinheiro — 13 variantes

| ID  | Mutação aplicada                                        | Detector que falhou                                                                                             |
| --- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| N01 | Retirar offer_seq/price da guarda da recusa             | contracts.service: chamada de transição perde os valores lidos na guarda SQL                                    |
| N02 | Retirar a guarda da retirada de proposta                | contracts.service: cancelamento de pending perde a guarda da oferta                                             |
| N03 | Freelancer aceitar a própria contraproposta par         | contracts.negotiation: deveria rejeitar com 409/not_your_turn antes de carteira, transição ou aviso             |
| N04 | Usar seq opcional do corpo em vez da sequência lida     | contracts.service: parâmetros da guarda deixam de representar a leitura atual                                   |
| N05 | Trocar hold_release por refund                          | contracts.negotiation: motivo dos efeitos de liberação da reserva                                               |
| N06 | Unir ajuste da reserva e pagamento no aceite do cliente | contracts.negotiation: efeitos financeiros independentes; payment não movimenta saldo disponível                |
| N07 | Calcular respond_by no fuso do proponente               | contracts.negotiation: dois proponentes, noite no próprio fuso e dia no do destinatário; data gravada incorreta |
| N08 | Expirar somente pelo fuso do freelancer                 | negociacao.int: oferta par deixa de ser selecionada para expiração no fuso diurno do cliente                    |
| N09 | Usar seq do lembrete sem subtrair um                    | reminders-sql: deduplicação deixa de representar o lembrete legado                                              |
| N10 | Aumentar MAX_OFFERS para seis                           | offers: limite/paridade das cinco ofertas                                                                       |
| N11 | Usar taxa vigente no lugar do snapshot                  | negociacao.int: alteração global muda indevidamente a taxa/líquido da oferta                                    |
| N12 | Backfill por INSERT SELECT NOT EXISTS                   | offers.repository: exige VALUES e proíbe SELECT/NOT EXISTS na inserção do snapshot                              |
| N13 | Permitir mudar presença de prazo na contraproposta      | contracts.negotiation: deveria rejeitar a mudança de forma com offer_shape                                      |

N03, N07 e N12 sobreviveram à rodada inicial. O código da aplicação estava correto; os detectores foram reforçados com três novos casos unitários e a restrição SQL do backfill. A nova rodada detectou os três. N12 é uma asserção arquitetural do SQL, conforme G.5: **não se afirma reprodução de deadlock 1213**. N01/N02/N04/N09 também conferem contratos SQL em testes de unidade; N08/N11 usam integração InnoDB real.

## Revisões e disputa — oito variantes

| ID  | Mutação aplicada                                               | Detector que falhou                                                                            |
| --- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| R01 | Remover limite no serviço e nas gravações de contratação/marco | revisoes.int: terceira revisão retorna 200 em vez de 409                                       |
| R02 | Liberar extra antes de esgotar as incluídas                    | revisoes.int: liberação com zero/uma usada retorna 200 em vez de 409, em entrega única e marco |
| R03 | Tratar legado NULL como limite dois                            | revisoes.int: legado deixa de aceitar revisão sem limite                                       |
| R04 | Contar janela da última entrega                                | dispute-window: reentrega desloca indevidamente a abertura                                     |
| R05 | Remover o teto anterior à tácita                               | dispute-window: abertura não respeita o menor instante                                         |
| R06 | Usar margem de 12 h em vez de 24 h                             | dispute-window: hora de abertura incorreta                                                     |
| R07 | Aplicar espera manual à disputa automática                     | disputa-janela.int: disputa automática deixa de ser criada                                     |
| R08 | Conferir janela antes de esperar a trava da contratação        | disputa-janela.int: entrega e disputa concorrentes passam juntas em vez de uma ser recusada    |

R02 ganhou dois casos explícitos, cada um verificando zero e uma revisão usada. Além do 409/revision_grant_not_needed, conferem orçamento, histórico, carteira e ledger intactos. A campanha não altera o comportamento correto para acomodar um mutante.

## Desistências, moderação, carteira e avisos — dez variantes

| ID   | Mutação aplicada                                     | Detector que falhou                                                                                            |
| ---- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| D01  | Gravar desistência após COMMIT                       | desistencias.int: falha de INSERT já não desfaz status, histórico, reembolso e ledger                          |
| D02  | Deduplicar revisão sem travar users                  | desistencias.int: faltam as duas esperas reais pela trava; após liberar, exige uma abertura e uma deduplicação |
| D03  | Deduplicar ambas as causas pelo mesmo prefixo        | desistencias.int: revisão de reincidência impede indevidamente revisão de desistências                         |
| D04a | Deixar de contar upheld                              | dropouts: decisão mantida deveria continuar contando                                                           |
| D04b | Contar excused                                       | dropouts: decisão desconsiderada deveria sair da contagem                                                      |
| D05  | Expor datas/dados privados no perfil público         | profiles.service: projeção pública deve conter somente número, janela e alerta                                 |
| D06  | Contar revisão de conta como automatic               | moderation.health: contrato SQL exige exclusão das revisões por origem/causa                                   |
| D07  | Reintroduzir INSERT IGNORE de carteira na transação  | wallet-ensure: detector estático de criação de carteira dentro do caminho financeiro                           |
| D08  | Tornar contract_counter_offer um DEADLINE_FIRST_TYPE | deadline-types: contraproposta deve respeitar a preferência normal de silêncio                                 |
| D09  | Retirar a hora da disputa do erro revision_limit     | contracts.revisoes: quatro fusos deixam de receber a hora de abertura prevista                                 |

D01–D03 usam MySQL/InnoDB real. D06 confere o contrato SQL; D07 é uma guarda arquitetural estática. D04/D05/D08/D09 verificam regras e projeções em unidade.

D09 encontrou uma lacuna real: o erro original já não informava a hora. Sete novos cenários falharam antes da correção e passaram depois. O erro de entrega única agora mostra a abertura no fuso do cliente enquanto futura e orienta disputa disponível na fronteira exata ou depois. Usa o snapshot relido quando a transição perde uma corrida; o teste final distingue as datas antiga/nova. Marcos mantêm sua orientação específica. Não muda limite, autorização, janela, tácita ou dinheiro. A mutação que remove novamente a hora foi então aplicada e detectada.

## Baselines, integração e evidências

| Rodada                           | Resultado verde                                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Cópia negociação                 | 389 unitários em seis arquivos e 14 integrações de negociação                                        |
| Cópia revisões                   | 84 unitários e 30 integrações em dois arquivos                                                       |
| Cópia desistências               | 136 unitários em sete arquivos e 15 integrações                                                      |
| Checkout integrado final         | **4.372 unitários API**, 193 arquivos; **59 integrações** em quatro arquivos                         |
| API/web compiladas após correção | Seis E2Es de revisões/janela, em desktop/mobile, sem retries; erro HTTP contém data/hora da abertura |
| Prints                           | Gerador ADR61 aprovado: quatro JPGs reais com dados fictícios, números 23–26; conferidos visualmente |

Os blocos de baseline têm sobreposição e não devem ser somados como testes únicos. A rodada E2E completa de 176 aprovações da etapa anterior continua sendo um registro separado; após a correção foram repetidos os seis cenários afetados. Mobile emula Pixel 7 no Chromium; pagamento, e-mail e push são simulados.

As fontes mutadas foram restauradas por SHA-256: inventário de 524 arquivos de API em negociação sem divergência inesperada; seis fontes de revisões e sete de desistências restauradas. Só os testes reforçados e a correção D09 foram transportados por handoffs imutáveis, com hashes dos bytes de origem/destino conferidos antes de copiar. Revisão independente conferiu patches, falhas, restauração e limites, sem achado acionável restante.

Evidências brutas ficam na pasta local Escambo/qa-adr61-mutations-2026-10-12, fora do checkout:

- negotiation/negotiation-results.json e evidence/N01–N13: comandos, diffs, resultados e hashes; tentativas sobreviventes em pastas before-detector.
- revisions/mutation-results/results.json e R01–R08: trechos antes/depois, comandos, assertivas e restauração.
- dropouts/evidence/dropouts-results.json e D01–D09: comandos, patches, logs e restauração; D04a/D04b separados.
- integrated-handoff.json registra os seis arquivos transportados. A diferença posterior em contracts.revisoes.test fortalece o teste de releitura do snapshot.

No checkout, os detectores ficam em contracts.negotiation.test, offers.repository.test, contracts.revisoes.test, revisoes.int.test e desistencias.int.test. Os quatro arquivos da integração final são negociacao, revisoes, disputa-janela e desistencias. Lint, typecheck dos três workspaces, build, TypeScript adicional dos E2Es/integrações alterados e formatação aprovados. O aviso existente de bundle acima de 500 kB permanece; não foi recalculada cobertura percentual.

## Conferência operacional local — G.6

O item 13 passou com **200/200 aceites sequenciais** pela API compilada 1.42.0, em 17,864 s, no MySQL isolado. Cada ciclo criou, aceitou e cancelou uma proposta fictícia de R$ 10, com depósito PIX simulado e devolução integral. Os cinco lançamentos por contrato foram comparados exatamente; as 611 requisições terminaram sem 4xx/5xx ou conflito e o detector da reserva terminou com zero divergências. Carteiras finais iguais às iniciais: cliente R$ 2.000 disponíveis e zero reservado; freelancer sem saldo/escrow em dinheiro, créditos intocados.

Script, status/tempos, IDs e conferências ficam em negotiation/g6-acceptance-loop/result.json e README.md, na pasta bruta da campanha. Uma tentativa inicial com zero rodadas foi preservada: o roteiro passou a abrir GET /wallet antes da fotografia inicial, pois a carteira do freelancer é criada sob demanda. O laço completo usou dois atores novos e SQL somente de leitura. Não houve correção de produto nesse check.

O laço é sequencial: ausência de erro 1213 observado não mede probabilidade de deadlock nem substitui os pares concorrentes InnoDB.

O item 14 também passou com alternância real de processos **1.42.0 → 1.41.1 → 1.42.0**, em porta e banco exclusivos de QA. A versão antiga veio do commit 60e983e78db2a2691fd3bfdb5b9d2832e1843818, arquivado sem mudar o checkout, e foi compilada com seus próprios tipos. As três fases confirmaram versão e banco no health. Nove contratações fictícias cobriram proposta simples/com marcos, contrapropostas, aceite, recusa, cancelamento, entrega e reentrega.

O detector de reserva retornou zero nos quatro checkpoints. Ao voltar, o reparo recuperou duas primeiras entregas e dois snapshots de abertura, criou duas ofertas iniciais faltantes e fechou três ofertas deixadas abertas pela API antiga. Preservou o snapshot já existente; carteiras/ledger não mudaram no reparo. A segunda execução fez zero alterações nesses contadores. A candidata voltou a ler e encerrar os contratos reparados. Logs, snapshots e script ficam em rollback/evidence/results.json e rollback/run-local-rollback.mjs. Processo e banco exclusivos foram encerrados/removidos após salvar as evidências.

Essa reversão foi local, com provedores simulados, sem Docker/GHCR/VPS de produção. Não demonstra equivalência funcional da API antiga: ela deixa de registrar revisões/desistências e conserva limitações de negociação/fuso descritas em DEPLOY.md. Não foram repetidos todos os itens manuais de G.6. Publicação continua separada: candidata local, sem commit, push, tag ou deploy.
