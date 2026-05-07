# Requisitos Funcionais — Escambo

> **Versão:** 1.0.0  
> **Total de Requisitos:** 72  
> **Atualizado em:** Abril de 2026  
> **Autor:** [Seu Nome]

---

## Legenda

| Campo | Descrição |
|---|---|
| **ID** | Identificador único do requisito |
| **Descrição** | O que o sistema deve fazer |
| **Prioridade** | `Alta` — essencial para o MVP / `Média` — importante mas não bloqueante / `Baixa` — desejável |
| **Módulo** | Módulo funcional ao qual o requisito pertence |
| **Status** | `Pendente` / `Em desenvolvimento` / `Concluído` |

---

## Módulo 01 — Autenticação

| ID | Descrição | Prioridade | Status |
|---|---|---|---|
| RF-001 | O sistema deve permitir cadastro de novos usuários via e-mail e senha | Alta | Pendente |
| RF-002 | O sistema deve permitir login social via conta Google (OAuth2) | Alta | Pendente |
| RF-003 | O sistema deve emitir tokens JWT com tempo de expiração configurável após autenticação bem-sucedida | Alta | Pendente |
| RF-004 | O sistema deve suportar refresh token para renovação de sessão sem novo login | Alta | Pendente |
| RF-005 | O sistema deve enviar e-mail de confirmação de conta após o cadastro | Alta | Pendente |
| RF-006 | O sistema deve bloquear o acesso de contas não verificadas a funcionalidades críticas | Alta | Pendente |
| RF-007 | O sistema deve permitir recuperação de senha via link enviado ao e-mail cadastrado | Alta | Pendente |
| RF-008 | O sistema deve invalidar tokens de recuperação de senha após uso ou expiração | Alta | Pendente |
| RF-009 | O sistema deve registrar data, IP e user-agent de cada login bem-sucedido | Média | Pendente |
| RF-010 | O sistema deve permitir que o usuário encerre todas as sessões ativas simultaneamente | Média | Pendente |

---

## Módulo 02 — Perfis

| ID | Descrição | Prioridade | Status |
|---|---|---|---|
| RF-011 | O freelancer deve poder criar perfil com nome, foto, bio, headline e localização | Alta | Pendente |
| RF-012 | O freelancer deve poder adicionar itens ao portfólio com título, descrição e imagem | Alta | Pendente |
| RF-013 | O freelancer deve poder definir sua disponibilidade (disponível / indisponível) | Alta | Pendente |
| RF-014 | O cliente deve poder visualizar o perfil completo do freelancer antes de contratar | Alta | Pendente |
| RF-015 | O sistema deve exibir no perfil do freelancer: nota média, total de serviços e badges conquistadas | Alta | Pendente |
| RF-016 | O sistema deve exibir o tempo médio de resposta do freelancer em seu perfil | Média | Pendente |
| RF-017 | O usuário deve poder editar seus dados pessoais a qualquer momento | Alta | Pendente |
| RF-018 | O sistema deve suportar perfil do tipo empresa com CNPJ, logo e dados corporativos | Baixa | Pendente |
| RF-019 | O sistema deve permitir upload de foto de perfil com redimensionamento automático | Alta | Pendente |
| RF-020 | O sistema deve validar CPF do freelancer para habilitar funcionalidades financeiras | Média | Pendente |

---

## Módulo 03 — Categorias e Serviços

| ID | Descrição | Prioridade | Status |
|---|---|---|---|
| RF-021 | O sistema deve disponibilizar um catálogo hierárquico de categorias e subcategorias de serviços | Alta | Pendente |
| RF-022 | O freelancer deve poder cadastrar serviços com título, descrição, tipo de preço e prazo de entrega | Alta | Pendente |
| RF-023 | O freelancer deve poder marcar um serviço como remoto, presencial ou ambos | Alta | Pendente |
| RF-024 | O freelancer deve poder adicionar tags ao serviço para facilitar a busca | Média | Pendente |
| RF-025 | O cliente deve poder buscar serviços por categoria, localização e faixa de preço | Alta | Pendente |
| RF-026 | O sistema deve suportar busca textual por palavras-chave no título e descrição dos serviços | Alta | Pendente |
| RF-027 | O sistema deve permitir filtrar serviços por nota mínima do profissional | Média | Pendente |
| RF-028 | O sistema deve exibir serviços impulsionados em destaque no topo dos resultados de busca | Média | Pendente |
| RF-029 | O sistema deve registrar e exibir o número de visualizações de cada serviço ao freelancer | Média | Pendente |
| RF-030 | O freelancer deve poder ativar e desativar serviços sem excluí-los | Alta | Pendente |

---

## Módulo 04 — Contratações

| ID | Descrição | Prioridade | Status |
|---|---|---|---|
| RF-031 | O cliente deve poder enviar uma proposta de contratação a um freelancer | Alta | Pendente |
| RF-032 | O freelancer deve poder aceitar, recusar ou contra-propor uma proposta recebida | Alta | Pendente |
| RF-033 | O sistema deve rastrear e atualizar o status da contratação em cada etapa do fluxo | Alta | Pendente |
| RF-034 | O sistema deve registrar histórico completo de mudanças de status com data e responsável | Alta | Pendente |
| RF-035 | O freelancer deve poder registrar a entrega do serviço com mensagem e arquivos anexos | Alta | Pendente |
| RF-036 | O cliente deve poder confirmar a conclusão ou solicitar revisão após a entrega | Alta | Pendente |
| RF-037 | O sistema deve liberar o pagamento ao freelancer somente após a conclusão confirmada pelo cliente | Alta | Pendente |
| RF-038 | O sistema deve permitir cancelamento de contratação com política de reembolso definida | Média | Pendente |
| RF-039 | O sistema deve notificar ambas as partes a cada mudança de status na contratação | Alta | Pendente |
| RF-040 | O sistema deve exibir histórico completo de contratações no painel do usuário | Alta | Pendente |

---

## Módulo 05 — Pagamentos

| ID | Descrição | Prioridade | Status |
|---|---|---|---|
| RF-041 | O sistema deve processar pagamentos via MercadoPago (PIX, cartão de crédito, boleto) | Alta | Pendente |
| RF-042 | O pagamento do cliente deve ficar retido em escrow até a conclusão confirmada do serviço | Alta | Pendente |
| RF-043 | O sistema deve calcular e exibir a taxa da plataforma de forma transparente antes da confirmação | Alta | Pendente |
| RF-044 | O freelancer deve ter uma carteira digital com saldo disponível e saldo pendente separados | Alta | Pendente |
| RF-045 | O freelancer deve poder solicitar saque via PIX ou transferência bancária | Alta | Pendente |
| RF-046 | O sistema deve processar saques dentro do prazo configurado pelo administrador | Alta | Pendente |
| RF-047 | O sistema deve exibir histórico detalhado de transações com filtro por período | Alta | Pendente |
| RF-048 | O sistema deve emitir notificação ao receber e ao processar um pagamento | Alta | Pendente |
| RF-049 | O sistema deve suportar reembolso parcial ou total em casos de cancelamento | Média | Pendente |
| RF-050 | O sistema deve registrar a resposta completa do gateway para auditoria | Alta | Pendente |

---

## Módulo 06 — Avaliações

| ID | Descrição | Prioridade | Status |
|---|---|---|---|
| RF-051 | O cliente deve poder avaliar o freelancer após a conclusão confirmada do serviço | Alta | Pendente |
| RF-052 | A avaliação deve incluir nota de 1 a 5 estrelas e comentário textual opcional | Alta | Pendente |
| RF-053 | O sistema deve vincular cada avaliação obrigatoriamente a uma contratação real e concluída | Alta | Pendente |
| RF-054 | O freelancer deve poder responder publicamente a avaliações recebidas | Média | Pendente |
| RF-055 | O sistema deve recalcular e atualizar a nota média do freelancer após cada nova avaliação | Alta | Pendente |
| RF-056 | O sistema deve exibir as avaliações mais recentes no perfil do freelancer | Alta | Pendente |

---

## Módulo 07 — Chat

| ID | Descrição | Prioridade | Status |
|---|---|---|---|
| RF-057 | O sistema deve disponibilizar chat em tempo real entre cliente e freelancer | Alta | Pendente |
| RF-058 | O chat deve suportar envio de texto, imagens e arquivos | Alta | Pendente |
| RF-059 | O sistema deve exibir indicador de leitura das mensagens (lido / não lido) | Média | Pendente |
| RF-060 | O sistema deve notificar o usuário via push ao receber uma nova mensagem | Alta | Pendente |
| RF-061 | O histórico de mensagens deve ser preservado e acessível mesmo após a conclusão do serviço | Média | Pendente |
| RF-062 | O sistema deve impedir o envio de mensagens em contratações canceladas ou encerradas | Baixa | Pendente |

---

## Módulo 08 — Gamificação

| ID | Descrição | Prioridade | Status |
|---|---|---|---|
| RF-063 | O sistema deve atribuir XP ao freelancer por ações relevantes (serviço concluído, avaliação recebida, missão cumprida) | Alta | Pendente |
| RF-064 | O sistema deve calcular o nível do usuário com base no XP total acumulado | Alta | Pendente |
| RF-065 | O sistema deve emitir badges automaticamente ao atingir marcos definidos | Alta | Pendente |
| RF-066 | O sistema deve disponibilizar missões periódicas com recompensas em XP | Média | Pendente |
| RF-067 | O sistema deve exibir ranking local de freelancers por categoria e nota | Média | Pendente |
| RF-068 | O sistema deve exibir no perfil o nível atual, XP acumulado e badges conquistadas | Alta | Pendente |

---

## Módulos 09 a 14

| ID | Módulo | Descrição | Prioridade | Status |
|---|---|---|---|---|
| RF-069 | Notificações | O sistema deve enviar push notification para eventos críticos (nova proposta, mensagem, pagamento) | Alta | Pendente |
| RF-070 | Notificações | O sistema deve enviar e-mail transacional para confirmação de conta, pagamento e encerramento de contrato | Alta | Pendente |
| RF-071 | Suporte | O usuário deve poder abrir um ticket de suporte diretamente no app com categoria e descrição | Alta | Pendente |
| RF-072 | Suporte | O administrador deve poder intervir em disputas entre cliente e freelancer e emitir uma resolução vinculante | Alta | Pendente |
| RF-073 | Suporte | O sistema deve permitir troca de mensagens internas entre usuário e equipe de suporte dentro do ticket | Alta | Pendente |
| RF-074 | Impulsionamento | O freelancer deve poder contratar um plano de impulsionamento com duração e alcance definidos | Média | Pendente |
| RF-075 | Impulsionamento | O sistema deve exibir serviços impulsionados ativos com destaque visual nos resultados | Média | Pendente |
| RF-076 | Administração | O painel administrativo deve exibir métricas gerais de usuários, contratos, receita e tickets em tempo real | Alta | Pendente |
| RF-077 | Administração | O administrador deve poder suspender, banir ou reativar qualquer conta da plataforma | Alta | Pendente |
| RF-078 | Administração | O administrador deve poder configurar parâmetros da plataforma (taxa, prazo de saque, manutenção) sem deploy | Média | Pendente |
| RF-079 | LGPD | O sistema deve registrar o consentimento explícito do usuário nos termos de uso e política de privacidade no cadastro | Alta | Pendente |
| RF-080 | LGPD | O usuário deve poder solicitar a exclusão definitiva de seus dados pessoais da plataforma | Alta | Pendente |
| RF-081 | Relatórios | O sistema deve gerar snapshots periódicos (diário, semanal, mensal) de métricas de uso e receita | Média | Pendente |
| RF-082 | Relatórios | O painel do freelancer deve exibir gráfico de ganhos por período | Média | Pendente |

---

## Resumo por Módulo

| Módulo | Total de RFs | Alta | Média | Baixa |
|---|---|---|---|---|
| 01 — Autenticação | 10 | 8 | 2 | 0 |
| 02 — Perfis | 10 | 7 | 2 | 1 |
| 03 — Categorias e Serviços | 10 | 6 | 4 | 0 |
| 04 — Contratações | 10 | 9 | 1 | 0 |
| 05 — Pagamentos | 10 | 9 | 1 | 0 |
| 06 — Avaliações | 6 | 5 | 1 | 0 |
| 07 — Chat | 6 | 4 | 2 | 1 |
| 08 — Gamificação | 6 | 4 | 2 | 0 |
| 09 a 14 — Demais módulos | 14 | 10 | 4 | 0 |
| **Total** | **82** | **62** | **19** | **2** |

> ℹ️ O total final ficou em **82 requisitos funcionais**, superando os 72 planejados inicialmente — resultado do detalhamento mais granular durante a especificação.

---

<div align="center">

*requisitos-funcionais.md — Escambo v1.0.0 — PAC Extensionista VII — Católica SC — 2026*

</div>
