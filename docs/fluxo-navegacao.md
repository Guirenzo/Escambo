# Fluxo de Navegação — Escambo

> **Versão:** 1.0.0  
> **Disciplina:** PAC Extensionista VII — Católica SC  
> **Autor:** [Seu Nome]  
> **Data:** 2026

---

## Índice

1. [Visão Geral](#1-visão-geral)
2. [Fluxo de Onboarding](#2-fluxo-de-onboarding)
3. [Fluxo do Cliente](#3-fluxo-do-cliente)
4. [Fluxo do Freelancer](#4-fluxo-do-freelancer)
5. [Módulos Compartilhados](#5-módulos-compartilhados)
6. [Diagrama Textual Completo](#6-diagrama-textual-completo)

---

## 1. Visão Geral

O Escambo possui dois fluxos principais após o onboarding: o **fluxo do cliente** (busca, contratação e avaliação) e o **fluxo do freelancer** (oferta, execução e recebimento). Ambos convergem nos módulos de **chat**, **notificações** e **suporte**.

| Perfil | Ponto de entrada | Destino final |
|---|---|---|
| Cliente | Home → Busca → Perfil do freelancer | Avaliação do serviço concluído |
| Freelancer | Dashboard → Serviços → Propostas | Saque na carteira digital |
| Ambos | Login / Cadastro | Chat, Notificações, Suporte |

---

## 2. Fluxo de Onboarding

```
[Splash / Abertura]
        │
        ▼
[Login / Cadastro]
  ├── E-mail e senha
  └── Google OAuth2
        │
        ▼
[Verificação de e-mail]
        │
        ▼
[Escolha de perfil]
  ├── Cliente      ──────────────────► Fluxo do Cliente
  ├── Freelancer   ──────────────────► Fluxo do Freelancer
  └── Empresa      ──────────────────► Fluxo do Freelancer (PJ)
```

### Telas do Onboarding

| # | Tela | Descrição | Ações disponíveis |
|---|---|---|---|
| 1 | Splash / Abertura | Logo e slogan da plataforma | Entrar, Criar conta |
| 2 | Login | Formulário de autenticação | E-mail/senha, Google OAuth |
| 3 | Cadastro | Formulário de criação de conta | Tipo de perfil, e-mail, senha |
| 4 | Verificação de e-mail | Confirmação por link enviado | Reenviar e-mail |
| 5 | Escolha de perfil | Seleção do tipo de usuário | Cliente, Freelancer, Empresa |
| 6 | Completar perfil | Dados básicos do perfil | Foto, nome, cidade, bio |

---

## 3. Fluxo do Cliente

```
[Home do cliente]
  └── Destaque de serviços impulsionados
        │
        ▼
[Busca e filtros]
  ├── Filtro por categoria
  ├── Filtro por faixa de preço
  ├── Filtro por nota mínima
  └── Filtro por localização / proximidade
        │
        ▼
[Perfil do freelancer]
  ├── Portfólio de trabalhos
  ├── Avaliações verificadas
  ├── Nota média e badges
  └── Tempo médio de resposta
        │
        ▼
[Enviar proposta]
  ├── Descrição do que precisa
  ├── Prazo desejado
  └── Valor negociado
        │
        ▼
[Pagamento]
  ├── PIX
  ├── Cartão de crédito/débito
  └── Boleto bancário
        │
        ▼
[Acompanhar contrato]
  ├── Status em tempo real
  ├── Chat com o freelancer
  └── Receber e revisar entrega
        │
        ▼
[Avaliar serviço]
  ├── Nota de 1 a 5 estrelas
  └── Comentário opcional
```

### Telas do Fluxo do Cliente

| # | Tela | Descrição | Ações disponíveis |
|---|---|---|---|
| 1 | Home | Feed com serviços em destaque e categorias | Buscar, ver destaques |
| 2 | Busca | Resultados com filtros avançados | Filtrar, ordenar, selecionar |
| 3 | Perfil do freelancer | Perfil completo com portfólio | Ver avaliações, contratar |
| 4 | Envio de proposta | Formulário de proposta | Descrever serviço, confirmar |
| 5 | Checkout / Pagamento | Seleção do método e confirmação | PIX, cartão, boleto |
| 6 | Acompanhamento | Status e timeline do contrato | Chat, aprovar entrega, solicitar revisão |
| 7 | Avaliação | Formulário pós-conclusão | Estrelas, comentário, publicar |
| 8 | Histórico | Todos os contratos passados e ativos | Visualizar, repetir contratação |

---

## 4. Fluxo do Freelancer

```
[Dashboard]
  ├── Ganhos do período
  ├── Contratos ativos
  ├── Nota média
  └── Progresso de XP / nível
        │
        ▼
[Gerenciar serviços]
  ├── Criar novo serviço
  ├── Editar serviço existente
  └── Pausar / ativar serviço
        │
        ▼
[Propostas recebidas]
  ├── Aceitar proposta
  ├── Recusar com justificativa
  └── Fazer contra-proposta
        │
        ▼
[Chat]
  ├── Conversa pré-contrato
  └── Conversa durante execução
        │
        ▼
[Registrar entrega]
  ├── Mensagem de entrega
  └── Upload de arquivos
        │
        ▼
[Carteira digital]
  ├── Saldo disponível
  ├── Saldo pendente (escrow)
  ├── Histórico de transações
  └── Solicitar saque (PIX / TED)
        │
        ▼
[Conquistas]
  ├── XP total e nível atual
  ├── Badges conquistadas
  ├── Missões ativas e progresso
  └── Ranking local por categoria
```

### Telas do Fluxo do Freelancer

| # | Tela | Descrição | Ações disponíveis |
|---|---|---|---|
| 1 | Dashboard | Painel central com métricas e resumo | Ver contratos, ganhos, nível |
| 2 | Meus serviços | Lista de serviços criados | Criar, editar, pausar, ativar |
| 3 | Novo serviço | Formulário de criação | Título, categoria, preço, prazo, tags |
| 4 | Propostas | Inbox de propostas recebidas | Aceitar, recusar, contra-propor |
| 5 | Chat | Conversas ativas | Texto, imagem, arquivo |
| 6 | Contrato ativo | Execução e entrega | Registrar entrega, ver status |
| 7 | Carteira | Saldo e transações | Ver histórico, sacar |
| 8 | Conquistas | Gamificação completa | Ver XP, badges, missões, ranking |
| 9 | Meu perfil | Edição do perfil público | Foto, bio, portfólio, disponibilidade |

---

## 5. Módulos Compartilhados

Acessíveis por ambos os perfis a qualquer momento via menu inferior:

```
┌─────────────────────────────────────────────┐
│           MENU INFERIOR (Tab Bar)            │
├──────────┬──────────┬──────────┬─────────────┤
│  Home /  │  Minhas  │   Chat   │   Perfil    │
│ Dashboard│ Atividades│         │             │
└──────────┴──────────┴──────────┴─────────────┘
```

| Módulo | Acesso | Funcionalidade |
|---|---|---|
| **Notificações** | Sino no header | Push in-app de todos os eventos |
| **Chat** | Tab central | Todas as conversas ativas |
| **Suporte** | Menu lateral | Abrir ticket, histórico de chamados |
| **Configurações** | Menu lateral | Dados da conta, privacidade, LGPD |
| **Meu perfil** | Tab / header | Edição do perfil público |

---

## 6. Diagrama Textual Completo

```
                    ┌──────────────────┐
                    │ Splash / Abertura│
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │Login / Cadastro   │
                    │OAuth · e-mail     │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │ Escolha de perfil │
                    └───┬──────────┬───┘
                        │          │
           ┌────────────▼──┐   ┌───▼────────────┐
           │   CLIENTE      │   │   FREELANCER   │
           └────────────────┘   └────────────────┘
                │                       │
         ┌──────▼──────┐         ┌──────▼──────┐
         │    Home     │         │  Dashboard  │
         └──────┬──────┘         └──────┬──────┘
                │                       │
         ┌──────▼──────┐         ┌──────▼──────┐
         │    Busca    │         │  Serviços   │
         └──────┬──────┘         └──────┬──────┘
                │                       │
         ┌──────▼──────┐         ┌──────▼──────┐
         │Perfil Freela│         │  Propostas  │
         └──────┬──────┘         └──────┬──────┘
                │                       │
         ┌──────▼──────┐    ┌──────────▼──────────┐
         │  Proposta   │    │         Chat         │
         └──────┬──────┘    └──────────┬──────────┘
                │                       │
         ┌──────▼──────┐         ┌──────▼──────┐
         │  Pagamento  │         │  Entrega    │
         └──────┬──────┘         └──────┬──────┘
                │                       │
         ┌──────▼──────┐         ┌──────▼──────┐
         │  Contrato   │         │  Carteira   │
         └──────┬──────┘         └──────┬──────┘
                │                       │
         ┌──────▼──────┐         ┌──────▼──────┐
         │  Avaliação  │         │ Conquistas  │
         └─────────────┘         └─────────────┘
                │                       │
                └───────────┬───────────┘
                            │
               ┌────────────▼────────────┐
               │  Notificações · Suporte  │
               │    Configurações · LGPD  │
               └──────────────────────────┘
```

---

<div align="center">

*fluxo-navegacao.md — Escambo v1.0.0 — NP2 — PAC Extensionista VII — Católica SC — 2026*

</div>
