# Wireframes — Escambo

> **Versão:** 1.0.0  
> **Disciplina:** PAC Extensionista VII — Católica SC  
> **Autor:** [Seu Nome]  
> **Data:** 2026  
> **Ferramenta sugerida para protótipo navegável:** Figma

---

## Índice

1. [Visão Geral das Telas](#1-visão-geral-das-telas)
2. [WF-01 — Home / Busca (Cliente)](#2-wf-01--home--busca-cliente)
3. [WF-02 — Perfil do Freelancer](#3-wf-02--perfil-do-freelancer)
4. [WF-03 — Dashboard do Freelancer](#4-wf-03--dashboard-do-freelancer)
5. [WF-04 — Chat](#5-wf-04--chat)
6. [WF-05 — Pagamento](#6-wf-05--pagamento)
7. [WF-06 — Conquistas e Gamificação](#7-wf-06--conquistas-e-gamificação)
8. [Componentes Reutilizáveis](#8-componentes-reutilizáveis)

---

## 1. Visão Geral das Telas

| ID | Tela | Perfil | Módulo |
|---|---|---|---|
| WF-01 | Home / Busca | Cliente | Busca e Serviços |
| WF-02 | Perfil do Freelancer | Cliente (visualiza) | Perfis |
| WF-03 | Dashboard | Freelancer | Relatórios + Contratações |
| WF-04 | Chat | Ambos | Chat |
| WF-05 | Pagamento | Cliente | Pagamentos |
| WF-06 | Conquistas | Freelancer | Gamificação |

> Os wireframes foram desenvolvidos para resolução mobile (375×812px — iPhone 14 base).  
> O protótipo navegável deve ser construído no Figma seguindo este documento.

---

## 2. WF-01 — Home / Busca (Cliente)

**Objetivo da tela:** ponto de entrada do cliente — descoberta de serviços por categoria e palavra-chave.

```
┌─────────────────────────────┐
│  9:41              ●●●      │  ← Status bar
├─────────────────────────────┤
│  Olá, Camila 👋              │  ← Saudação personalizada
│  ┌─────────────────────────┐ │
│  │ 🔍 Que serviço você...  │ │  ← Campo de busca (fullwidth)
│  └─────────────────────────┘ │
├─────────────────────────────┤
│ [Todos] [Tecnologia] [Refor]│  ← Pills de categoria (scroll horizontal)
├─────────────────────────────┤
│  EM DESTAQUE                │  ← Label de seção
│  ┌──────────────────────┐   │
│  │ 💻 Desenvolvimento...│   │  ← Card de serviço
│  │    Rafael Souza      │   │     com badge "Destaque"
│  │    ★4,9 · R$350      │   │
│  └──────────────────────┘   │
│  ┌──────────────────────┐   │
│  │ ⚡ Instalação elét... │   │
│  │    Marcos Oliveira   │   │
│  │    ★4,7 · R$120      │   │
│  └──────────────────────┘   │
├─────────────────────────────┤
│ 🏠 Home │📅 Contr│💬 Chat│🔔│👤│  ← Tab bar
└─────────────────────────────┘
```

**Elementos principais:**

| Elemento | Tipo | Comportamento |
|---|---|---|
| Campo de busca | Input text | Abre tela de busca com filtros |
| Pills de categoria | Scroll horizontal | Filtra os cards abaixo |
| Card de serviço | Touchable card | Abre WF-02 (perfil do freelancer) |
| Badge "Destaque" | Pill âmbar | Identifica serviços impulsionados |
| Tab bar | Navegação inferior | Persiste em todas as telas |

---

## 3. WF-02 — Perfil do Freelancer

**Objetivo da tela:** apresentar o freelancer com tudo que o cliente precisa para decidir contratar.

```
┌─────────────────────────────┐
│  9:41              ●●●      │
├─────────────────────────────┤
│         [Avatar 64px]       │  ← Foto do freelancer
│      Rafael Souza           │  ← Nome
│   Dev Full Stack · Joinvil. │  ← Headline + cidade
│      ● Disponível           │  ← Badge de disponibilidade
│  ┌──────────────────────┐   │
│  │4,9★ │ 38  │ ~2h │ Nv4│  │  ← Stats: nota, serviços, resposta, nível
│  └──────────────────────┘   │
│  [Top 10 local][5 estrelas] │  ← Badges (scroll horizontal)
├─────────────────────────────┤
│  SOBRE                      │
│  Dev Full Stack com foco... │  ← Bio
│  PORTFÓLIO                  │
│  ┌────────┐  ┌────────┐     │
│  │E-comm. │  │App mob.│     │  ← Grid 2 colunas
│  └────────┘  └────────┘     │
│  AVALIAÇÕES RECENTES        │
│  ┌──────────────────────┐   │
│  │ Camila F. ★★★★★      │   │  ← Cards de avaliação
│  │ "Entregou antes..."  │   │
│  └──────────────────────┘   │
├─────────────────────────────┤
│  [💬]  [  Contratar R$350 ] │  ← CTA fixo no bottom
└─────────────────────────────┘
```

**Elementos principais:**

| Elemento | Tipo | Comportamento |
|---|---|---|
| Avatar | Imagem circular | Visualização apenas |
| Stats bar | Grid 4 colunas | Exibição de métricas |
| Badges | Pills coloridos | Exibição de conquistas |
| Grid portfólio | 2 colunas | Abre item em modal |
| Botão contratar | CTA primário fixo | Abre fluxo de proposta |
| Botão chat | Ícone secundário | Abre WF-04 |

---

## 4. WF-03 — Dashboard do Freelancer

**Objetivo da tela:** visão central de performance, ganhos e contratos ativos.

```
┌─────────────────────────────┐
│  9:41              ●●●      │
├─────────────────────────────┤
│  Olá, Rafael 👋              │
│  Maio de 2026 · Nível 4     │
│  ┌──────────┐ ┌──────────┐  │
│  │ R$2.840  │ │   3      │  │  ← Métricas (grid 2x2)
│  │ Ganhos   │ │ Ativos   │  │
│  └──────────┘ └──────────┘  │
│  ┌──────────┐ ┌──────────┐  │
│  │  4,9★   │ │  1.240   │  │
│  │  Nota   │ │   XP     │  │
│  └──────────┘ └──────────┘  │
├─────────────────────────────┤
│  PROGRESSO DE NÍVEL         │
│  Nível 4 ──────────── 62%   │  ← Barra de XP
│  1.240 / 2.000 XP           │
├─────────────────────────────┤
│  CONTRATOS ATIVOS           │
│  Landing page React  [Em and│  ← Cards de contrato
│  API de pagamentos   [Aguard│     com status pill
│  Dashboard admin     [Entre │
├─────────────────────────────┤
│🏠 Dash│💼 Serv│💬 Chat│💳│👤 │
└─────────────────────────────┘
```

**Elementos principais:**

| Elemento | Tipo | Comportamento |
|---|---|---|
| Métricas 2x2 | Cards de stat | Exibição, toque abre detalhe |
| Barra de XP | Progress bar | Exibição do progresso de nível |
| Cards de contrato | Lista | Toque abre detalhe do contrato |
| Status pills | Pill colorido | Verde = ativo / Âmbar = pendente / Roxo = entregue |

---

## 5. WF-04 — Chat

**Objetivo da tela:** comunicação em tempo real entre cliente e freelancer.

```
┌─────────────────────────────┐
│  9:41              ●●●      │
├─────────────────────────────┤
│ ← [Avatar] Rafael Souza   ⋮ │  ← Header com status online
│          ● Online agora     │
├─────────────────────────────┤
│                             │
│  ┌─────────────────────┐    │  ← Mensagem recebida (esquerda)
│  │ Olá! Vi seu portfó..│    │
│  └─────────────────────┘    │
│                             │
│     ┌──────────────────────┐│  ← Mensagem enviada (direita)
│     │ Obrigado! Me conta...││
│     └──────────────────────┘│
│                             │
│  ┌─────────────────────┐    │
│  │ Preciso de uma land.│    │
│  └─────────────────────┘    │
│                             │
├─────────────────────────────┤
│ 📎  [  Escreva uma mens... ]│🟢│  ← Input + botão enviar
└─────────────────────────────┘
```

**Elementos principais:**

| Elemento | Tipo | Comportamento |
|---|---|---|
| Bolhas de mensagem | Componente | Esquerda = recebida / Direita = enviada |
| Status de leitura | Ícone | ✓ enviado / ✓✓ lido |
| Botão anexo | Ícone | Abre seletor de arquivo/imagem |
| Campo de texto | Input multiline | Expandível com o conteúdo |
| Botão enviar | Botão circular | Envia via WebSocket |

---

## 6. WF-05 — Pagamento

**Objetivo da tela:** confirmação de pagamento com transparência total de taxas.

```
┌─────────────────────────────┐
│  9:41              ●●●      │
├─────────────────────────────┤
│  Confirmar pagamento        │  ← Título
│  Landing page React · Rafael│  ← Subtítulo com contexto
├─────────────────────────────┤
│  ┌──────────────────────┐   │
│  │ Valor do serviço R$350│   │  ← Resumo financeiro
│  │ Taxa plataforma  R$52 │   │     (taxa exibida explicitamente)
│  └──────────────────────┘   │
│  ┌──────────────────────┐   │
│  │ Total: R$ 350,00     │   │  ← Total em destaque verde
│  └──────────────────────┘   │
│  FORMA DE PAGAMENTO         │
│  ┌──────────────────────┐   │
│  │ ⚡ PIX  [Instantâneo] │ ◉ │  ← Opção selecionada
│  └──────────────────────┘   │
│  ┌──────────────────────┐   │
│  │ 💳 Cartão de crédito │ ○ │
│  └──────────────────────┘   │
│  ┌──────────────────────┐   │
│  │ 🧾 Boleto bancário   │ ○ │
│  └──────────────────────┘   │
├─────────────────────────────┤
│  [ Pagar com PIX — R$350 ] │  ← CTA primário
└─────────────────────────────┘
```

**Elementos principais:**

| Elemento | Tipo | Comportamento |
|---|---|---|
| Resumo financeiro | Card | Exibe valor + taxa separadamente |
| Total destacado | Card verde | Valor final que o cliente paga |
| Opções de pagamento | Radio list | Seleção exclusiva de método |
| CTA de pagamento | Botão primário | Redireciona para MercadoPago |

---

## 7. WF-06 — Conquistas e Gamificação

**Objetivo da tela:** engajamento e progressão do freelancer com XP, badges e missões.

```
┌─────────────────────────────┐
│  9:41              ●●●      │
├─────────────────────────────┤
│         Conquistas          │  ← Título
│   ⭐ Nível 4 — Especialista │  ← Badge de nível
│  ┌──────────────────────┐   │
│  │ Progresso p/ Nível 5 │   │  ← Barra de XP
│  │ ████████░░ 1.240/2000│   │
│  └──────────────────────┘   │
├─────────────────────────────┤
│  BADGES CONQUISTADAS        │
│  ┌──────┐ ┌──────┐ ┌──────┐│
│  │ 🚀   │ │ ⚡   │ │ ⭐   ││  ← Grid 3 colunas
│  │1º sv │ │Resp. │ │5★    ││
│  └──────┘ └──────┘ └──────┘│
│  ┌──────┐ ┌──────┐ ┌──────┐│
│  │ 🏆   │ │ 💎 🔒│ │ 🌟 🔒││  ← Bloqueadas com opacidade
│  │Top 10│ │50 sv │ │Mestr.││
│  └──────┘ └──────┘ └──────┘│
├─────────────────────────────┤
│  MISSÕES DA SEMANA          │
│  ┌──────────────────────┐   │
│  │Conclua 2 serviços +80XP│  ← Card de missão
│  │ ████░░ 1/2 · 4 dias  │   │     com barra de progresso
│  └──────────────────────┘   │
├─────────────────────────────┤
│  RANKING LOCAL — DEV        │
│  🥇 Ana Lima      4.240 XP  │  ← Top 3 local
│  🥈 Rafael (você) 1.240 XP  │
│  3  Carlos M.       980 XP  │
├─────────────────────────────┤
│🏠│💼│💬│💳│🏆 Conquistas   │
└─────────────────────────────┘
```

**Elementos principais:**

| Elemento | Tipo | Comportamento |
|---|---|---|
| Badge de nível | Pill verde | Exibição do nível atual |
| Barra de XP | Progress bar animada | Atualiza em tempo real |
| Grid de badges | 3 colunas | Bloqueadas têm opacidade reduzida |
| Cards de missão | Lista | Barra de progresso por missão |
| Ranking | Lista posicional | Top 10 do raio de 50km |

---

## 8. Componentes Reutilizáveis

Componentes que se repetem entre telas e devem ser criados uma vez no Figma:

| Componente | Usado em | Variantes |
|---|---|---|
| Status bar | Todas | Padrão |
| Tab bar | Todas | Cliente / Freelancer |
| Card de serviço | WF-01 | Com badge / Sem badge |
| Card de contrato | WF-03 | 5 status diferentes |
| Status pill | WF-03, WF-05 | Em andamento / Aguardando / Entregue / Cancelado |
| Progress bar | WF-03, WF-06 | XP / Missão |
| Bolha de mensagem | WF-04 | Enviada / Recebida |
| Métrica card | WF-03 | Valor monetário / Número / Estrela |
| Badge pill | WF-02, WF-06 | Desbloqueada / Bloqueada |
| Botão CTA | WF-02, WF-05 | Primário verde / Secundário |

---

<div align="center">

*wireframes.md — Escambo v1.0.0 — NP2 — PAC Extensionista VII — Católica SC — 2026*

</div>
