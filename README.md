<div align="center">

<img src="https://github.com/Guirenzo/Escambo/actions/workflows/ci.yml/badge.svg" alt="CI" />
<img src="https://img.shields.io/badge/status-em%20planejamento-yellow?style=for-the-badge&labelColor=0d1117" />
<img src="https://img.shields.io/badge/MVP-2026-blue?style=for-the-badge&labelColor=0d1117" />
<img src="https://img.shields.io/badge/licença-MIT-green?style=for-the-badge&labelColor=0d1117" />
<img src="https://img.shields.io/badge/TCC-PAC%20Extensionista%20VII-orange?style=for-the-badge&labelColor=0d1117" />

<br />
<br />

```
███████╗███████╗ ██████╗ █████╗ ███╗   ███╗██████╗  ██████╗
██╔════╝██╔════╝██╔════╝██╔══██╗████╗ ████║██╔══██╗██╔═══██╗
█████╗  ███████╗██║     ███████║██╔████╔██║██████╔╝██║   ██║
██╔══╝  ╚════██║██║     ██╔══██║██║╚██╔╝██║██╔══██╗██║   ██║
███████╗███████║╚██████╗██║  ██║██║ ╚═╝ ██║██████╔╝╚██████╔╝
╚══════╝╚══════╝ ╚═════╝╚═╝  ╚═╝╚═╝     ╚═╝╚═════╝  ╚═════╝
```

### **Plataforma Digital de Serviços Freelance**
*O iFood dos serviços — conectando quem precisa com quem sabe fazer*

<br />

[📄 RFC Completa](#-documentação) · [🗂️ Módulos](#️-módulos-do-mvp) · [🛠️ Stack](#️-stack-técnica) · [🗺️ Roadmap](#️-roadmap) · [🤝 Contribuindo](#-contribuindo)

<br />

---

</div>

## 📌 Sobre o Projeto

O **Escambo** é uma plataforma digital de marketplace de serviços que conecta **clientes** a **freelancers** de qualquer nicho — do mecânico ao desenvolvedor — com a mesma simplicidade e confiança que apps como o iFood trouxeram para o delivery.

> **Contexto acadêmico:** Este projeto é desenvolvido como Trabalho de Conclusão de Curso (TCC) na disciplina **PAC Extensionista VII**, da [Católica SC](https://www.catolicasc.org.br), com foco em extensão universitária e impacto social real.

O Brasil possui **mais de 24 milhões de trabalhadores autônomos** (IBGE), mas ainda carece de uma plataforma que combine simplicidade de uso, transparência e ferramentas de gestão em um único produto. O Escambo nasce para preencher essa lacuna.

---

## 🎯 O Problema

| Perspectiva | Dor |
|---|---|
| 🔍 **Cliente** | Processos lentos, desconfiança, dificuldade de encontrar profissionais qualificados localmente |
| 💼 **Freelancer** | Sem ferramentas centralizadas para agenda, finanças, reputação e aquisição de clientes |
| 🏗️ **Mercado** | Plataformas existentes (GetNinjas, Workana, OLX) têm UX ruim, sem gamificação e sem foco local |

---

## 💡 A Solução

Uma plataforma **Web + Mobile** que oferece:

- 🔄 **Troca de serviços (escambo)** — pague um serviço com outro serviço, com diferença em dinheiro (*torna*) quando os valores não batem. Exclusivo no Brasil e fiel ao nome da plataforma.
- 🔎 **Descoberta local** — profissionais ranqueados por proximidade e relevância
- ⭐ **Reputação verificada** — avaliações reais, comentários e histórico de serviços
- 💬 **Chat integrado** — comunicação direta dentro do app, sem sair para WhatsApp
- 🎮 **Gamificação** — XP, níveis, badges e missões para engajamento contínuo
- 💳 **Pagamento seguro** — via MercadoPago com carteira digital e saques programados
- 📊 **Dashboard do Freelancer** — ganhos, nota média, serviços concluídos e ranking

---

## 🛠️ Stack Técnica

<div align="center">

| Camada | Tecnologia |
|---|---|
| **Frontend Web** | React + Vite + TypeScript |
| **Mobile** | React Native + Expo |
| **Backend** | Node.js + Express + TypeScript |
| **Banco de Dados** | MySQL 8 (50 tabelas) |
| **Pagamentos** | MercadoPago API |
| **Hospedagem** | DigitalOcean |
| **CDN / DNS** | Cloudflare |
| **Autenticação** | JWT + OAuth2 (Login Social) |
| **Real-time** | WebSockets (Chat) |
| **Conformidade** | LGPD desde o lançamento |

</div>

---

## 🗂️ Módulos do MVP

O MVP é composto por **15 módulos funcionais**, cobrindo **90 Requisitos Funcionais** e **42 Não Funcionais**:

| # | Módulo | Responsabilidade |
|---|---|---|
| 01 | 🔐 Autenticação | Contas, login social, tokens JWT |
| 02 | 👤 Perfis | Clientes, freelancers, empresas, portfólio |
| 03 | 🗃️ Categorias e Serviços | Catálogo, taxonomia, tags |
| 04 | 🤝 Contratações | Proposta → aceite → entrega → avaliação |
| 05 | 💳 Pagamentos | Gateway MercadoPago, carteira, saques |
| 06 | ⭐ Avaliações | Sistema de reputação e comentários |
| 07 | 💬 Chat | Mensagens em tempo real |
| 08 | 🎮 Gamificação | XP, níveis, badges, missões, rankings |
| 09 | 🔔 Notificações | Push, e-mail, SMS, in-app |
| 10 | 🛡️ Suporte e Mediação | Tickets e resolução de conflitos |
| 11 | 📣 Impulsionamento | Planos pagos de destaque |
| 12 | ⚙️ Administração | Painel administrativo da plataforma |
| 13 | ⚖️ Compliance / LGPD | Consentimento, anonimização, privacidade |
| 14 | 📈 Relatórios | Analytics, métricas de uso e performance |
| 15 | 🔄 Troca de Serviços | Escambo: troca de serviço por serviço + *torna* em dinheiro |

---

## 🗺️ Roadmap

```
2026 Q1 — Planejamento e Fundamentação (NP1) ✅
  └─ RFC completa, modelagem de banco de dados, requisitos levantados

2026 Q2 — Estado da Arte (NP2)
  └─ Benchmarking, trabalhos relacionados, wireframes de alta fidelidade

2026 Q3/Q4 — Desenvolvimento e Entrega Final (NP3)
  └─ MVP funcional, validação com usuários reais, apresentação para banca
```

---

## 📐 Indicadores de Sucesso do MVP

- [ ] Cadastro e autenticação para os 3 perfis (cliente, freelancer, empresa)
- [ ] Fluxo completo: proposta → aceite → entrega → avaliação
- [x] Chat funcional entre cliente e freelancer (Socket.IO em tempo real)
- [ ] Pagamento via MercadoPago processado com saldo creditado na carteira
- [ ] 90 RFs e 42 RNFs cobertos na especificação
- [ ] Banco de dados com 50 tabelas implementado e validado

---

## 🚀 Começando (desenvolvimento)

Monorepo com **npm workspaces** — um `npm install` na raiz instala tudo.

```bash
npm install                 # instala api + web + packages
npm run db:up               # sobe o MySQL 8 (Docker) com schema + seed
npm run dev                 # sobe API (:3333) e Web (:5173) juntos
```

Scripts úteis na raiz: `npm run typecheck` (todos os pacotes), `npm run lint`, `npm run format`,
`npm run db:down`. O front usa proxy `/api → :3333` (sem CORS no dev) e os tipos de `@escambo/types`
são compartilhados entre back e front (sem duplicação).

---

## 🧪 Qualidade & Testes

A qualidade é garantida por uma **pirâmide de testes** somada a lint e type-check, tudo executado no
CI a cada push (badge no topo):

| Camada | O quê | Onde | Comando |
|---|---|---|---|
| **Unidade (API)** | Regras de negócio de cada serviço, com as _repositories_ mockadas (sem banco) — 20/20 módulos cobertos | `apps/api/src/**/*.test.ts` | `npm test` |
| **Integração (API)** | App Express **real** via Supertest contra um MySQL de verdade (`escambo_test` recriado a cada run): escrow ponta a ponta, autorização e chat | `apps/api/test/integration/**` | `npm run -w @escambo/api test:int` |
| **Componente (Web)** | Helpers, client HTTP (mock de `fetch`) e views React (Testing Library + jsdom) | `apps/web/src/**/*.test.tsx` | `npm test` |

```bash
npm test                          # unidade (API) + componente (Web) — sem banco
npm run -w @escambo/api test:int  # integração (precisa do MySQL no ar: npm run db:up)
```

No **CI** (`.github/workflows/ci.yml`) há dois jobs: **Lint · Typecheck · Test · Build** e
**Integração · Supertest + MySQL** (provisiona um serviço MySQL). Ambos precisam passar no PR.

---

## 📁 Estrutura do Repositório

```
escambo/
├── 📁 docs/
│   ├── RFC.md                  # Request for Comments — documento principal
│   ├── requisitos-funcionais.md
│   ├── requisitos-nao-funcionais.md
│   ├── modelagem-banco.md
│   └── diagramas/              # DER, fluxos, arquitetura
├── 📁 apps/
│   ├── web/                    # ✅ React + Vite + TS (frontend)
│   ├── mobile/                 # React Native + Expo (Fase 2)
│   └── api/                    # ✅ Node + Express + TS (backend em camadas)
│       └── db/                 # schema.sql + seed.sql (MySQL 8)
├── 📁 packages/
│   └── types/                  # ✅ @escambo/types — contratos compartilhados back/front
├── 📁 infra/
│   └── docker-compose.yml      # MySQL 8 local (schema + seed automáticos)
├── package.json                # raiz — npm workspaces + scripts
├── tsconfig.base.json          # TS compartilhado
├── eslint.config.mjs           # ESLint (flat) + Prettier
├── CONTRIBUTING.md
├── LICENSE
└── README.md
```

---

## 📄 Documentação

| Documento | Descrição |
|---|---|
| [📋 RFC Completa](./docs/RFC.md) | Request for Comments — proposta técnica completa |
| [✅ Requisitos Funcionais](./docs/requisitos-funcionais.md) | 90 RFs especificados |
| [🔒 Requisitos Não Funcionais](./docs/requisitos-nao-funcionais.md) | 42 RNFs especificados |
| [🗄️ Modelagem do Banco](./docs/modelagem-banco.md) | 50 tabelas MySQL |
| [⚖️ Regras de Negócio](./docs/regras-de-negocio.md) | 75 RNs especificadas |

---

## 🤝 Contribuindo

Este projeto segue um fluxo de trabalho em squads, simulando o ambiente de uma equipe ágil.

**Fluxo de contribuição:**

```bash
# 1. Fork do repositório
# 2. Crie uma branch com o padrão:
git checkout -b feat/nome-da-feature
# ou
git checkout -b fix/descricao-do-bug

# 3. Commit seguindo Conventional Commits:
git commit -m "feat: adiciona módulo de gamificação"

# 4. Abra um Pull Request para revisão do squad (QA cruzado)
```

Consulte o [CONTRIBUTING.md](./CONTRIBUTING.md) para diretrizes completas de revisão e padrões de código.

---

## 📜 Licença

Distribuído sob a licença **MIT**. Consulte o arquivo [LICENSE](./LICENSE) para mais informações.

Por ser um projeto voltado à comunidade, o repositório é e permanecerá **público e de acesso aberto**, em conformidade com as diretrizes do PAC Extensionista VII.

---

## 👤 Autor

Desenvolvido por **Guilherme Renzo** como projeto de TCC — PAC Extensionista VII  
Curso de Engenharia de Software · Católica SC · 2026

<div align="center">

[![LinkedIn](https://img.shields.io/badge/LinkedIn-seu--perfil-0077B5?style=for-the-badge&logo=linkedin&logoColor=white)](https://linkedin.com/in/https://www.linkedin.com/in/guilherme-renzo-284779271/)
[![GitHub](https://img.shields.io/badge/GitHub-seu--usuario-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/Guirenzo)

<br />

*"Tornar a contratação de serviços mais acessível, rápida e confiável — conectando freelancers e clientes com poucos toques, sem burocracia e com total transparência."*

</div>
