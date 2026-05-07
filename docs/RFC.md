# RFC-001 — Escambo: Plataforma Digital de Serviços Freelance

> **RFC — Request for Comments**  
> **Versão:** 1.0.0  
> **Status:** 🟡 Em Revisão  
> **Disciplina:** PAC Extensionista VII — Católica SC  
> **Data:** Abril de 2026  
> **Autor:** [Seu Nome]  
> **Repositório:** [github.com/seu-usuario/escambo](https://github.com/Guirenzo/escambo)

---

## Histórico de Revisões

| Versão | Data | Autor | Descrição |
|---|---|---|---|
| 0.1.0 | Mar/2026 | [Seu Nome] | Rascunho inicial — contexto e problema |
| 0.2.0 | Abr/2026 | [Seu Nome] | Adição de objetivos, diferenciais e público-alvo |
| 1.0.0 | Abr/2026 | [Seu Nome] | Versão completa para entrega NP1 |

---

## Índice

1. [Abstract](#1-abstract)
2. [Contexto e Definição do Problema](#2-contexto-e-definição-do-problema)
3. [Objetivos do Projeto](#3-objetivos-do-projeto)
4. [Proposta de Valor e Diferenciais](#4-proposta-de-valor-e-diferenciais)
5. [Público-Alvo](#5-público-alvo)
6. [Escopo do MVP](#6-escopo-do-mvp)
7. [Arquitetura e Stack Técnica](#7-arquitetura-e-stack-técnica)
8. [Modelagem de Dados](#8-modelagem-de-dados)
9. [Requisitos Funcionais](#9-requisitos-funcionais)
10. [Requisitos Não Funcionais](#10-requisitos-não-funcionais)
11. [Riscos e Mitigações](#11-riscos-e-mitigações)
12. [Indicadores de Sucesso](#12-indicadores-de-sucesso)
13. [Extensão Universitária e Impacto Social](#13-extensão-universitária-e-impacto-social)
14. [Considerações Finais](#14-considerações-finais)
15. [Referências](#15-referências)

---

## 1. Abstract

O **Escambo** é uma plataforma digital de marketplace de serviços que conecta freelancers e clientes de forma rápida, transparente e confiável. A solução endereça uma lacuna identificada no mercado brasileiro: a ausência de um produto que combine a simplicidade de uso de apps como o iFood, a confiabilidade de sistemas de avaliação como o da App Store e as ferramentas de gestão profissional de plataformas como o LinkedIn — tudo em um único ambiente voltado a serviços locais e remotos de qualquer nicho.

O projeto é desenvolvido como plataforma Web e Mobile (React + React Native + Expo), com backend em Node.js/TypeScript e banco de dados MySQL, hospedado em infraestrutura DigitalOcean com Cloudflare e integração ao gateway de pagamentos MercadoPago. O MVP prevê 14 módulos funcionais, cobrindo 72 Requisitos Funcionais, 36 Requisitos Não Funcionais e um banco de dados com 45+ tabelas.

> **Palavras-chave:** marketplace de serviços, freelance, plataforma digital, gamificação, uberização, Brasil

---

## 2. Contexto e Definição do Problema

### 2.1 Contexto

O mercado de serviços freelance no Brasil cresce de forma acelerada, impulsionado pela digitalização da economia e pelo aumento da demanda por profissionais autônomos em áreas que vão desde reparos domésticos até desenvolvimento de software. Segundo dados do IBGE (2023), o país conta com mais de **24 milhões de trabalhadores autônomos**, número que cresce consistentemente ano a ano.

Contudo, a conexão entre quem precisa de um serviço e quem o oferece ainda é marcada por ineficiências estruturais: falta de transparência, ausência de um ambiente centralizado e confiável, e experiências de uso fragmentadas. Clientes recorrem a grupos de WhatsApp, Facebook, OLX ou plataformas genéricas como GetNinjas e Workana — cada uma com limitações próprias.

Freelancers, por sua vez, operam de forma dispersa: utilizam múltiplas ferramentas para comunicação, controle financeiro, exposição de portfólio e gestão de agenda — sem integração entre elas, sem dashboards e sem mecanismos que os ajudem a construir reputação digital de forma sistemática.

### 2.2 Problema Central

> **Para clientes:** processos lentos, falta de confiança e dificuldade para encontrar profissionais qualificados e próximos.
>
> **Para freelancers:** dificuldade de divulgação, ausência de ferramentas integradas para gestão de finanças, agenda e reputação, e dependência de redes sociais genéricas para captação de clientes.

### 2.3 Problemas Específicos Identificados

A análise do contexto e benchmarking com plataformas existentes revelou os seguintes desafios estruturais:

| # | Problema | Impacto |
|---|---|---|
| P01 | **Dilema ovo ou galinha** — sem freelancers, clientes não entram; sem clientes, freelancers não se cadastram | Crítico — inviabiliza o arranque da plataforma |
| P02 | **Garantia de qualidade dos profissionais** — má experiência inicial afasta clientes definitivamente | Alto |
| P03 | **Retenção na plataforma** — tendência de negociar "por fora" após o primeiro contato para evitar taxas | Alto |
| P04 | **Escalabilidade técnica** — plataforma robusta com múltiplos acessos simultâneos | Alto |
| P05 | **Gestão de suporte e disputas** — política de mediação clara entre partes em caso de insatisfação | Médio |
| P06 | **Competição com gigantes e alternativas informais** | Médio |
| P07 | **Engajamento recorrente** — evitar uso pontual e criar mecanismos de fidelização | Médio |
| P08 | **Monetização equilibrada** — modelos que não afastem nem freelancers nem clientes | Alto |
| P09 | **Combate a fraudes e perfis falsos** — verificação robusta de identidade | Alto |
| P10 | **Conformidade jurídica e fiscal** — LGPD, impostos e regulamentações na escala | Médio |

### 2.4 Análise Competitiva

| Plataforma | Pontos Fortes | Limitações |
|---|---|---|
| GetNinjas | Popularidade, multi-nicho | UX datada, sem gamificação, comissões altas |
| Workana | Foco em tech/criativo | Não é local, interface complexa, sem mobile nativo |
| OLX | Grande base de usuários | Não é especializada em serviços, sem garantias |
| WhatsApp/Grupos | Familiaridade, zero atrito | Sem reputação, sem pagamento, sem histórico |
| **Escambo** | UX simplificada, gamificação, local + remoto, dashboard, pagamento integrado | MVP em desenvolvimento |

---

## 3. Objetivos do Projeto

### 3.1 Objetivo Geral

> **Missão:** Tornar a contratação de serviços mais acessível, rápida e confiável, conectando freelancers e clientes com poucos toques, sem burocracia e com total transparência.

### 3.2 Objetivos Específicos

Para o MVP, o Escambo busca atingir os seguintes objetivos mensuráveis:

- **OBJ-01** — Criar uma plataforma Web e Mobile onde clientes encontrem e contratem freelancers em minutos
- **OBJ-02** — Implementar sistema de avaliações por estrelas e comentários para construção de reputação profissional
- **OBJ-03** — Disponibilizar chat integrado para comunicação direta entre as partes dentro do app
- **OBJ-04** — Desenvolver perfis completos com fotos, portfólio, histórico de serviços e localização geográfica
- **OBJ-05** — Criar painel (dashboard) para o freelancer acompanhar ganhos, avaliações e desempenho
- **OBJ-06** — Implementar sistema de gamificação (XP, níveis, badges, missões) para engajamento e retenção
- **OBJ-07** — Estruturar o sistema de pagamentos via MercadoPago com carteira digital e saques programados
- **OBJ-08** — Garantir conformidade com a LGPD desde o lançamento

### 3.3 Visão de Longo Prazo

> Ser a maior e mais confiável plataforma digital de serviços do Brasil, referência em praticidade, inovação e geração de renda para freelancers de todos os nichos.

---

## 4. Proposta de Valor e Diferenciais

### 4.1 Proposta de Valor

**Para clientes:** encontrar e contratar um profissional qualificado, próximo e avaliado em menos de 5 minutos, com pagamento seguro e comunicação centralizada.

**Para freelancers:** uma plataforma completa que centraliza agenda, finanças, reputação e novos clientes — com ferramentas de crescimento profissional integradas.

### 4.2 Diferenciais Competitivos

| Diferencial | Descrição |
|---|---|
| 📱 Interface estilo iFood | UX intuitiva, contratação com poucos toques, sem burocracia |
| ⭐ Avaliações verificadas | Sistema de estrelas com comentários reais e vinculados à contratação |
| 💬 Chat integrado | Comunicação direta e organizada entre cliente e freelancer no app |
| 🎮 Gamificação | XP, níveis, badges e missões para engajamento contínuo |
| 📊 Dashboard do Freelancer | Painel com ganhos, nota média, serviços concluídos e ranking local |
| 📍 Geolocalização | Profissionais ranqueados por proximidade e relevância |
| 🌐 Multi-nicho | Do mecânico ao desenvolvedor — qualquer categoria de serviço |
| 📣 Impulsionamento opcional | Planos pagos de destaque sem prejudicar o usuário gratuito |

---

## 5. Público-Alvo

| Perfil | Caracterização | Necessidade Principal |
|---|---|---|
| 💼 **Freelancer / Autônomo** | Profissional que deseja ofertar serviços, conquistar clientes, construir reputação e gerenciar renda | Visibilidade, organização e crescimento profissional |
| 👤 **Cliente (Pessoa Física)** | Pessoa que precisa contratar um serviço específico com rapidez e segurança | Confiança, praticidade e preço justo |
| 🏢 **Empresa / PJ** | Negócio que deseja contratar freelancers recorrentemente ou impulsionar presença | Contratação ágil e recorrente, sem burocracia |

---

## 6. Escopo do MVP

### 6.1 Módulos Funcionais

| # | Módulo | Responsabilidade Principal |
|---|---|---|
| 01 | 🔐 Autenticação | Gestão de contas, login social, tokens JWT |
| 02 | 👤 Perfis | Dados de clientes, freelancers, empresas, portfólio |
| 03 | 🗃️ Categorias e Serviços | Catálogo de serviços, taxonomia, tags |
| 04 | 🤝 Contratações | Fluxo completo de proposta, contratação e status |
| 05 | 💳 Pagamentos | Gateway MercadoPago, carteira digital, saques |
| 06 | ⭐ Avaliações | Sistema de reputação, estrelas e comentários |
| 07 | 💬 Chat | Mensagens em tempo real entre usuários |
| 08 | 🎮 Gamificação | XP, níveis, badges, missões, rankings |
| 09 | 🔔 Notificações | Push, e-mail, SMS e notificações in-app |
| 10 | 🛡️ Suporte e Mediação | Tickets, atendimento e resolução de conflitos |
| 11 | 📣 Impulsionamento | Planos pagos de destaque na plataforma |
| 12 | ⚙️ Administração | Painel administrativo para gestão da plataforma |
| 13 | ⚖️ Compliance / LGPD | Consentimento, anonimização e proteção de dados |
| 14 | 📈 Relatórios | Analytics, métricas de uso e performance |

### 6.2 Fora do Escopo do MVP

Os seguintes itens estão **explicitamente fora** do escopo do MVP e serão considerados em versões futuras:

- Integração com outros gateways de pagamento (além do MercadoPago)
- App nativo separado iOS / Android (o MVP usa Expo/React Native)
- Sistema de assinatura recorrente para clientes
- API pública para integrações externas
- Internacionalização (i18n) — MVP focado no Brasil

---

## 7. Arquitetura e Stack Técnica

### 7.1 Visão Geral da Arquitetura

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENTES                              │
│          Web (React)          Mobile (React Native)          │
└────────────────┬────────────────────┬───────────────────────┘
                 │                    │
                 ▼                    ▼
┌─────────────────────────────────────────────────────────────┐
│                    API Gateway / Cloudflare                   │
│                  (CDN, DDoS, SSL, Rate Limit)                 │
└─────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              Backend — Node.js + Express + TypeScript         │
│                                                               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐  │
│  │   Auth   │ │  Perfis  │ │   Chat   │ │  Pagamentos   │  │
│  │  Module  │ │  Module  │ │ (WS/RT)  │ │ MercadoPago   │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐  │
│  │  Gamif.  │ │Contrat.  │ │  Notif.  │ │   Admin API   │  │
│  │  Module  │ │  Module  │ │  Module  │ │    Module     │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────────┘  │
└─────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    MySQL — DigitalOcean                       │
│                      45+ tabelas                              │
└─────────────────────────────────────────────────────────────┘
```

### 7.2 Stack Detalhada

| Camada | Tecnologia | Justificativa |
|---|---|---|
| Frontend Web | React 18 + Vite + TypeScript | Performance, ecossistema maduro, tipagem |
| Mobile | React Native + Expo | Compartilhamento de lógica com web, deploy rápido |
| Backend | Node.js + Express + TypeScript | Performance I/O, tipagem, ecossistema npm |
| Banco de Dados | MySQL 8 | Transações ACID, maturidade, custo-benefício |
| Autenticação | JWT + OAuth2 | Stateless, padrão de mercado, login social |
| Real-time | WebSockets (Socket.IO) | Chat em tempo real, notificações push |
| Pagamentos | MercadoPago API | Maior cobertura no Brasil, PIX nativo |
| Hospedagem | DigitalOcean Droplets | Custo-benefício, controle, escalabilidade |
| CDN / Segurança | Cloudflare | DDoS, SSL automático, cache global |
| Storage | DigitalOcean Spaces (S3-compatible) | Imagens de perfil, portfólio, documentos |

---

## 8. Modelagem de Dados

### 8.1 Principais Entidades

```
users                    → base de todos os perfis
  ├── profiles_client    → dados específicos do cliente
  ├── profiles_freelancer→ dados + portfólio do freelancer
  └── profiles_company   → dados da empresa/PJ

services                 → catálogo de serviços ofertados
  └── service_categories → taxonomia de categorias

contracts                → ciclo completo de uma contratação
  ├── proposals          → proposta inicial
  ├── contract_status    → histórico de status
  └── deliveries         → entrega do serviço

payments                 → transações financeiras
  ├── wallets            → carteira digital por usuário
  └── withdrawals        → saques do freelancer

reviews                  → avaliações pós-serviço
  └── review_responses   → resposta do avaliado

messages                 → chat entre usuários
  └── conversations      → agrupamento de mensagens

gamification
  ├── user_xp            → pontos de experiência
  ├── user_badges        → badges conquistadas
  ├── missions           → missões disponíveis
  └── user_missions      → progresso por usuário

notifications            → central de notificações
support_tickets          → suporte e mediação
boosts                   → impulsionamentos ativos
audit_logs               → rastreabilidade de ações
lgpd_consents            → consentimentos LGPD
```

> A modelagem completa com DDL (CREATE TABLE) está disponível em [`docs/modelagem-banco.md`](./modelagem-banco.md).

---

## 9. Requisitos Funcionais

### Módulo 01 — Autenticação

| ID | Requisito | Prioridade |
|---|---|---|
| RF-001 | O sistema deve permitir cadastro via e-mail e senha | Alta |
| RF-002 | O sistema deve permitir login via Google OAuth2 | Alta |
| RF-003 | O sistema deve emitir tokens JWT com expiração configurável | Alta |
| RF-004 | O sistema deve suportar refresh token para renovação de sessão | Alta |
| RF-005 | O sistema deve permitir recuperação de senha via e-mail | Alta |
| RF-006 | O sistema deve verificar e-mail por link de confirmação | Média |

### Módulo 02 — Perfis

| ID | Requisito | Prioridade |
|---|---|---|
| RF-007 | O freelancer deve poder criar perfil com foto, bio, especialidades e localização | Alta |
| RF-008 | O freelancer deve poder adicionar itens de portfólio com imagens e descrição | Alta |
| RF-009 | O cliente deve poder visualizar o perfil completo do freelancer antes de contratar | Alta |
| RF-010 | O sistema deve exibir nota média, total de serviços e badges no perfil | Alta |
| RF-011 | O usuário deve poder editar seus dados pessoais a qualquer momento | Média |
| RF-012 | O sistema deve suportar perfil do tipo empresa com múltiplos membros | Baixa |

### Módulo 03 — Categorias e Serviços

| ID | Requisito | Prioridade |
|---|---|---|
| RF-013 | O sistema deve disponibilizar catálogo de categorias e subcategorias de serviços | Alta |
| RF-014 | O freelancer deve poder cadastrar serviços com título, descrição, preço e prazo | Alta |
| RF-015 | O cliente deve poder buscar serviços por categoria, localização e preço | Alta |
| RF-016 | O sistema deve suportar busca textual por palavras-chave | Alta |
| RF-017 | O sistema deve permitir filtragem por nota mínima do profissional | Média |
| RF-018 | O sistema deve exibir serviços em destaque (impulsionados) no topo dos resultados | Média |

### Módulo 04 — Contratações

| ID | Requisito | Prioridade |
|---|---|---|
| RF-019 | O cliente deve poder enviar proposta de contratação a um freelancer | Alta |
| RF-020 | O freelancer deve poder aceitar, recusar ou contra-propor | Alta |
| RF-021 | O sistema deve rastrear o status da contratação (proposta, aceito, em andamento, entregue, concluído, cancelado) | Alta |
| RF-022 | O cliente deve poder marcar a entrega como concluída ou solicitar revisão | Alta |
| RF-023 | O sistema deve liberar o pagamento ao freelancer somente após conclusão confirmada | Alta |
| RF-024 | O sistema deve permitir cancelamento com política de reembolso configurável | Média |

### Módulo 05 — Pagamentos

| ID | Requisito | Prioridade |
|---|---|---|
| RF-025 | O sistema deve processar pagamentos via MercadoPago (cartão, PIX, boleto) | Alta |
| RF-026 | O pagamento do cliente deve ficar retido (escrow) até a conclusão do serviço | Alta |
| RF-027 | O freelancer deve ter carteira digital com saldo disponível | Alta |
| RF-028 | O freelancer deve poder solicitar saque para conta bancária | Alta |
| RF-029 | O sistema deve exibir histórico detalhado de transações | Alta |
| RF-030 | O sistema deve aplicar e exibir a taxa da plataforma de forma transparente | Alta |

### Módulo 06 — Avaliações

| ID | Requisito | Prioridade |
|---|---|---|
| RF-031 | O cliente deve poder avaliar o freelancer após conclusão do serviço | Alta |
| RF-032 | A avaliação deve incluir nota (1 a 5 estrelas) e comentário textual | Alta |
| RF-033 | O freelancer deve poder responder publicamente a avaliações | Média |
| RF-034 | O sistema deve calcular e exibir a nota média do freelancer em tempo real | Alta |
| RF-035 | Avaliações devem ser vinculadas obrigatoriamente a uma contratação real | Alta |

### Módulo 07 — Chat

| ID | Requisito | Prioridade |
|---|---|---|
| RF-036 | O sistema deve disponibilizar chat em tempo real entre cliente e freelancer | Alta |
| RF-037 | O chat deve suportar envio de texto, imagens e arquivos | Alta |
| RF-038 | O sistema deve exibir status de leitura das mensagens | Média |
| RF-039 | O sistema deve notificar o usuário de novas mensagens via push | Alta |
| RF-040 | O histórico de mensagens deve ser preservado e acessível após a contratação | Média |

### Módulo 08 — Gamificação

| ID | Requisito | Prioridade |
|---|---|---|
| RF-041 | O sistema deve atribuir XP ao freelancer por ações (serviço concluído, boa avaliação, missão cumprida) | Alta |
| RF-042 | O sistema deve definir níveis com base no XP acumulado (ex: Iniciante → Especialista → Mestre) | Alta |
| RF-043 | O sistema deve emitir badges por conquistas específicas | Alta |
| RF-044 | O sistema deve disponibilizar missões periódicas com recompensas em XP ou destaque | Média |
| RF-045 | O sistema deve exibir ranking local de freelancers por categoria e nota | Média |

### Módulos 09–14 (Resumo)

| ID | Módulo | Requisito | Prioridade |
|---|---|---|---|
| RF-046 | Notificações | Push notification para novos pedidos, mensagens e pagamentos | Alta |
| RF-047 | Notificações | E-mail transacional para eventos críticos (confirmação, pagamento) | Alta |
| RF-048 | Suporte | Cliente ou freelancer pode abrir ticket de suporte dentro do app | Alta |
| RF-049 | Suporte | Administrador pode intervir em disputas e emitir resolução | Alta |
| RF-050 | Impulsionamento | Freelancer pode contratar plano de destaque com duração e alcance definidos | Média |
| RF-051 | Administração | Painel admin com visão de usuários, transações, tickets e métricas | Alta |
| RF-052 | LGPD | Sistema deve registrar consentimento explícito no cadastro | Alta |
| RF-053 | LGPD | Usuário deve poder solicitar exclusão de dados pessoais | Alta |
| RF-054 | Relatórios | Dashboard com métricas de uso: DAU, MAU, volume de contratações, receita | Média |

> ⚠️ A lista completa com todos os 72 Requisitos Funcionais está em [`docs/requisitos-funcionais.md`](./requisitos-funcionais.md).

---

## 10. Requisitos Não Funcionais

| ID | Categoria | Requisito |
|---|---|---|
| RNF-001 | Performance | API deve responder em menos de 300ms para 95% das requisições sob carga normal |
| RNF-002 | Performance | O app mobile deve atingir score mínimo de 85 no Lighthouse mobile |
| RNF-003 | Disponibilidade | SLA mínimo de 99,5% de uptime mensal |
| RNF-004 | Segurança | Todas as senhas devem ser armazenadas com bcrypt (salt rounds ≥ 12) |
| RNF-005 | Segurança | Comunicação exclusivamente via HTTPS/TLS 1.3 |
| RNF-006 | Segurança | Tokens JWT com expiração de 1h; refresh token com expiração de 7 dias |
| RNF-007 | Segurança | Rate limiting por IP e por usuário nas rotas críticas |
| RNF-008 | Escalabilidade | Arquitetura modular que permita extração de microsserviços futuramente |
| RNF-009 | Usabilidade | Fluxo de contratação concluído em no máximo 5 interações do usuário |
| RNF-010 | Usabilidade | Interface responsiva para desktop, tablet e mobile (Web) |
| RNF-011 | Conformidade | Plena conformidade com a LGPD (Lei 13.709/2018) |
| RNF-012 | Conformidade | Logs de auditoria para todas as ações financeiras |
| RNF-013 | Manutenibilidade | Cobertura mínima de 70% de testes automatizados nos módulos críticos |
| RNF-014 | Manutenibilidade | Documentação de API via OpenAPI/Swagger atualizada a cada release |
| RNF-015 | Acessibilidade | Interface web com nível mínimo AA do WCAG 2.1 |

> ⚠️ A lista completa com todos os 36 RNFs está em [`docs/requisitos-nao-funcionais.md`](./requisitos-nao-funcionais.md).

---

## 11. Riscos e Mitigações

| # | Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|---|
| R01 | Dilema ovo ou galinha — baixa adesão inicial | Alta | Crítico | Estratégia de seed manual: recrutar freelancers ativamente antes do lançamento ao público |
| R02 | Usuários negociando fora da plataforma | Alta | Alto | Manter pagamento e chat exclusivos na plataforma; benefícios de fidelidade por permanência |
| R03 | Fraudes e perfis falsos | Média | Alto | Verificação por e-mail + telefone + CPF no onboarding; moderação manual inicial |
| R04 | Escopo técnico subestimado | Média | Alto | Arquitetura modular; MVP focado nos fluxos críticos; entregas incrementais |
| R05 | Não conformidade com LGPD | Baixa | Crítico | Implementar consentimento, anonimização e DPO desde o MVP |
| R06 | Falha no processamento de pagamentos | Baixa | Crítico | Uso de gateway confiável (MercadoPago); testes de stress; retentativas automáticas |
| R07 | Competição de plataformas estabelecidas | Alta | Médio | Diferenciar pela UX, gamificação e foco local — nichos que gigantes ignoram |

---

## 12. Indicadores de Sucesso

### 12.1 Indicadores Técnicos do MVP

- [ ] Cadastro e autenticação funcionando para os 3 perfis (cliente, freelancer, empresa)
- [ ] Fluxo completo operacional: proposta → aceite → entrega → avaliação
- [ ] Chat funcional em tempo real entre cliente e freelancer
- [ ] Pagamento MercadoPago processado e saldo creditado na carteira do freelancer
- [ ] 72 RFs e 36 RNFs cobertos na especificação técnica
- [ ] Banco de dados MySQL com 45+ tabelas implementado e validado

### 12.2 Indicadores de Extensão (Validação com a Comunidade)

- [ ] Mínimo de 10 freelancers entrevistados para validação do problema
- [ ] Protótipo de baixa fidelidade testado com ao menos 5 usuários reais
- [ ] Feedback documentado do parceiro externo / comunidade
- [ ] Evidências coletadas e apresentadas na banca avaliadora

---

## 13. Extensão Universitária e Impacto Social

O Escambo é desenvolvido no contexto da **Extensão Universitária**, conectando o conhecimento técnico produzido na Católica SC com uma demanda social real: a precarização do trabalho autônomo e a dificuldade de formalização digital de freelancers brasileiros.

### 13.1 Impacto Esperado

- **Geração de renda:** facilitar a captação de clientes para trabalhadores autônomos de baixa e média renda
- **Formalização digital:** oferecer ferramentas de gestão financeira e histórico profissional para quem nunca teve acesso a esse tipo de recurso
- **Inclusão tecnológica:** interface simples o suficiente para ser usada por qualquer pessoa com smartphone

### 13.2 Licenciamento

Por ser um projeto voltado à comunidade, o Escambo é disponibilizado sob a licença **MIT**, garantindo acesso público, transparência total e possibilidade de contribuição.

### 13.3 Processo de Validação

A demanda foi validada por meio de:
- Entrevistas qualitativas com freelancers autônomos (pedreiros, diaristas, desenvolvedores, designers)
- Análise de grupos locais de WhatsApp e Facebook voltados à troca de serviços
- Benchmarking com plataformas existentes e identificação das suas limitações

---

## 14. Considerações Finais

O Escambo nasce para resolver uma lacuna real no mercado brasileiro: a ausência de uma plataforma que combine simplicidade de uso, confiabilidade nos profissionais e ferramentas de gestão para freelancers em um único produto digital.

A fundamentação apresentada neste documento demonstra que o problema é relevante, o mercado é amplo e a proposta de solução é coerente, viável e sustentável. O planejamento estruturado — com 14 módulos, modelagem de banco com 45+ tabelas, 72 Requisitos Funcionais e 36 Não Funcionais — evidencia maturidade técnica no entendimento do problema e clareza na definição do que será construído.

Os próximos passos incluem:
1. Criação de wireframes de alta fidelidade (Figma)
2. Definição da política de comissionamento
3. Definição da política de cancelamento e reembolso
4. Início do desenvolvimento do backend (módulos de autenticação e perfis)
5. Coleta formal de evidências de extensão com a comunidade

---

## 15. Referências

- IBGE. **Pesquisa Nacional por Amostra de Domicílios Contínua (PNAD Contínua) 2023**. Instituto Brasileiro de Geografia e Estatística. Disponível em: https://www.ibge.gov.br/pnad. Acesso em: abr. 2026.

- BRASIL. **Lei nº 13.709, de 14 de agosto de 2018** — Lei Geral de Proteção de Dados Pessoais (LGPD). Diário Oficial da União, Brasília, 2018.

- CONVENTIONAL COMMITS. **Conventional Commits Specification v1.0.0**. Disponível em: https://www.conventionalcommits.org. Acesso em: abr. 2026.

- OWASP. **OWASP Top Ten 2021**. Open Web Application Security Project. Disponível em: https://owasp.org/Top10. Acesso em: abr. 2026.

- MERCADOPAGO. **Documentação da API MercadoPago**. Disponível em: https://www.mercadopago.com.br/developers. Acesso em: abr. 2026.

- W3C. **Web Content Accessibility Guidelines (WCAG) 2.1**. World Wide Web Consortium, 2018. Disponível em: https://www.w3.org/TR/WCAG21. Acesso em: abr. 2026.

---

<div align="center">

*RFC-001 — Escambo v1.0.0 — PAC Extensionista VII — Católica SC — 2026*

</div>
