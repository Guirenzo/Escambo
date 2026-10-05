# Regras de Negócio — Escambo

> **Versão:** 1.0.0  
> **Disciplina:** PAC Extensionista VII — Católica SC  
> **Autor:** Guilherme Renzo 
> **Data:** 2026

---

## Índice

1. [Introdução](#1-introdução)
2. [RN-01 a RN-10 — Usuários e Autenticação](#2-rn-01-a-rn-10--usuários-e-autenticação)
3. [RN-11 a RN-20 — Perfis e Serviços](#3-rn-11-a-rn-20--perfis-e-serviços)
4. [RN-21 a RN-30 — Contratações](#4-rn-21-a-rn-30--contratações)
5. [RN-31 a RN-40 — Pagamentos e Carteira](#5-rn-31-a-rn-40--pagamentos-e-carteira)
6. [RN-41 a RN-50 — Avaliações e Reputação](#6-rn-41-a-rn-50--avaliações-e-reputação)
7. [RN-51 a RN-60 — Gamificação](#7-rn-51-a-rn-60--gamificação)
8. [RN-61 a RN-65 — Suporte e Disputas](#8-rn-61-a-rn-65--suporte-e-disputas)
9. [RN-66 a RN-70 — Troca, Pacotes e Confiança](#81-rn-66-a-rn-70--troca-pacotes-e-confiança)
10. [RN-71 a RN-81 — Conformidade, LGPD, avisos e prazos](#9-rn-71-a-rn-81--conformidade-lgpd-avisos-e-prazos)
11. [Tabela Consolidada](#10-tabela-consolidada)
12. [Matriz de situação (ADR 60)](#11-matriz-de-situação-adr-60)

---

## 1. Introdução

As Regras de Negócio (RN) definem as restrições, políticas e condições que o sistema deve respeitar independentemente da interface ou canal de acesso. Diferem dos Requisitos Funcionais (o *que* o sistema faz) por especificar *como* e *sob quais condições* ele opera.

Cada regra possui:
- **ID único** — rastreável nos RFs e casos de uso
- **Categoria** — domínio ao qual pertence
- **Descrição** — a regra em linguagem precisa
- **Impacto** — consequência do não cumprimento
- **Casos de Uso relacionados**
- **Situação** — nas regras revistas contra o código (a partir do ADR 57): implementada, parcial, não implementada ou corrigida no texto; a [matriz da seção 11](#11-matriz-de-situação-adr-60) reúne essas regras
- **Origem** — quando a regra nasceu de uma decisão registrada em `docs/decisoes.md`

O documento reúne **81 regras**, de RN-001 a RN-081.

---

## 2. RN-01 a RN-10 — Usuários e Autenticação

---

### RN-001 — Unicidade de e-mail

| Campo | Detalhe |
|---|---|
| **Categoria** | Autenticação |
| **Descrição** | Cada endereço de e-mail pode estar vinculado a **no máximo uma conta** na plataforma, independentemente do tipo de perfil (cliente, freelancer, empresa) |
| **Impacto** | Tentativa de cadastro com e-mail já existente deve ser bloqueada com mensagem orientativa |
| **UC Relacionado** | UC-01 |

---

### RN-002 — Bloqueio por tentativas de login

| Campo | Detalhe |
|---|---|
| **Categoria** | Segurança |
| **Descrição** | Após **5 tentativas consecutivas de login com falha** no mesmo IP, o sistema deve bloquear novas tentativas por **5 minutos** |
| **Impacto** | Proteção contra ataques de força bruta. O bloqueio deve ser registrado em audit_log |
| **UC Relacionado** | UC-01 |

---

### RN-003 — Expiração de token JWT

| Campo | Detalhe |
|---|---|
| **Categoria** | Segurança |
| **Descrição** | Tokens de acesso (access token) expiram em **1 hora**. Refresh tokens expiram em **7 dias**. Após expiração do refresh token, o usuário deve realizar novo login |
| **Impacto** | Sessões não renovadas são encerradas automaticamente |
| **UC Relacionado** | UC-01 |

---

### RN-004 — Verificação de e-mail obrigatória

| Campo | Detalhe |
|---|---|
| **Categoria** | Autenticação |
| **Descrição** | Contas não verificadas por e-mail têm acesso restrito: podem visualizar serviços, mas **não podem contratar, publicar serviços nem realizar pagamentos** |
| **Impacto** | Garante a validade do e-mail antes de qualquer transação |
| **UC Relacionado** | UC-01, UC-04, UC-06 |

---

### RN-005 — Token de recuperação de senha descartável

| Campo | Detalhe |
|---|---|
| **Categoria** | Segurança |
| **Descrição** | O link de recuperação de senha é válido por **30 minutos** e pode ser utilizado **apenas uma vez**. Após uso ou expiração, o token é invalidado permanentemente |
| **Impacto** | Links reutilizados ou expirados devem redirecionar para nova solicitação |
| **UC Relacionado** | UC-01 |

---

### RN-006 — Um perfil por tipo por conta

| Campo | Detalhe |
|---|---|
| **Categoria** | Perfis |
| **Descrição** | Um usuário pode ter **apenas um perfil ativo por tipo** (cliente, freelancer ou empresa). Um mesmo usuário pode ser cliente e freelancer simultaneamente, desde que ambos os perfis estejam ativos |
| **Impacto** | Evita duplicidade de perfis e ambiguidade nas transações |
| **UC Relacionado** | UC-02 |

---

### RN-007 — Suspensão e banimento de contas

| Campo | Detalhe |
|---|---|
| **Categoria** | Moderação |
| **Descrição** | Contas suspensas perdem acesso a todas as funcionalidades transacionais mas mantêm acesso para visualização e contato com suporte. Contas banidas perdem acesso total à plataforma |
| **Impacto** | Apenas administradores podem suspender, banir ou reativar contas |
| **UC Relacionado** | UC-11 |
| **Situação** | Parcial (ADR 60): hoje a suspensão bloqueia o acesso como o banimento (as sessões caem e o login é recusado até o admin reativar); o acesso só de leitura e ao suporte para a conta suspensa não foi implementado. Administradores não são suspensos nem banidos pelo painel, nem por si mesmos |

---

### RN-008 — Encerramento de todas as sessões

| Campo | Detalhe |
|---|---|
| **Categoria** | Segurança |
| **Descrição** | Ao alterar a senha, **todas as sessões ativas do usuário são encerradas automaticamente**, incluindo dispositivos mobile e web, exceto a sessão atual |
| **Impacto** | Protege o usuário em caso de comprometimento da conta |
| **UC Relacionado** | UC-01 |

---

### RN-009 — Maioridade para uso financeiro

| Campo | Detalhe |
|---|---|
| **Categoria** | Conformidade |
| **Descrição** | Funcionalidades financeiras (pagamento, saque, contratação) estão disponíveis apenas para usuários **maiores de 18 anos**, conforme declaração no cadastro |
| **Impacto** | Declaração falsa é de responsabilidade do usuário, conforme Termos de Uso |
| **UC Relacionado** | UC-01, UC-06 |

---

### RN-010 — Audit log de ações críticas

| Campo | Detalhe |
|---|---|
| **Categoria** | Segurança |
| **Descrição** | Toda ação crítica (login, alteração de senha, mudança de status de conta, transação financeira) deve ser registrada em `audit_logs` com: user_id, ação, IP, user_agent e timestamp |
| **Impacto** | Rastreabilidade obrigatória para conformidade LGPD e resolução de disputas |
| **UC Relacionado** | UC-01, UC-06, UC-11 |

---

## 3. RN-11 a RN-20 — Perfis e Serviços

---

### RN-011 — Perfil incompleto não aparece na busca

| Campo | Detalhe |
|---|---|
| **Categoria** | Perfis |
| **Descrição** | Perfis de freelancer que não possuam **foto, bio e pelo menos uma categoria de atuação** preenchidas não aparecem nos resultados de busca |
| **Impacto** | Incentiva o preenchimento completo do perfil antes da exposição pública |
| **UC Relacionado** | UC-02, UC-03 |

---

### RN-012 — Limite de itens no portfólio

| Campo | Detalhe |
|---|---|
| **Categoria** | Perfis |
| **Descrição** | O portfólio de um freelancer pode conter **no máximo 20 itens** no plano gratuito. Planos de impulsionamento podem ampliar esse limite |
| **Impacto** | Controle de armazenamento e experiência de visualização |
| **UC Relacionado** | UC-02 |

---

### RN-013 — Serviço inativo não aceita propostas

| Campo | Detalhe |
|---|---|
| **Categoria** | Serviços |
| **Descrição** | Serviços com status **inativo ou pausado** não aparecem na busca e não aceitam novas propostas de contratação |
| **Impacto** | Freelancers podem pausar serviços temporariamente sem perder o histórico |
| **UC Relacionado** | UC-03 |
| **Situação** | Implementada (ADR 60): a API recusa proposta de contratação e de troca para serviço pausado (`service_inactive`). O serviço pausado continua abrindo pelo link, para ver |

---

### RN-014 — Freelancer indisponível bloqueia novas propostas

| Campo | Detalhe |
|---|---|
| **Categoria** | Serviços |
| **Descrição** | Quando o freelancer define seu status como **indisponível**, o botão "Contratar" é ocultado em todos os seus serviços. O perfil continua visível para visualização |
| **Impacto** | Evita acúmulo de propostas que o freelancer não pode atender |
| **UC Relacionado** | UC-03, UC-04 |

---

### RN-015 — Limite de serviços ativos por freelancer

| Campo | Detalhe |
|---|---|
| **Categoria** | Serviços |
| **Descrição** | Freelancers no plano gratuito podem ter **até 5 serviços ativos simultaneamente**. Planos pagos ampliam esse limite |
| **Impacto** | Controle da oferta na plataforma e incentivo aos planos de impulsionamento |
| **UC Relacionado** | UC-03 |

---

### RN-016 — Preço mínimo de serviço

| Campo | Detalhe |
|---|---|
| **Categoria** | Serviços |
| **Descrição** | O valor mínimo de um serviço com preço fixo é de **R$ 10,00**. Serviços abaixo desse valor não podem ser publicados |
| **Impacto** | Evita transações não viáveis operacionalmente para a plataforma |
| **UC Relacionado** | UC-03 |
| **Situação** | Implementada; corrigida na edição (ADR 60): a mudança de tipo ou de preço é conferida no estado final |

---

### RN-017 — Impulsionamento exclusivo por serviço ou perfil

| Campo | Detalhe |
|---|---|
| **Categoria** | Impulsionamento |
| **Descrição** | Um freelancer pode ter **apenas um impulsionamento ativo** por serviço ou por perfil simultaneamente. Novos impulsionamentos só podem ser contratados após o término do atual |
| **Impacto** | Garante equidade no sistema de destaque |
| **UC Relacionado** | UC-03 |
| **Situação** | Implementada (ADR 60): a segunda compra é recusada enquanto a primeira vale, dizendo até quando; serviço pausado não é impulsionado |

---

### RN-018 — Tags por serviço

| Campo | Detalhe |
|---|---|
| **Categoria** | Serviços |
| **Descrição** | Cada serviço pode ter **no máximo 10 tags**. Tags devem ter entre 2 e 30 caracteres |
| **Impacto** | Controle da qualidade da busca por palavras-chave |
| **UC Relacionado** | UC-03 |

---

### RN-019 — Ranqueamento de resultados de busca

| Campo | Detalhe |
|---|---|
| **Categoria** | Busca |
| **Descrição** | Os resultados de busca são ordenados por: **(1) impulsionamento ativo → (2) nota média → (3) proximidade geográfica → (4) total de serviços concluídos**. O cliente pode alterar a ordenação manualmente |
| **Impacto** | Transparência no ranqueamento; serviços impulsionados aparecem com badge "Destaque" |
| **UC Relacionado** | UC-04 |

---

### RN-020 — Proposta única por par cliente-freelancer

| Campo | Detalhe |
|---|---|
| **Categoria** | Contratações |
| **Descrição** | Um cliente não pode enviar nova proposta ao mesmo freelancer enquanto houver uma proposta **pendente ou em andamento** entre eles |
| **Impacto** | Evita duplicidade de contratações e confusão no fluxo |
| **UC Relacionado** | UC-04 |

---

## 4. RN-21 a RN-30 — Contratações

---

### RN-021 — Prazo para aceite de proposta

| Campo | Detalhe |
|---|---|
| **Categoria** | Contratações |
| **Descrição** | O freelancer tem até a hora de validade da proposta para aceitar ou recusar (a contra-proposta é a RN-030, ainda não implementada). A validade é **gravada na criação**: **72 horas** depois (`platform_settings.proposal_expiry_hours`, padrão 72) ou, se o prazo de entrega vier antes, o último instante de dia antes dele, e nunca entre 20h30 e 9h no fuso do freelancer (passa para as 9h seguintes, RN-078). Com menos de 1 hora para responder, a proposta nem é criada. O aviso da proposta diz até quando responder, e a Sala mostra a mesma hora; o freelancer é lembrado antes (RN-079), e o prazo de entrega da proposta é dito como dia (RN-080). Proposta vencida, ou com o prazo de entrega já passado, **não pode ser aceita**. Sem resposta até a hora gravada, o job `expire-proposals` encerra a proposta com a nota do motivo, a reserva da carteira volta ao cliente e os dois são avisados; o job só age com o fuso do freelancer de dia. Mudar o painel vale para as propostas criadas depois |
| **Impacto** | Garante agilidade no processo e libera o cliente para buscar outro profissional; a hora avisada é a cumprida |
| **UC Relacionado** | UC-05 |
| **Situação** | Implementada (ADR 57) |

---

### RN-022 — Histórico imutável de status

| Campo | Detalhe |
|---|---|
| **Categoria** | Contratações |
| **Descrição** | Cada mudança de status de uma contratação gera um registro **imutável** em `contract_status_history` com: status anterior, status novo, responsável pela mudança e timestamp |
| **Impacto** | Garante rastreabilidade completa para auditoria e resolução de disputas |
| **UC Relacionado** | UC-05 |

---

### RN-023 — Limite de revisões

| Campo | Detalhe |
|---|---|
| **Categoria** | Contratações |
| **Descrição** | O cliente pode solicitar **até 2 revisões** por contratação sem custo adicional. Revisões além desse limite devem ser negociadas diretamente entre as partes via chat |
| **Impacto** | Protege o freelancer de revisões ilimitadas sem remuneração adicional |
| **UC Relacionado** | UC-05 |
| **Situação** | Não implementada (revista no ADR 57): hoje o cliente pode pedir revisão sem limite de rodadas. O fluxo não depende dela: a revisão não abre disputa automática (RN-029), então repetir revisões não leva a contratação à mediação sozinha |

---

### RN-024 — Aprovação tácita de entrega

| Campo | Detalhe |
|---|---|
| **Categoria** | Contratações |
| **Descrição** | Se o cliente não aprovar, não pedir revisão nem abrir disputa até a hora gravada na entrega, o sistema considera a entrega **automaticamente aprovada** e libera o pagamento ao freelancer. A hora é **5 dias corridos** depois da entrega (`platform_settings.tacit_approval_days`, padrão 5), gravada a cada entrega, dita no aviso da entrega e na Sala, e nunca cai entre 20h30 e 9h no fuso do cliente (passa para as 9h seguintes, RN-078). Vale por marco: cada marco entregue tem a própria hora (RN-069). O cliente é lembrado antes (RN-079). Quando a aprovação acontece, as duas partes são avisadas: o cliente com até quando pode avaliar (RN-043), o freelancer com o líquido; depois dela não há revisão nem disputa. O job `tacit-approval` só age com o fuso do cliente de dia (a cópia do freelancer pode chegar das 6h à meia-noite dele); mudar o painel vale para as entregas registradas depois |
| **Impacto** | Protege o freelancer de clientes que ignoram a entrega indefinidamente |
| **UC Relacionado** | UC-05, UC-06 |
| **Situação** | Implementada (ADR 57; avisos às duas partes no ADR 58). Corrigida no texto: dizia "5 dias úteis", mas o código sempre contou dias corridos, e os Termos de Uso sempre disseram "5 dias" |

---

### RN-025 — Cancelamento com reembolso proporcional

| Campo | Detalhe |
|---|---|
| **Categoria** | Cancelamentos |
| **Descrição** | O valor do cancelamento sai de uma conta só (`cancelTerms`), a mesma que a Sala mostra e que liquida. **Proposta (antes do aceite)** → o cliente retira a proposta e a reserva volta inteira; o freelancer usa "Recusar" / **Freelancer desiste depois do aceite** → tudo o que está em garantia volta ao cliente (RN-026) / **Cliente, contratação sem prazo** → reembolso de 50% / **Cliente, prazo vencido sem nenhuma entrega** (por marcos, com algum marco financiado nunca entregue) → reembolso de 100% a partir do aviso de atraso da RN-029 (o gravado, ou as 9h previstas no fuso de quem entrega se o job ainda não rodou); antes do aviso, o cancelamento espera, e o app diz a hora / **Cliente, prazo vencido com um pedido de extensão esperando resposta** → responder ao pedido antes de cancelar / **Cliente, antes do prazo** → reembolso de 50% se passou menos da metade do tempo entre o **aceite** e o prazo, sem reembolso se passou mais / **Créditos Escambo** → os créditos em garantia voltam inteiros ao cliente / **Por marcos** → a conta vale sobre o que ainda está em garantia (o já liberado não volta), e um marco entregue em aberto, esperando o cliente ou em revisão, trava o cancelamento / **Entregue ou em revisão** → não se cancela: aprovar, pedir revisão ou abrir disputa. A taxa segue a proporção do reembolso (RN-039). O app mostra os valores antes de confirmar, e o pedido leva o valor visto: se ele mudou nesse meio-tempo (o prazo venceu, um marco foi entregue), nada se move e a Sala mostra o novo. A outra parte é avisada (`contract_cancelled`) do que aconteceu com o dinheiro dela. A carência da RN-029 protege quem entrega contra a disputa automática, não contra o cancelamento do cliente |
| **Impacto** | Política clara e transparente para ambas as partes: ninguém cancela sem ver o valor, quem desiste não fica com o escrow e o cliente de um atraso sem entrega recebe tudo de volta |
| **UC Relacionado** | UC-05, UC-06 |
| **Situação** | Implementada (ADR 57) |

---

### RN-026 — Cancelamento pelo freelancer impacta reputação

| Campo | Detalhe |
|---|---|
| **Categoria** | Contratações |
| **Descrição** | Cancelamentos iniciados pelo freelancer após aceite da proposta são registrados no histórico público do perfil. **3 ou mais cancelamentos nos últimos 60 dias** resultam em alerta automático no perfil e revisão pela equipe |
| **Impacto** | Desincentiva cancelamentos oportunistas |
| **UC Relacionado** | UC-05 |
| **Situação** | Parcial (ADR 57). Implementado em parte: a desistência depois do aceite devolve ao cliente tudo o que está em garantia, fica na linha do tempo e avisa o cliente. O histórico público e o alerta por 3 cancelamentos em 60 dias seguem pendentes |

---

### RN-027 — Contratação mínima de valor

| Campo | Detalhe |
|---|---|
| **Categoria** | Contratações |
| **Descrição** | Contratações com valor abaixo de **R$ 10,00** não são permitidas, independentemente do tipo de serviço |
| **Impacto** | Alinhado ao preço mínimo de serviço (RN-016) |
| **UC Relacionado** | UC-04, UC-06 |

---

### RN-028 — Extensão de prazo mediante acordo

| Campo | Detalhe |
|---|---|
| **Categoria** | Contratações |
| **Descrição** | O freelancer pode pedir a extensão do prazo de entrega pela Sala (nova data e motivo) **até 2 vezes** por contratação, e **só 1 pedido pode ser aceito**, sempre com **aceite explícito do cliente** pelo app. Só vale **antes da primeira entrega** (por marcos, enquanto algum marco financiado nunca foi entregue), com um pedido de cada vez e nunca depois do fim da carência da RN-029. O novo prazo é uma data no fuso do prazo (RN-080). O cliente responde até a hora dita no pedido: 48 horas depois (valor fixo no código; a chave no painel foi adiada de novo no ADR 58), levadas para as 9h se caírem de noite no fuso dele, e nunca depois do último instante de dia 12 horas antes da data pedida; se sobrariam menos de 6 horas para decidir, o pedido nem é registrado (a data está perto demais). O cliente é lembrado antes, um lembrete por pedido (RN-079). Sem resposta até essa hora, o pedido **expira e vale como recusa**, com aviso às duas partes. O aceite troca o prazo, fica na linha do tempo e zera o aviso de atraso e a carência. Enquanto o pedido espera, a disputa automática espera (a carência pausa); depois da recusa ou da expiração, a carência volta de onde parou, com piso de **12 horas de relógio e 6 horas de dia** (de 9h a 20h30) a partir da decisão. Entrega, cancelamento, disputa e conclusão encerram o pedido pendente. A decisão confere o número do pedido: a recusa e a expiração do mesmo pedido nunca passam as duas |
| **Impacto** | Evita extensões unilaterais que prejudicam o cliente e pedidos repetidos, ou ignorados, que adiariam a disputa automática sem limite |
| **UC Relacionado** | UC-05 |
| **Situação** | Implementada (ADR 57) |

---

### RN-029 — Disputa automática por prazo estourado

| Campo | Detalhe |
|---|---|
| **Categoria** | Disputas |
| **Descrição** | O prazo é uma data no fuso de quem entrega (RN-080), e quem entrega é lembrado antes (RN-079). Se o prazo de entrega vence sem **nenhuma entrega** (por marcos, com algum marco financiado nunca entregue) e sem extensão aceita, o job `overdue-contracts` avisa as duas partes, uma vez, a partir das **9h** depois do prazo no fuso de quem entrega (a mesma hora que a Sala mostra antes). O aviso grava o fim da **carência** (`platform_settings.deadline_grace_hours`, padrão 24 horas depois do aviso), que nunca cai entre 20h30 e 9h (passa para as 9h, RN-078) e é dito nos dois avisos, cada um no fuso de quem lê; mudar o painel vale para os avisos dados depois. Passada essa hora, ainda sem entrega, sem extensão aceita e sem pedido esperando resposta (RN-028), a plataforma **abre a disputa** (motivo "prazo", em nome do cliente), a mediação assume e o escrow congela (RN-038). A partir do aviso, o cliente pode cancelar com **reembolso integral** (RN-025). Depois da primeira entrega (por marcos, quando todo marco financiado já foi entregue), o prazo não abre mais disputa sozinho, mesmo que a entrega volte para revisão. Só o aviso a quem entrega pode sair durante o "não perturbe" (RN-077); o do cliente espera |
| **Impacto** | Nenhuma contratação sem entrega fica em estado indefinido; depois da entrega, o desfecho é das partes |
| **UC Relacionado** | UC-05, UC-10 |
| **Situação** | Implementada (ADR 57) |

---

### RN-030 — Contra-proposta com limite de rodadas

| Campo | Detalhe |
|---|---|
| **Categoria** | Contratações |
| **Descrição** | O processo de negociação via contra-proposta é limitado a **3 rodadas** (cliente → freelancer → cliente → freelancer → cliente → freelancer). Após isso, a proposta original expira e o cliente pode iniciar uma nova |
| **Impacto** | Evita negociações intermináveis que bloqueiam ambas as partes |
| **UC Relacionado** | UC-05 |

---

## 5. RN-31 a RN-40 — Pagamentos e Carteira

---

### RN-031 — Taxa da plataforma

| Campo | Detalhe |
|---|---|
| **Categoria** | Pagamentos |
| **Descrição** | A plataforma retém uma taxa de comissão de **15%** sobre o valor bruto de cada contratação concluída. O valor líquido ao freelancer é calculado como: `valor_bruto × 0,85` |
| **Impacto** | Taxa exibida de forma transparente antes da confirmação da contratação |
| **UC Relacionado** | UC-06 |

---

### RN-032 — Pagamento em escrow obrigatório

| Campo | Detalhe |
|---|---|
| **Categoria** | Pagamentos |
| **Descrição** | **100% do valor da contratação** deve ser pago pelo cliente e retido em escrow antes do início do serviço. O freelancer só tem acesso ao valor após a conclusão confirmada |
| **Impacto** | Garante segurança para ambas as partes. Freelancer não inicia o serviço sem pagamento garantido |
| **UC Relacionado** | UC-06 |

---

### RN-033 — Liberação do pagamento

| Campo | Detalhe |
|---|---|
| **Categoria** | Pagamentos |
| **Descrição** | O pagamento é liberado para a carteira do freelancer **imediatamente** após: (1) aprovação explícita da entrega pelo cliente, ou (2) aprovação tácita por decurso do prazo (RN-024) |
| **Impacto** | Nenhum pagamento é liberado antes da confirmação de conclusão |
| **UC Relacionado** | UC-06 |

---

### RN-034 — Saque mínimo

| Campo | Detalhe |
|---|---|
| **Categoria** | Carteira |
| **Descrição** | O valor mínimo para solicitação de saque é de **R$ 20,00**. Saques abaixo desse valor são bloqueados pelo sistema. O saque exige **e-mail confirmado** (ação sensível: é a única que tira dinheiro da plataforma) |
| **Impacto** | Reduz custo operacional de transferências de baixo valor |
| **UC Relacionado** | UC-06 |

---

### RN-035 — Prazo de processamento de saque

| Campo | Detalhe |
|---|---|
| **Categoria** | Carteira |
| **Descrição** | Saques solicitados via PIX são processados em **até 1 dia útil**. Saques via transferência bancária (TED) em **até 2 dias úteis** |
| **Impacto** | Prazo exibido ao freelancer no momento da solicitação |
| **UC Relacionado** | UC-06 |

---

### RN-036 — Reembolso para o método original

| Campo | Detalhe |
|---|---|
| **Categoria** | Pagamentos |
| **Descrição** | Reembolsos são processados **exclusivamente para o método de pagamento original** utilizado pelo cliente. Reembolsos de boleto ou PIX são devolvidos via PIX para chave cadastrada |
| **Impacto** | Conformidade com as regras do gateway MercadoPago |
| **UC Relacionado** | UC-06 |

---

### RN-037 — Tentativas de pagamento com falha

| Campo | Detalhe |
|---|---|
| **Categoria** | Pagamentos |
| **Descrição** | Em caso de falha no processamento, o sistema realiza **até 3 tentativas automáticas** com intervalo de 5 minutos. Após a 3ª falha, o cliente é notificado para tentar outro método |
| **Impacto** | Reduz abandono de pagamento por falhas transitórias |
| **UC Relacionado** | UC-06 |

---

### RN-038 — Saldo bloqueado em disputa

| Campo | Detalhe |
|---|---|
| **Categoria** | Disputas |
| **Descrição** | Durante a análise de uma disputa, o valor em escrow referente à contratação envolvida é **bloqueado** e não pode ser sacado nem reembolsado até a resolução pelo administrador |
| **Impacto** | Garante que o valor esteja disponível para a resolução correta |
| **UC Relacionado** | UC-06, UC-10 |

---

### RN-039 — Taxa dividida na proporção do reembolso

| Campo | Detalhe |
|---|---|
| **Categoria** | Pagamentos |
| **Descrição** | Em cancelamento depois do aceite, a taxa da plataforma é dividida na mesma proporção do reembolso (ADR 15): com reembolso integral, a taxa volta inteira ao cliente. O cliente recebe a fração do **preço** (com a parte proporcional da taxa), o freelancer fica com o restante do **líquido** e a plataforma retém só a parte proporcional da taxa: com reembolso de 50%, metade da taxa; sem reembolso, a taxa inteira. A decisão de uma disputa segue a mesma conta. Contratações em créditos Escambo não têm taxa |
| **Impacto** | Quem é reembolsado não paga taxa sobre o que voltou para ele, e o dinheiro fecha em qualquer caminho (cliente + freelancer + taxa = preço) |
| **UC Relacionado** | UC-05, UC-06 |
| **Situação** | Corrigida no texto (ADR 57): a regra dizia que a taxa ficava retida integralmente depois do início do serviço, o que divergia do código desde o ADR 15 |

---

### RN-040 — Histórico financeiro imutável

| Campo | Detalhe |
|---|---|
| **Categoria** | Auditoria |
| **Descrição** | Toda transação financeira (pagamento, liberação, saque, reembolso, taxa) é registrada de forma **imutável** com: valor, partes envolvidas, método, status e timestamp |
| **Impacto** | Conformidade LGPD e rastreabilidade para disputas e relatórios fiscais |
| **UC Relacionado** | UC-06, UC-11 |

---

## 6. RN-41 a RN-50 — Avaliações e Reputação

---

### RN-041 — Avaliação vinculada a contrato concluído

| Campo | Detalhe |
|---|---|
| **Categoria** | Avaliações |
| **Descrição** | Só é possível avaliar um freelancer após uma contratação com status **"Concluído"**. Não é permitido avaliar sem contratação real registrada na plataforma |
| **Impacto** | Elimina avaliações falsas e garante credibilidade do sistema de reputação |
| **UC Relacionado** | UC-07 |

---

### RN-042 — Uma avaliação por contrato

| Campo | Detalhe |
|---|---|
| **Categoria** | Avaliações |
| **Descrição** | Cada contratação concluída gera **exatamente uma avaliação** — não é possível editar ou excluir após publicação |
| **Impacto** | Garante a imutabilidade do histórico de reputação |
| **UC Relacionado** | UC-07 |

---

### RN-043 — Prazo para avaliação

| Campo | Detalhe |
|---|---|
| **Categoria** | Avaliações |
| **Descrição** | O cliente tem **7 dias corridos** após a conclusão para avaliar, contados pelo relógio da plataforma. Após esse prazo, a avaliação não pode mais ser registrada. O aviso da conclusão automática (RN-024) diz até quando avaliar |
| **Impacto** | Garante relevância temporal das avaliações |
| **UC Relacionado** | UC-07 |

---

### RN-044 — Nota média calculada em tempo real

| Campo | Detalhe |
|---|---|
| **Categoria** | Reputação |
| **Descrição** | A nota média do freelancer é recalculada **imediatamente** após cada nova avaliação, usando a média aritmética de todas as avaliações públicas ativas |
| **Impacto** | Dados sempre atualizados no perfil e nos resultados de busca |
| **UC Relacionado** | UC-07 |

---

### RN-045 — Nota mínima para manter serviços ativos

| Campo | Detalhe |
|---|---|
| **Categoria** | Reputação |
| **Descrição** | Freelancers com nota média **abaixo de 2,0 estrelas** após **10 ou mais avaliações** são notificados e têm os serviços pausados automaticamente para revisão pela equipe |
| **Impacto** | Protege a qualidade percebida da plataforma |
| **UC Relacionado** | UC-07, UC-11 |

---

### RN-046 — Resposta a avaliação única

| Campo | Detalhe |
|---|---|
| **Categoria** | Avaliações |
| **Descrição** | O freelancer pode responder a uma avaliação **apenas uma vez**. A resposta não pode ser editada ou excluída após publicação |
| **Impacto** | Mantém a transparência e evita edições estratégicas |
| **UC Relacionado** | UC-07 |

---

### RN-047 — Moderação de conteúdo em avaliações

| Campo | Detalhe |
|---|---|
| **Categoria** | Moderação |
| **Descrição** | Avaliações com linguagem ofensiva, discriminatória ou que violem os Termos de Uso vão para **fila de moderação** antes de serem publicadas |
| **Impacto** | Protege freelancers de avaliações abusivas |
| **UC Relacionado** | UC-07 |

---

### RN-048 — Avaliação não afeta saque pendente

| Campo | Detalhe |
|---|---|
| **Categoria** | Avaliações |
| **Descrição** | A ausência de avaliação pelo cliente **não bloqueia** o saque do freelancer. A liberação do pagamento ocorre pela aprovação da entrega, não pela avaliação |
| **Impacto** | Avaliação é incentivada mas não é uma barreira para o recebimento |
| **UC Relacionado** | UC-06, UC-07 |

---

### RN-049 — Exibição de avaliações no perfil

| Campo | Detalhe |
|---|---|
| **Categoria** | Reputação |
| **Descrição** | O perfil exibe as **20 avaliações mais recentes** por padrão. O usuário pode carregar mais em paginação. Avaliações em moderação não são exibidas |
| **Impacto** | Performance e relevância temporal |
| **UC Relacionado** | UC-02 |

---

### RN-050 — Badge de "Avaliação Verificada"

| Campo | Detalhe |
|---|---|
| **Categoria** | Reputação |
| **Descrição** | Todas as avaliações exibem o badge **"Avaliação Verificada"**, indicando que foram geradas a partir de uma contratação real registrada na plataforma |
| **Impacto** | Diferencial de credibilidade em relação aos concorrentes |
| **UC Relacionado** | UC-07 |

---

## 7. RN-51 a RN-60 — Gamificação

---

### RN-051 — XP por ação específica

| Campo | Detalhe |
|---|---|
| **Categoria** | Gamificação |
| **Descrição** | O sistema atribui XP ao freelancer conforme a tabela: **Serviço concluído** → 100 XP / **Avaliação 5 estrelas recebida** → 50 XP / **Avaliação 4 estrelas** → 20 XP / **Missão semanal concluída** → 80 XP / **Badge conquistada** → 30 XP / **Perfil 100% preenchido** → 50 XP (único) |
| **Impacto** | Define o ritmo de progressão e os comportamentos incentivados |
| **UC Relacionado** | UC-09 |

---

### RN-052 — Tabela de níveis

| Campo | Detalhe |
|---|---|
| **Categoria** | Gamificação |
| **Descrição** | Os níveis e seus limiares de XP são: **Nível 1 — Iniciante** (0 XP) / **Nível 2 — Aprendiz** (300 XP) / **Nível 3 — Profissional** (800 XP) / **Nível 4 — Especialista** (2.000 XP) / **Nível 5 — Mestre** (5.000 XP) / **Nível 6 — Lenda** (12.000 XP) |
| **Impacto** | Nível exibido no perfil público do freelancer |
| **UC Relacionado** | UC-09 |

---

### RN-053 — Badge concedida automaticamente

| Campo | Detalhe |
|---|---|
| **Categoria** | Gamificação |
| **Descrição** | Badges são concedidas **automaticamente pelo sistema** ao atingir a condição definida. Não é possível conceder ou revogar badges manualmente, exceto por ação administrativa documentada |
| **Impacto** | Garante imparcialidade e confiança no sistema de conquistas |
| **UC Relacionado** | UC-09 |

---

### RN-054 — Missões com prazo fixo

| Campo | Detalhe |
|---|---|
| **Categoria** | Gamificação |
| **Descrição** | Missões **diárias** expiram à meia-noite do dia corrente. Missões **semanais** expiram todo domingo às 23:59. Progresso não completado é perdido |
| **Impacto** | Gera urgência e engajamento recorrente |
| **UC Relacionado** | UC-09 |

---

### RN-055 — XP não é perdido por inatividade

| Campo | Detalhe |
|---|---|
| **Categoria** | Gamificação |
| **Descrição** | O XP acumulado e o nível atingido **nunca são reduzidos** por inatividade. O freelancer pode ficar inativo e retornar sem perder sua progressão |
| **Impacto** | Evita frustrações por ausência temporária da plataforma |
| **UC Relacionado** | UC-09 |

---

### RN-056 — Ranking local por categoria

| Campo | Detalhe |
|---|---|
| **Categoria** | Gamificação |
| **Descrição** | O ranking exibe os **top 10 freelancers** por categoria dentro de um raio de 50km. O critério de ordenação é: **(1) nota média → (2) total de serviços concluídos → (3) XP total** |
| **Impacto** | Incentiva a manutenção de alta qualidade para permanecer no ranking |
| **UC Relacionado** | UC-09 |

---

### RN-057 — XP não é transferível nem comercializável

| Campo | Detalhe |
|---|---|
| **Categoria** | Gamificação |
| **Descrição** | XP e badges são **intransferíveis** entre contas e não possuem valor monetário. Qualquer tentativa de comercialização resulta em banimento |
| **Impacto** | Mantém a integridade do sistema de reputação |
| **UC Relacionado** | UC-09 |

---

### RN-058 — Badge de destaque no perfil

| Campo | Detalhe |
|---|---|
| **Categoria** | Gamificação |
| **Descrição** | O freelancer pode escolher **até 3 badges** para exibir em destaque no perfil público. As demais ficam visíveis na aba "Conquistas" |
| **Impacto** | Personalização do perfil com as conquistas mais relevantes |
| **UC Relacionado** | UC-02, UC-09 |

---

### RN-059 — XP não gerado por autoavaliação ou contrato cancelado

| Campo | Detalhe |
|---|---|
| **Categoria** | Gamificação |
| **Descrição** | XP **não é atribuído** por: contratos cancelados, avaliações de contas suspeitas, missões com progresso fraudulento detectado |
| **Impacto** | Previne exploração do sistema de gamificação |
| **UC Relacionado** | UC-09 |

---

### RN-060 — Notificação de subida de nível

| Campo | Detalhe |
|---|---|
| **Categoria** | Gamificação |
| **Descrição** | Ao subir de nível, o freelancer recebe **push notification, notificação in-app e badge temporária de "Novo Nível"** no perfil por 7 dias |
| **Impacto** | Celebra a conquista e gera engajamento |
| **UC Relacionado** | UC-09 |

---

## 8. RN-61 a RN-65 — Suporte e Disputas

---

### RN-061 — SLA de atendimento de tickets

| Campo | Detalhe |
|---|---|
| **Categoria** | Suporte |
| **Descrição** | Tickets devem receber primeira resposta dentro de: **Crítico** → 2h / **Alto** → 8h / **Médio** → 24h / **Baixo** → 72h. Tickets sem resposta no prazo geram alerta interno |
| **Impacto** | Garante qualidade no atendimento e rastreabilidade |
| **UC Relacionado** | UC-10 |

---

### RN-062 — Disputa só após tentativa de resolução direta

| Campo | Detalhe |
|---|---|
| **Categoria** | Disputas |
| **Descrição** | Um ticket de disputa financeira só pode ser aberto após **48h do registro da entrega sem resolução** entre as partes via chat |
| **Impacto** | Incentiva resolução direta antes da intervenção administrativa |
| **UC Relacionado** | UC-10 |
| **Situação** | Não implementada (revista no ADR 57): hoje a disputa manual pode ser aberta a qualquer momento em `accepted`, `in_progress`, `delivered` e `revision_requested`, sem espera de 48 h |

---

### RN-063 — Resolução administrativa vinculante

| Campo | Detalhe |
|---|---|
| **Categoria** | Disputas |
| **Descrição** | A decisão do administrador em uma disputa é **final e vinculante** para ambas as partes, conforme aceite nos Termos de Uso no momento do cadastro |
| **Impacto** | Garante resolução definitiva; evita impasse |
| **UC Relacionado** | UC-10, UC-11 |
| **Situação** | Implementada. A divisão vai de 1% a 99% e precisa dar algo aos dois lados (ADR 60): tudo de um lado é liberar ou devolver |

---

### RN-064 — Limite de tickets simultâneos por usuário

| Campo | Detalhe |
|---|---|
| **Categoria** | Suporte |
| **Descrição** | Cada usuário pode ter **até 3 tickets abertos simultaneamente**. Novos tickets só podem ser abertos após o fechamento de um dos existentes |
| **Impacto** | Previne abuso do sistema de suporte |
| **UC Relacionado** | UC-10 |

---

### RN-065 — Encerramento automático de ticket resolvido

| Campo | Detalhe |
|---|---|
| **Categoria** | Suporte |
| **Descrição** | Tickets marcados como "Resolvido" são automaticamente **encerrados após 5 dias** sem nova manifestação do usuário |
| **Impacto** | Mantém a fila de suporte organizada |
| **UC Relacionado** | UC-10 |

---

## 8.1 RN-66 a RN-70 — Troca, Pacotes e Confiança

---

### RN-066 — Equivalência e torna na troca

| Campo | Detalhe |
|---|---|
| **Categoria** | Troca |
| **Descrição** | Em uma troca de serviços, o sistema estima o valor de cada lado. Quando os valores não são equivalentes, a diferença (**torna**) é paga em dinheiro por quem recebe o serviço mais valioso: é **reservada da carteira** (ao propor, se o proponente paga; ao aceitar, se é o receptor) e liberada ao outro lado quando os dois contratos são aprovados. A comissão de **15%** incide **sobre a torna** e é descontada de quem a recebe; troca equilibrada não tem taxa. Recusa, cancelamento ou disputa devolvem a reserva |
| **Impacto** | Garante remuneração justa e receita da plataforma mesmo em transações sem dinheiro integral |
| **UC Relacionado** | UC-06 |

---

### RN-067 — Aceite bilateral e contratos recíprocos

| Campo | Detalhe |
|---|---|
| **Categoria** | Troca |
| **Descrição** | Uma troca só se efetiva com **aceite explícito das duas partes**. Ao ser aceita, o sistema gera **dois contratos recíprocos vinculados**, cada um percorrendo o fluxo normal (execução, entrega, aprovação). O cancelamento de um lado abre disputa sobre a troca inteira |
| **Impacto** | Mantém a rastreabilidade e a segurança do escrow nas duas pontas da troca |
| **UC Relacionado** | UC-05, UC-06 |

---

### RN-068 — Pacotes por serviço

| Campo | Detalhe |
|---|---|
| **Categoria** | Serviços |
| **Descrição** | Cada serviço pode ter **no máximo 3 pacotes** (basic, standard, premium). O preço de qualquer pacote respeita o **mínimo de R$ 10,00** (RN-016). O cliente contrata um pacote específico |
| **Impacto** | Padroniza ofertas em níveis e dá clareza de escopo/preço ao cliente |
| **UC Relacionado** | UC-03, UC-04 |

---

### RN-069 — Escrow por marco (milestones)

| Campo | Detalhe |
|---|---|
| **Categoria** | Pagamentos |
| **Descrição** | Contratos divididos em marcos têm **cada marco financiado e liberado individualmente**. A soma dos marcos deve ser igual ao valor total do contrato. A aprovação de um marco libera apenas o valor daquele marco. Vale em dinheiro e em créditos Escambo (marcos inteiros, sem taxa). Cada marco pode ter o próprio prazo (opcional; no futuro, em ordem e nunca depois do prazo da contratação): marco em escrow com prazo vencido avisa as duas partes uma vez — a mediação automática continua sendo pelo prazo da contratação (RN-029). Marco entregue conta como entrega para a RN-029 mesmo que volte para revisão. O aviso de marco atrasado vale só para marco nunca entregue, a partir das 9h no fuso de quem entrega. A tácita de cada marco tem hora gravada na entrega do marco (RN-024); o lembrete e o aviso da tácita juntam os marcos da mesma contratação (RN-079), e a revisão parada vale por marco (RN-081). Não se cancela com marco entregue em aberto, esperando o cliente ou em revisão (RN-025) |
| **Impacto** | Reduz o risco das duas partes em projetos longos e de maior valor |
| **UC Relacionado** | UC-06 |
| **Situação** | Implementada (prazos, tácita e cancelamento por marco revistos no ADR 57; lembretes e avisos no ADR 58) |

---

### RN-070 — Denúncias e ação cautelar

| Campo | Detalhe |
|---|---|
| **Categoria** | Moderação |
| **Descrição** | Qualquer usuário pode denunciar conteúdo ou perfil. Denúncias por **fraude ou ilegalidade** entram em revisão prioritária; conteúdo com **múltiplas denúncias procedentes** pode ser **pausado cautelarmente** até análise da equipe |
| **Impacto** | Protege a comunidade e a reputação da plataforma (trust & safety) |
| **UC Relacionado** | UC-10, UC-11 |

---

## 9. RN-71 a RN-81 — Conformidade, LGPD, avisos e prazos

---

### RN-071 — Consentimento explícito no cadastro

| Campo | Detalhe |
|---|---|
| **Categoria** | LGPD |
| **Descrição** | O cadastro exige aceite **explícito e separado** dos: Termos de Uso, Política de Privacidade e autorização de tratamento de dados pessoais. Checkboxes pré-marcados não são permitidos |
| **Impacto** | Conformidade com Art. 7º, I e Art. 8º da LGPD |
| **UC Relacionado** | UC-01 |

---

### RN-072 — Direito ao esquecimento

| Campo | Detalhe |
|---|---|
| **Categoria** | LGPD |
| **Descrição** | O usuário pode solicitar a exclusão de seus dados pessoais a qualquer momento. O prazo para processamento é de **15 dias úteis**. Dados financeiros e de auditoria são retidos pelo prazo legal mínimo exigido (5 anos) |
| **Impacto** | Conformidade com Art. 18º, VI da LGPD |
| **UC Relacionado** | UC-11 |

---

### RN-073 — Anonimização de dados inativos

| Campo | Detalhe |
|---|---|
| **Categoria** | LGPD |
| **Descrição** | Contas inativas por **24 meses** têm dados pessoais identificáveis anonimizados automaticamente, mantendo apenas dados estatísticos necessários para relatórios |
| **Impacto** | Minimização de dados conforme Art. 6º, III da LGPD |
| **UC Relacionado** | UC-11 |

---

### RN-074 — Dados mínimos no cadastro

| Campo | Detalhe |
|---|---|
| **Categoria** | LGPD |
| **Descrição** | O cadastro coleta apenas os dados **estritamente necessários** para o funcionamento: e-mail, senha e tipo de perfil. Demais dados (CPF, telefone, endereço) são coletados apenas quando necessários para funcionalidades específicas |
| **Impacto** | Princípio da minimização de dados (Art. 6º, III da LGPD) |
| **UC Relacionado** | UC-01 |

---

### RN-075 — Criptografia de dados sensíveis

| Campo | Detalhe |
|---|---|
| **Categoria** | Segurança |
| **Descrição** | CPF, dados bancários e chaves PIX são armazenados com **criptografia AES-256**. Senhas são armazenadas com **bcrypt (salt rounds = 12)**. Nenhum dado sensível é armazenado em texto plano |
| **Impacto** | Conformidade com Art. 46º da LGPD e OWASP Top 10 |
| **UC Relacionado** | UC-01, UC-06 |

---

### RN-076 — Comunicação de alteração dos documentos legais

| Campo | Detalhe |
|---|---|
| **Categoria** | LGPD |
| **Descrição** | Quando a Política de Privacidade ou os Termos de Uso mudam, quem ainda não respondeu à versão vigente vê, ao entrar, uma **faixa com destaque** que resume o que mudou desde a versão que respondeu e leva ao texto completo. A resposta é registrada por versão, no mesmo consentimento do cadastro, e encerra a faixa em todos os aparelhos; se o registro falhar, a faixa volta na próxima vez. Na Política, a faixa pede **aceitar ou não aceitar** (art. 8 §6, art. 9). Nos Termos (desde a 1.3), a faixa é **informativa**: não há "Não aceito", porque a seção 7 diz que o uso continuado vale como aceite, e quem não concorda pode pedir a exclusão da conta no Perfil. Uma faixa por vez: a da Política vem antes da dos Termos |
| **Impacto** | Ninguém segue sob um documento que mudou sem ter sido avisado, e cada resposta fica registrada com a versão |
| **UC Relacionado** | UC-01 |
| **Situação** | Implementada: Política (ADR 54) e Termos de Uso 1.4 (ADR 58) |

---

### RN-077 — O que sai durante o "não perturbe"

| Campo | Detalhe |
|---|---|
| **Categoria** | Notificações |
| **Descrição** | Durante a janela de silêncio da conta, nenhum aviso no navegador sai, exceto o aviso de teste e as categorias que a própria pessoa marcou, dentro de uma lista fechada mantida pela plataforma. Hoje a lista tem uma categoria, "Prazo vencido num trabalho que você entrega": o aviso de prazo estourado a quem entrega (RN-029). A extensão recusada e a revisão pedida saíram da lista no ADR 57: depois de uma recusa ou expiração sobram sempre pelo menos 6 horas de dia até a disputa (RN-028), e depois da entrega não há carência (RN-029). Quem nunca escolheu não tem nada saindo; ao ligar o silêncio, quem entrega trabalho vê a opção marcada. O que não sai fica para o aviso do fim do silêncio, com os de prazo primeiro (os que podem nascer com menos de 24 horas para agir, inclusive os lembretes da RN-079, que nunca saem no silêncio). Uma categoria só entra se a espera tira de quem recebe algo que não volta e se ele consegue agir |
| **Impacto** | Quem entrega não perde horas da carência dormindo, e ninguém é acordado pelo que não escolheu |
| **UC Relacionado** | UC-02, UC-05 |
| **Situação** | Implementada (ADR 56, estreitada pelo ADR 57) |

---

### RN-078 — Prazos de dia

| Campo | Detalhe |
|---|---|
| **Categoria** | Contratações |
| **Descrição** | Todo prazo que tira um direito sobre dinheiro ou sobre a contratação tem a hora gravada quando a contagem começa, e ela nunca cai entre 20h30 e 9h no fuso de quem é afetado (passa para as 9h). Nenhum job age sobre prazo com esse fuso de noite (entre 21h e 9h). A hora vale como foi dita: mudar o painel vale para o que começar depois. Hoje, os instantes gravados são quatro: a validade da proposta (RN-021, fuso do freelancer), a aprovação tácita da entrega e de cada marco (RN-024, fuso do cliente), a resposta a um pedido de extensão (RN-028, fuso do cliente) e o fim da carência do prazo (RN-029, fuso de quem entrega). A outra parte, que não sofre a sanção, pode receber a cópia de um aviso fora do dia dela (das 6h à meia-noite). A janela de avaliação (RN-043) é contada em dias corridos e não entra. O fuso do prazo (RN-080) só diz o dia. As contratações que já estavam em andamento recebem essas horas pelo job `repair-deadlines`, com as mesmas contas da API |
| **Impacto** | Nenhuma sanção por prazo cai de madrugada, e a hora avisada é a hora cumprida |
| **UC Relacionado** | UC-05 |
| **Situação** | Implementada |
| **Origem** | ADR 57 |

---

### RN-079 — Lembrete antes do vencimento

| Campo | Detalhe |
|---|---|
| **Categoria** | Notificações |
| **Descrição** | O lembrete é um **aviso a mais**: sai no máximo uma vez por vencimento, a partir das 9h no fuso atual de quem recebe, e não suspende, não adia nem condiciona nenhuma hora; vale a hora dita no aviso que abriu a contagem, e a Sala sempre a mostra. São quatro: o **prazo de entrega** (a quem entrega, enquanto há trabalho nunca entregue e nenhum pedido de extensão esperando resposta), a **validade da proposta** (ao freelancer; propostas de troca não expiram e não têm lembrete), a **aprovação automática** da entrega e dos marcos (ao cliente; os marcos da mesma contratação que chegam à hora na mesma rodada vão num aviso só) e a **resposta a um pedido de extensão** (ao cliente, um lembrete por pedido). Em geral sai às 9h da véspera (as 9h mais recentes com pelo menos 24 horas pela frente); se a contagem começou há menos de 12 horas, às 9h do próprio dia, desde que sobrem 2 h 30; senão, não sai. Só de dia e com pelo menos 2 horas até o vencimento. Um vencimento novo (extensão aceita, nova entrega, novo pedido) ganha lembrete novo. Nenhum lembrete sai durante o "não perturbe" (RN-077). A linha no app sai uma vez; e-mail e push, no máximo uma vez. Não têm lembrete: o fim da carência (o aviso de atraso já é o lembrete e diz a hora), o prazo de um marco (o atraso do marco não tem sanção) e a janela de avaliação (o aviso da conclusão automática já diz até quando avaliar) |
| **Impacto** | Ninguém perde dinheiro nem a contratação por um vencimento de que não se lembrou, e ninguém recebe mais de um lembrete pelo mesmo vencimento |
| **UC Relacionado** | UC-05, UC-06 |
| **Situação** | Implementada |
| **Origem** | ADR 58 |

---

### RN-080 — Data de entrega no horário de quem entrega

| Campo | Detalhe |
|---|---|
| **Categoria** | Contratações |
| **Descrição** | O prazo de entrega, e o de cada marco, é uma **data** e vale até 23:59 dela no fuso de quem entrega. As duas partes leem o mesmo dia, com "(horário de X)" quando quem lê está em outro relógio; as horas em que cada um age (aviso, disputa, resposta, aprovação) aparecem no fuso de quem lê. O dia mínimo é amanhã no fuso de quem entrega, e a extensão escolhe um dia no fuso do prazo. A API continua recebendo um instante; o fuso do prazo é o relógio em que esse instante é 23:59 (preferindo o de quem entrega e depois o do cliente), o que preserva o dia escolhido também nas contratações anteriores. Ele só diz o dia: os jobs agem no fuso atual de cada pessoa (RN-078). Quando o instante não é 23:59 em fuso nenhum (contratações antigas, chamadas diretas à API), o app mostra a hora real |
| **Impacto** | Cliente e freelancer em fusos diferentes combinam o mesmo dia, e o prazo não vira outra hora para quem entrega |
| **UC Relacionado** | UC-05 |
| **Situação** | Implementada |
| **Origem** | ADR 58 |

---

### RN-081 — Aviso de revisão parada

| Campo | Detalhe |
|---|---|
| **Categoria** | Contratações |
| **Descrição** | Uma revisão pedida não termina sozinha. Se ficar **7 dias** (valor fixo no código) sem nova entrega, as duas partes são avisadas, uma vez por pedido de revisão, na primeira rodada em que é dia para as duas; vale para a entrega única e para cada marco. Não há sanção: o desfecho continua sendo nova entrega, acordo pelo chat ou disputa, que qualquer das partes pode abrir. A Sala mostra às duas partes desde quando a revisão está pedida |
| **Impacto** | Uma revisão esquecida não deixa o dinheiro parado em garantia sem que ninguém perceba |
| **UC Relacionado** | UC-05 |
| **Situação** | Implementada |
| **Origem** | ADR 58 |

---

## 10. Tabela Consolidada

| ID | Categoria | Descrição Resumida | UC |
|---|---|---|---|
| RN-001 | Autenticação | E-mail único por conta | UC-01 |
| RN-002 | Segurança | Bloqueio após 5 tentativas de login | UC-01 |
| RN-003 | Segurança | JWT expira em 1h; refresh em 7 dias | UC-01 |
| RN-004 | Autenticação | E-mail não verificado tem acesso restrito | UC-01 |
| RN-005 | Segurança | Token de recuperação de senha descartável | UC-01 |
| RN-006 | Perfis | Um perfil por tipo por conta | UC-02 |
| RN-007 | Moderação | Suspensão e banimento apenas por admin | UC-11 |
| RN-008 | Segurança | Troca de senha encerra todas as sessões | UC-01 |
| RN-009 | Conformidade | Financeiro restrito a maiores de 18 anos | UC-01 |
| RN-010 | Segurança | Audit log de todas as ações críticas | UC-01, UC-06 |
| RN-011 | Perfis | Perfil incompleto não aparece na busca | UC-02 |
| RN-012 | Perfis | Portfólio limitado a 20 itens (gratuito) | UC-02 |
| RN-013 | Serviços | Serviço inativo não aceita propostas | UC-03 |
| RN-014 | Serviços | Freelancer indisponível oculta botão contratar | UC-03 |
| RN-015 | Serviços | Máximo 5 serviços ativos (gratuito) | UC-03 |
| RN-016 | Serviços | Preço mínimo R$ 10,00 | UC-03 |
| RN-017 | Impulsionamento | Um impulsionamento ativo por vez | UC-03 |
| RN-018 | Serviços | Máximo 10 tags por serviço | UC-03 |
| RN-019 | Busca | Ranqueamento: boost → nota → proximidade | UC-04 |
| RN-020 | Contratações | Proposta única por par ativo | UC-04 |
| RN-021 | Contratações | Proposta vale 72h (ou até o prazo de entrega), com hora gravada de dia; vencida não se aceita | UC-05 |
| RN-022 | Contratações | Histórico de status imutável | UC-05 |
| RN-023 | Contratações | Máximo 2 revisões gratuitas | UC-05 |
| RN-024 | Contratações | Aprovação tácita em 5 dias corridos, hora gravada na entrega | UC-05 |
| RN-025 | Cancelamentos | Reembolso pela etapa, com o valor na tela antes de confirmar; atraso sem entrega devolve tudo | UC-05 |
| RN-026 | Contratações | 3 cancelamentos em 60 dias gera alerta | UC-05 |
| RN-027 | Contratações | Contratação mínima R$ 10,00 | UC-04 |
| RN-028 | Contratações | Até 2 pedidos de extensão, 1 aceito, só com trabalho nunca entregue; sem resposta, expira | UC-05 |
| RN-029 | Disputas | Prazo vencido sem entrega: aviso a partir das 9h, carência gravada e disputa automática | UC-05 |
| RN-030 | Contratações | Máximo 3 rodadas de contra-proposta | UC-05 |
| RN-031 | Pagamentos | Taxa da plataforma: 15% | UC-06 |
| RN-032 | Pagamentos | Escrow obrigatório antes do início | UC-06 |
| RN-033 | Pagamentos | Liberação imediata após conclusão | UC-06 |
| RN-034 | Carteira | Saque mínimo R$ 20,00 | UC-06 |
| RN-035 | Carteira | PIX: D+1 / TED: D+2 | UC-06 |
| RN-036 | Pagamentos | Reembolso no método original | UC-06 |
| RN-037 | Pagamentos | 3 tentativas automáticas em falha | UC-06 |
| RN-038 | Disputas | Saldo bloqueado durante disputa | UC-06 |
| RN-039 | Pagamentos | Taxa dividida na proporção do reembolso | UC-05, UC-06 |
| RN-040 | Auditoria | Histórico financeiro imutável | UC-06 |
| RN-041 | Avaliações | Avaliação vinculada a contrato concluído | UC-07 |
| RN-042 | Avaliações | Uma avaliação por contrato, sem edição | UC-07 |
| RN-043 | Avaliações | Prazo de 7 dias para avaliar | UC-07 |
| RN-044 | Reputação | Nota média calculada em tempo real | UC-07 |
| RN-045 | Reputação | Nota < 2,0 após 10+ avaliações pausa serviços | UC-07 |
| RN-046 | Avaliações | Uma resposta por avaliação, sem edição | UC-07 |
| RN-047 | Moderação | Conteúdo ofensivo vai para moderação | UC-07 |
| RN-048 | Avaliações | Ausência de avaliação não bloqueia saque | UC-06, UC-07 |
| RN-049 | Reputação | Exibe 20 avaliações mais recentes | UC-02 |
| RN-050 | Reputação | Badge "Avaliação Verificada" em todas | UC-07 |
| RN-051 | Gamificação | Tabela de XP por ação | UC-09 |
| RN-052 | Gamificação | 6 níveis de progressão | UC-09 |
| RN-053 | Gamificação | Badges automáticas e imutáveis | UC-09 |
| RN-054 | Gamificação | Missões com prazo fixo | UC-09 |
| RN-055 | Gamificação | XP nunca é perdido | UC-09 |
| RN-056 | Gamificação | Ranking top 10 em 50km | UC-09 |
| RN-057 | Gamificação | XP intransferível e não comercializável | UC-09 |
| RN-058 | Gamificação | 3 badges em destaque no perfil | UC-02, UC-09 |
| RN-059 | Gamificação | XP não gerado por contratos cancelados | UC-09 |
| RN-060 | Gamificação | Notificação ao subir de nível | UC-09 |
| RN-061 | Suporte | SLA por prioridade de ticket | UC-10 |
| RN-062 | Disputas | Disputa só após 48h sem resolução direta | UC-10 |
| RN-063 | Disputas | Resolução administrativa vinculante | UC-10 |
| RN-064 | Suporte | Máximo 3 tickets simultâneos | UC-10 |
| RN-065 | Suporte | Ticket resolvido encerra em 5 dias | UC-10 |
| RN-066 | Troca | Equivalência e torna reservada na carteira; comissão de 15% sobre a torna | UC-06 |
| RN-067 | Troca | Aceite bilateral gera contratos recíprocos | UC-05, UC-06 |
| RN-068 | Serviços | Máximo 3 pacotes por serviço (basic/standard/premium) | UC-03, UC-04 |
| RN-069 | Pagamentos | Escrow por marco (milestones) | UC-06 |
| RN-070 | Moderação | Denúncias e ação cautelar | UC-10, UC-11 |
| RN-071 | LGPD | Consentimento explícito no cadastro | UC-01 |
| RN-072 | LGPD | Direito ao esquecimento em 15 dias úteis | UC-11 |
| RN-073 | LGPD | Anonimização após 24 meses inativo | UC-11 |
| RN-074 | LGPD | Coleta de dados mínimos | UC-01 |
| RN-075 | Segurança | CPF e senha criptografados | UC-01, UC-06 |
| RN-076 | LGPD | Comunicação de alteração da Política de Privacidade e dos Termos de Uso: faixa com destaque ao entrar, resposta registrada por versão; a Política pede aceitar/não aceitar (art. 8 §6, art. 9), a dos Termos é informativa (uso continuado vale como aceite) | UC-01 |
| RN-077 | Notificações | O que sai durante o "não perturbe": lista fechada da plataforma, escolha da pessoa (hoje, o aviso de prazo estourado a quem entrega) | UC-02, UC-05 |
| RN-078 | Contratações | Prazos de dia: hora gravada, nunca entre 20h30 e 9h no fuso de quem é afetado; nenhum job age de noite | UC-05 |
| RN-079 | Notificações | Lembrete antes do vencimento: no máximo um, a partir das 9h no fuso de quem recebe, em geral na véspera; não muda nenhuma hora | UC-05, UC-06 |
| RN-080 | Contratações | O prazo de entrega é uma data, até 23:59 no fuso de quem entrega, o mesmo dia para as duas partes | UC-05 |
| RN-081 | Contratações | Revisão sem nova entrega há 7 dias: aviso às duas partes, uma vez, sem sanção | UC-05 |

---

## 11. Matriz de situação (ADR 60)

Regras revistas contra o código na v1.39.0 (ADR 57), na v1.41.0 (ADR 58) e na v1.41.1 (ADR 60). Os arquivos da API ficam em `apps/api/src/` (as contratações em `modules/contracts/`), e os do web em `apps/web/src/features/`.

| RN | Situação | Onde | ADR |
|---|---|---|---|
| RN-007 | Parcial | `modules/admin/admin.service.ts` (`moderateUser`), `middlewares/authenticate.ts` (a suspensão bloqueia como o banimento) | 60 |
| RN-013 | Implementada | `contracts.service.ts` (criação: serviço do freelancer e no ar), `modules/barter/barter.service.ts` (proposta de troca) | 60 |
| RN-016 | Implementada; corrigida na edição | `modules/services/services.service.ts` (`update`) | 60 |
| RN-017 | Implementada | `modules/boosts/boosts.repository.ts` (`purchase`, com a trava da carteira de quem compra) | 60 |
| RN-021 | Implementada | `contracts.service.ts` (criação e aceite da proposta), `jobs/expire-proposals.ts` | 57, 58 |
| RN-023 | Não implementada | Nenhum limite de revisões; a revisão não abre disputa automática | 57 |
| RN-024 | Implementada; "dias úteis" corrigido para dias corridos | `contracts.service.ts` (entrega e marco), `jobs/tacit-approval.ts`, `approval-notices.ts` | 57, 58 |
| RN-025 | Implementada | `cancel-policy.ts` (`cancelTerms`), `contracts.service.ts` (cancelamento), `contracts/CancelModal.tsx` | 57 |
| RN-026 | Parcial | Desistência em `cancel-policy.ts` e aviso `contract_cancelled` em `deadline-notices.ts`; histórico público e alerta pendentes | 57 |
| RN-028 | Implementada | `deadline-grace.ts`, `contracts.service.ts` (pedido e decisão), `jobs/overdue-contracts.ts` (expiração) | 57, 58 |
| RN-029 | Implementada | `deadline-sql.ts` (`rn029Eligible`), `deadline-grace.ts`, `jobs/overdue-contracts.ts` | 57, 58 |
| RN-043 | Implementada | `modules/reviews/reviews.service.ts` (`REVIEW_WINDOW_DAYS`, relógio da plataforma) | 58 |
| RN-039 | Corrigida no texto | `cancel-policy.ts` (`cashSettlement`), `modules/admin/admin.service.ts` (decisão de disputa) | 15, 57 |
| RN-063 | Implementada | `modules/admin/admin.schema.ts` (divisão de 1% a 99%), `admin.service.ts` | 60 |
| RN-062 | Não implementada | `modules/disputes/disputes.repository.ts` (status em que a disputa abre) | 57 |
| RN-069 | Implementada | `deadline-sql.ts`, `jobs/overdue-contracts.ts` (marco atrasado), `jobs/tacit-approval.ts` (marcos agrupados) | 57, 58 |
| RN-076 | Implementada | `shell/LegalUpdateBanner.tsx`, `shell/banners.ts`, `legal/content.ts` | 54, 57, 58 |
| RN-077 | Implementada | `modules/notifications/push.service.ts`, `deadline-notices.ts`, `notifications/deadline-types.ts` | 56, 57, 58 |
| RN-078 | Implementada | `utils/human-hours.ts`, `jobs/repair-deadlines.ts`, migrations 0027 e 0028 | 57 |
| RN-079 | Implementada | `reminders-sql.ts`, `reminders.repository.ts`, `deadline-reminders.service.ts`, `reminder-notices.ts`, `jobs/deadline-reminders.ts`, `utils/human-hours.ts` (`reminderSlot`), migration 0029 | 58 |
| RN-080 | Implementada | `utils/timezone.ts` (`inferDeadlineZone`, `formatDeadline`), `contract-zones.ts`; no web, `lib/deadline.ts`, `services/ContratarModal.tsx`, `contracts/DeadlineSection.tsx` | 58 |
| RN-081 | Implementada | `deadline-reminders.service.ts` (revisão parada), `jobs/repair-deadlines.ts` (passos 9 e 10), migrations 0029 e 0030; no web, `contracts/DeadlineSection.tsx` e `MilestonesSection.tsx` | 58 |

---

<div align="center">

*regras-de-negocio.md — Escambo v1.1.0 — NP2 — PAC Extensionista VII — Católica SC — 2026*

</div>
