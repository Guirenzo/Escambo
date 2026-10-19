# Requisitos Funcionais — Escambo

> **Versão:** 1.2.0\
> **Total de Requisitos:** 92\
> **Atualizado em:** 9 de outubro de 2026\
> **Autor:** Guilherme Renzo

---

## Legenda

| Campo          | Descrição                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------- |
| **ID**         | Identificador único do requisito                                                              |
| **Descrição**  | O que o sistema deve fazer                                                                    |
| **Prioridade** | `Alta` — essencial para o MVP / `Média` — importante mas não bloqueante / `Baixa` — desejável |
| **Módulo**     | Módulo funcional ao qual o requisito pertence                                                 |
| **Status**     | `Implementado` / `Parcial` / `Não implementado` / `Fora do escopo`, conferido no código e nos testes em 19/10/2026; evidência e o que falta em [rastreabilidade](./rastreabilidade.md) |

---

## Módulo 01 — Autenticação

| ID     | Descrição                                                                                           | Prioridade | Status   |
| ------ | --------------------------------------------------------------------------------------------------- | ---------- | -------- |
| RF-001 | O sistema deve permitir cadastro de novos usuários via e-mail e senha                               | Alta       | Implementado |
| RF-002 | O sistema deve permitir login social via conta Google (OAuth2)                                      | Alta       | Não implementado |
| RF-003 | O sistema deve emitir tokens JWT com tempo de expiração configurável após autenticação bem-sucedida | Alta       | Implementado |
| RF-004 | O sistema deve suportar refresh token para renovação de sessão sem novo login                       | Alta       | Implementado |
| RF-005 | O sistema deve enviar e-mail de confirmação de conta após o cadastro                                | Alta       | Implementado |
| RF-006 | O sistema deve bloquear o acesso de contas não verificadas a funcionalidades críticas               | Alta       | Parcial |
| RF-007 | O sistema deve permitir recuperação de senha via link enviado ao e-mail cadastrado                  | Alta       | Implementado |
| RF-008 | O sistema deve invalidar tokens de recuperação de senha após uso ou expiração                       | Alta       | Implementado |
| RF-009 | O sistema deve registrar data, IP e user-agent de cada login bem-sucedido                           | Média      | Implementado |
| RF-010 | O sistema deve permitir que o usuário encerre todas as sessões ativas simultaneamente               | Média      | Implementado |
---

## Módulo 02 — Perfis

| ID     | Descrição                                                                                          | Prioridade | Status   |
| ------ | -------------------------------------------------------------------------------------------------- | ---------- | -------- |
| RF-011 | O freelancer deve poder criar perfil com nome, foto, bio, headline e localização                   | Alta       | Implementado |
| RF-012 | O freelancer deve poder adicionar itens ao portfólio com título, descrição e imagem                | Alta       | Implementado |
| RF-013 | O freelancer deve poder definir sua disponibilidade (disponível / indisponível)                    | Alta       | Implementado |
| RF-014 | O cliente deve poder visualizar o perfil completo do freelancer antes de contratar                 | Alta       | Implementado |
| RF-015 | O sistema deve exibir no perfil do freelancer: nota média, total de serviços e badges conquistadas | Alta       | Implementado |
| RF-016 | O sistema deve exibir o tempo médio de resposta do freelancer em seu perfil                        | Média      | Implementado |
| RF-017 | O usuário deve poder editar seus dados pessoais a qualquer momento                                 | Alta       | Implementado |
| RF-018 | O sistema deve suportar perfil do tipo empresa com CNPJ, logo e dados corporativos                 | Baixa      | Não implementado |
| RF-019 | O sistema deve permitir upload de foto de perfil com redimensionamento automático                  | Alta       | Implementado |
| RF-020 | O sistema deve validar CPF do freelancer para habilitar funcionalidades financeiras                | Média      | Não implementado |
---

## Módulo 03 — Categorias e Serviços

| ID     | Descrição                                                                                          | Prioridade | Status   |
| ------ | -------------------------------------------------------------------------------------------------- | ---------- | -------- |
| RF-021 | O sistema deve disponibilizar um catálogo hierárquico de categorias e subcategorias de serviços    | Alta       | Implementado |
| RF-022 | O freelancer deve poder cadastrar serviços com título, descrição, tipo de preço e prazo de entrega | Alta       | Implementado |
| RF-023 | O freelancer deve poder marcar um serviço como remoto, presencial ou ambos                         | Alta       | Implementado |
| RF-024 | O freelancer deve poder adicionar tags ao serviço para facilitar a busca                           | Média      | Implementado |
| RF-025 | O cliente deve poder buscar serviços por categoria, localização e faixa de preço                   | Alta       | Implementado |
| RF-026 | O sistema deve suportar busca textual por palavras-chave no título e descrição dos serviços        | Alta       | Implementado |
| RF-027 | O sistema deve permitir filtrar serviços por nota mínima do profissional                           | Média      | Implementado |
| RF-028 | O sistema deve exibir serviços impulsionados em destaque no topo dos resultados de busca           | Média      | Implementado |
| RF-029 | O sistema deve registrar e exibir o número de visualizações de cada serviço ao freelancer          | Média      | Implementado |
| RF-030 | O freelancer deve poder ativar e desativar serviços sem excluí-los                                 | Alta       | Implementado |
---

## Módulo 04 — Contratações

| ID     | Descrição                                                                                                                                                                                             | Prioridade | Status       |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------ |
| RF-031 | O cliente deve poder enviar uma proposta de contratação a um freelancer                                                                                                                               | Alta       | Implementado |
| RF-032 | O freelancer deve poder aceitar, recusar ou contrapropor uma proposta recebida, e o cliente responder à contraproposta na sua vez (até 5 ofertas em 3 rodadas)                                        | Alta       | Implementado |
| RF-033 | O sistema deve rastrear e atualizar o status da contratação em cada etapa do fluxo                                                                                                                    | Alta       | Implementado |
| RF-034 | O sistema deve registrar histórico completo de mudanças de status com data e responsável                                                                                                              | Alta       | Implementado |
| RF-035 | O freelancer deve poder registrar a entrega do serviço com mensagem e arquivos anexos                                                                                                                 | Alta       | Implementado |
| RF-036 | O cliente deve poder aprovar a entrega ou pedir até 2 revisões sem custo por entrega/marco; o freelancer pode liberar revisão extra, e contratos já registrados com limite NULL permanecem sem limite | Alta       | Implementado |
| RF-037 | O sistema deve liberar o pagamento ao freelancer somente após a conclusão confirmada pelo cliente                                                                                                     | Alta       | Implementado |
| RF-038 | O sistema deve permitir cancelamento de contratação com política de reembolso definida                                                                                                                | Média      | Implementado |
| RF-039 | O sistema deve notificar ambas as partes a cada mudança de status na contratação                                                                                                                      | Alta       | Implementado |
| RF-040 | O sistema deve exibir histórico completo de contratações no painel do usuário                                                                                                                         | Alta       | Implementado |
> ℹ️ RF-032/RF-036: as rodadas e a reserva seguem a RN-030; as revisões seguem a RN-023. O número da oferta e os contadores lidos são reconferidos na transação; tela antiga não movimenta dinheiro nem consome outro pedido (ADR 61).

> ℹ️ RF-038: a política é a da RN-025, numa conta só que a Sala mostra antes de confirmar e que a liquidação repete; se o valor mudar no meio, nada se move. O freelancer também pode desistir, e tudo o que está em garantia volta ao cliente (ADR 57).

> ℹ️ RF-039: cada mudança avisa quem não agiu, e o que acontece sozinho (prazo vencido, disputa automática, proposta ou pedido de extensão sem resposta) avisa as duas partes; o cancelamento diz à outra parte o que aconteceu com o dinheiro dela (ADR 57). A aprovação tácita (RN-024), da contratação e do marco, avisa as duas partes desde o ADR 58, que também trouxe os lembretes antes de cada vencimento (RN-079) e o aviso de revisão parada há 7 dias (RN-081). O ADR 61 acrescenta `contract_counter_offer`, `contract_counter_offer_reminder`, `contract_revision_granted` e `dropout_decided`; são 42 tipos nos mapas de e-mail e push, conforme a preferência normal de cada pessoa.

---

## Módulo 05 — Pagamentos

| ID     | Descrição                                                                                        | Prioridade | Status   |
| ------ | ------------------------------------------------------------------------------------------------ | ---------- | -------- |
| RF-041 | O sistema deve processar pagamentos via MercadoPago (PIX, cartão de crédito, boleto)             | Alta       | Fora do escopo |
| RF-042 | O pagamento do cliente deve ficar retido em escrow até a conclusão confirmada do serviço         | Alta       | Implementado |
| RF-043 | O sistema deve calcular e exibir a taxa da plataforma de forma transparente antes da confirmação | Alta       | Implementado |
| RF-044 | O freelancer deve ter uma carteira digital com saldo disponível e saldo pendente separados       | Alta       | Implementado |
| RF-045 | O freelancer deve poder solicitar saque via PIX ou transferência bancária                        | Alta       | Implementado |
| RF-046 | O sistema deve processar saques dentro do prazo configurado pelo administrador                   | Alta       | Implementado |
| RF-047 | O sistema deve exibir histórico detalhado de transações com filtro por período                   | Alta       | Implementado |
| RF-048 | O sistema deve emitir notificação ao receber e ao processar um pagamento                         | Alta       | Implementado |
| RF-049 | O sistema deve suportar reembolso parcial ou total em casos de cancelamento                      | Média      | Implementado |
| RF-050 | O sistema deve registrar a resposta completa do gateway para auditoria                           | Alta       | Implementado |
---

## Módulo 06 — Avaliações

| ID     | Descrição                                                                                  | Prioridade | Status   |
| ------ | ------------------------------------------------------------------------------------------ | ---------- | -------- |
| RF-051 | O cliente deve poder avaliar o freelancer após a conclusão confirmada do serviço           | Alta       | Implementado |
| RF-052 | A avaliação deve incluir nota de 1 a 5 estrelas e comentário textual opcional              | Alta       | Implementado |
| RF-053 | O sistema deve vincular cada avaliação obrigatoriamente a uma contratação real e concluída | Alta       | Implementado |
| RF-054 | O freelancer deve poder responder publicamente a avaliações recebidas                      | Média      | Implementado |
| RF-055 | O sistema deve recalcular e atualizar a nota média do freelancer após cada nova avaliação  | Alta       | Implementado |
| RF-056 | O sistema deve exibir as avaliações mais recentes no perfil do freelancer                  | Alta       | Implementado |
---

## Módulo 07 — Chat

| ID     | Descrição                                                                                  | Prioridade | Status   |
| ------ | ------------------------------------------------------------------------------------------ | ---------- | -------- |
| RF-057 | O sistema deve disponibilizar chat em tempo real entre cliente e freelancer                | Alta       | Implementado |
| RF-058 | O chat deve suportar envio de texto, imagens e arquivos                                    | Alta       | Implementado |
| RF-059 | O sistema deve exibir indicador de leitura das mensagens (lido / não lido)                 | Média      | Implementado |
| RF-060 | O sistema deve notificar o usuário via push ao receber uma nova mensagem                   | Alta       | Fora do escopo |
| RF-061 | O histórico de mensagens deve ser preservado e acessível mesmo após a conclusão do serviço | Média      | Implementado |
| RF-062 | O sistema deve impedir o envio de mensagens em contratações canceladas ou encerradas       | Baixa      | Não implementado |
---

## Módulo 08 — Gamificação

| ID     | Descrição                                                                                                              | Prioridade | Status   |
| ------ | ---------------------------------------------------------------------------------------------------------------------- | ---------- | -------- |
| RF-063 | O sistema deve atribuir XP ao freelancer por ações relevantes (serviço concluído, avaliação recebida, missão cumprida) | Alta       | Implementado |
| RF-064 | O sistema deve calcular o nível do usuário com base no XP total acumulado                                              | Alta       | Implementado |
| RF-065 | O sistema deve emitir badges automaticamente ao atingir marcos definidos                                               | Alta       | Implementado |
| RF-066 | O sistema deve disponibilizar missões periódicas com recompensas em XP                                                 | Média      | Implementado |
| RF-067 | O sistema deve exibir ranking local de freelancers por categoria e nota                                                | Média      | Implementado |
| RF-068 | O sistema deve exibir no perfil o nível atual, XP acumulado e badges conquistadas                                      | Alta       | Implementado |
---

## Módulos 09 a 14

| ID     | Módulo          | Descrição                                                                                                             | Prioridade | Status                                   |
| ------ | --------------- | --------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------- |
| RF-069 | Notificações    | O sistema deve enviar push notification para eventos críticos (nova proposta, mensagem, pagamento)                    | Alta       | Implementado |
| RF-070 | Notificações    | O sistema deve enviar e-mail transacional para confirmação de conta, pagamento e encerramento de contrato             | Alta       | Implementado |
| RF-071 | Suporte         | O usuário deve poder abrir um ticket de suporte diretamente no app com categoria e descrição                          | Alta       | Implementado |
| RF-072 | Suporte         | O administrador deve poder intervir em disputas entre cliente e freelancer e emitir uma resolução vinculante          | Alta       | Implementado |
| RF-073 | Suporte         | O sistema deve permitir troca de mensagens internas entre usuário e equipe de suporte dentro do ticket                | Alta       | Implementado |
| RF-074 | Impulsionamento | O freelancer deve poder contratar um plano de impulsionamento com duração e alcance definidos                         | Média      | Implementado |
| RF-075 | Impulsionamento | O sistema deve exibir serviços impulsionados ativos com destaque visual nos resultados                                | Média      | Implementado |
| RF-076 | Administração   | O painel administrativo deve exibir métricas gerais de usuários, contratos, receita e tickets em tempo real           | Alta       | Implementado |
| RF-077 | Administração   | O administrador deve poder suspender, banir ou reativar qualquer conta da plataforma                                  | Alta       | Implementado |
| RF-078 | Administração   | O administrador deve poder configurar parâmetros da plataforma (taxa, prazo de saque, manutenção) sem deploy          | Média      | Implementado |
| RF-079 | LGPD            | O sistema deve registrar o consentimento explícito do usuário nos termos de uso e política de privacidade no cadastro | Alta       | Implementado |
| RF-080 | LGPD            | O usuário deve poder solicitar a exclusão definitiva de seus dados pessoais da plataforma                             | Alta       | Implementado |
| RF-081 | Relatórios      | O sistema deve gerar snapshots periódicos (diário, semanal, mensal) de métricas de uso e receita                      | Média      | Implementado |
| RF-082 | Relatórios      | O painel do freelancer deve exibir gráfico de ganhos por período                                                      | Média      | Implementado |
> ℹ️ RF-069: "crítico" aqui é o que vale uma batida no aparelho (os tipos que também vão por e-mail, ADR 52); mensagens do chat ficam fora para não virar barulho. "O que não pode esperar" durante o horário de silêncio é outra coisa, escolhida pela pessoa (RN-077, ADR 56).

---

## Módulo 15 — Troca de Serviços (Escambo)

O diferencial central da plataforma: pagar serviço com serviço. Funciona em modo **híbrido** — a diferença
de valor entre os dois lados (a _torna_) é paga em dinheiro via escrow.

| ID     | Descrição                                                                                                                     | Prioridade | Status   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------- | -------- |
| RF-083 | O sistema deve permitir que um usuário proponha uma troca de serviços (serviço por serviço), com ou sem diferença em dinheiro | Alta       | Implementado |
| RF-084 | O sistema deve estimar o valor de cada lado da troca e calcular a diferença (torna) a ser paga em dinheiro                    | Alta       | Implementado |
| RF-085 | Ao aceitar uma troca, o sistema deve gerar dois contratos recíprocos vinculados e reter a torna em escrow                     | Alta       | Implementado |
---

## Recursos Avançados, Confiança e Segurança (RF-086 a RF-092)

Requisitos distribuídos por módulos existentes (Serviços, Contratações, Suporte, Autenticação e LGPD).

| ID     | Módulo                    | Descrição                                                                                                                                    | Prioridade | Status       |
| ------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------ |
| RF-086 | Categorias e Serviços     | O freelancer deve poder oferecer pacotes (Basic / Standard / Premium) por serviço, cada um com preço, prazo e nº de revisões próprios        | Média      | Não implementado |
| RF-087 | Categorias e Serviços     | O cliente deve poder favoritar serviços/freelancers e salvar buscas com alerta de novos resultados                                           | Média      | Implementado |
| RF-088 | Contratações              | O sistema deve permitir dividir um contrato em marcos (milestones), com pagamento e liberação por etapa                                      | Média      | Implementado |
| RF-089 | Suporte e Mediação        | O usuário deve poder denunciar conteúdo ou usuário; o sistema registra a denúncia e a encaminha à moderação                                  | Alta       | Implementado |
| RF-090 | Autenticação / LGPD       | O usuário deve poder ativar verificação em duas etapas (2FA) e solicitar a exportação dos seus dados pessoais (portabilidade LGPD)           | Alta       | Parcial |
| RF-091 | Perfis / Reputação        | O freelancer deve poder ver suas desistências, até quando contam e contestar cada evento uma vez enquanto conta, com decisão privada e aviso | Alta       | Implementado |
| RF-092 | Administração / Moderação | O administrador deve poder decidir contestação ou desconsiderar desistência com nota obrigatória e auditada, na fila ou na revisão da conta  | Alta       | Implementado |
> ℹ️ RF-091/RF-092: a contagem pública limita-se ao número dos últimos 60 dias e ao alerta; confirmação pelo cliente em 7 dias ou decisão `excused` retira o evento da contagem. Nenhuma ação reputacional move dinheiro nem suspende a conta automaticamente (RN-026, ADR 61).

---

## Resumo por Módulo

| Módulo                           | Total de RFs | Alta   | Média  | Baixa |
| -------------------------------- | ------------ | ------ | ------ | ----- |
| 01 — Autenticação                | 10           | 8      | 2      | 0     |
| 02 — Perfis                      | 10           | 7      | 2      | 1     |
| 03 — Categorias e Serviços       | 10           | 6      | 4      | 0     |
| 04 — Contratações                | 10           | 9      | 1      | 0     |
| 05 — Pagamentos                  | 10           | 9      | 1      | 0     |
| 06 — Avaliações                  | 6            | 5      | 1      | 0     |
| 07 — Chat                        | 6            | 3      | 2      | 1     |
| 08 — Gamificação                 | 6            | 4      | 2      | 0     |
| 09 a 14 — Demais módulos         | 14           | 9      | 5      | 0     |
| 15 — Troca de Serviços (Escambo) | 3            | 3      | 0      | 0     |
| Recursos avançados (RF-086–092)  | 7            | 4      | 3      | 0     |
| **Total**                        | **92**       | **67** | **23** | **2** |

> ℹ️ Situação conferida no código e nos testes em 19/10/2026 e atualizada com a v1.45.0: **83 implementados, 2 parciais, 5 não implementados e 2 fora do escopo**. A evidência de cada um e o que falta estão em [rastreabilidade](./rastreabilidade.md).

> ℹ️ O total ficou em **92 requisitos funcionais**, superando os 72 planejados inicialmente — resultado do detalhamento granular e da inclusão da **troca de serviços (escambo)** e de recursos avançados de confiança e segurança (v1.1.0), com dois requisitos de desistência e revisão humana acrescentados pelo ADR 61 (v1.2.0).

---

<div align="center">

_requisitos-funcionais.md — Escambo v1.2.0 — PAC Extensionista VII — Católica SC — 2026_

</div>
