# Escambo

Marketplace de serviços que conecta **clientes** a **freelancers**: contratação com **escrow** (o dinheiro fica
retido até a entrega), **troca de serviço por serviço**, **créditos de tempo**, busca por **proximidade** e um
**índice de reputação explicável**. TCC da Católica SC (PAC Extensionista VII e VIII, Disciplina de Portfólio).

> Esta Wiki é gerada a partir da pasta `docs/` do repositório a cada push na `main`
> (workflow **Wiki**, `scripts/wiki-build.mjs`). Para corrigir uma página, edite o arquivo no repositório:
> o que for editado direto aqui é sobrescrito na próxima publicação.

## Por onde começar

| Quero…                                        | Página                                                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Entender como o sistema é montado             | [Arquitetura](Arquitetura)                                                                                             |
| Ver o que o sistema faz                       | [Requisitos Funcionais](Requisitos-Funcionais) · [Casos de Uso](Casos-de-Uso) · [Regras de Negócio](Regras-de-Negócio) |
| Saber por que foi feito assim                 | [Decisões de Arquitetura](Decisões-de-Arquitetura) (ADRs)                                                              |
| Rodar na minha máquina                        | [README](https://github.com/Guirenzo/Escambo#-rodar-em-2-minutos)                                                      |
| Pôr em produção ou atualizar                  | [Deploy e CI/CD](Deploy-e-CI-CD) · [Guia de Deploy](Guia-de-Deploy)                                                    |
| Conferir testes, cobertura e análise estática | [Qualidade](Qualidade)                                                                                                 |
| Acompanhar o sistema no ar                    | [Observabilidade](Observabilidade)                                                                                     |
| Contribuir                                    | [Como Contribuir](Como-Contribuir)                                                                                     |
| Ver o que mudou em cada versão                | [Changelog](Changelog)                                                                                                 |

## Em uma tela

- **Web:** React 18 + Vite + TypeScript, TanStack Query, Socket.IO (chat e avisos ao vivo), PWA com push.
- **API:** Node 22 + Express + TypeScript, Zod, mysql2, JWT com refresh rotativo, pino, Socket.IO, jobs internos.
- **Banco:** MySQL 8, baseline + migrations versionadas com ledger próprio.
- **Produção:** VPS com Docker Compose, imagens publicadas pelo CI no GHCR, Caddy com HTTPS automático,
  deploy contínuo pelo GitHub Actions, Prometheus + Grafana + sonda de uptime, erros no Sentry.
- **Qualidade:** ESLint, `tsc`, testes de unidade, integração (MySQL real) e ponta a ponta (Playwright),
  cobertura com meta no CI e SonarCloud.

## Documentação de produto (TCC)

[RFC](RFC) · [Requisitos Não Funcionais](Requisitos-Não-Funcionais) · [Modelagem do Banco](Modelagem-do-Banco) · [Personas](Personas) · [Fluxo de Navegação](Fluxo-de-Navegação) ·
[Wireframes](Wireframes) · [Benchmarking](Benchmarking) · [Trabalhos Relacionados](Trabalhos-Relacionados) · [Evidências de Validação](Evidências-de-Validação)
