# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versionamento
[semântico](https://semver.org/lang/pt-BR/). A versão que está no ar aparece em `GET /api/health`
(`version` e `commit`), e cada release publica as imagens `escambo-api` e `escambo-web` no GHCR
com as tags `latest`, o sha curto e a versão.

## [1.3.0] — 2026-09-10

### Adicionado

- **Identidade e instalação**: favicon SVG, ícones 192/512 (com variante _maskable_),
  `apple-touch-icon`, `site.webmanifest` (o app instala como PWA básica) e capa de
  compartilhamento (prévia do link em WhatsApp, LinkedIn e afins). Todos gerados a partir do
  SVG da marca por `scripts/gen-icons.mjs`.
- **Título por tela** (WCAG 2.4.2): a aba, o histórico e os favoritos passam a dizer onde a
  pessoa está ("Carteira · Escambo"), com o número de notificações não lidas quando houver.
  Uma região viva anuncia a troca de tela para leitores de tela, que o SPA antes fazia em silêncio.
- **Página 404**: endereço inexistente mostra uma página com saídas, em vez de redirecionar
  para a home em silêncio.
- **Cabeçalhos de segurança no nginx**: Content-Security-Policy fechada em `'self'`,
  Permissions-Policy, Referrer-Policy, X-Frame-Options e nosniff em toda resposta.

### Alterado

- **Fontes empacotadas** (`@fontsource`) no lugar do Google Fonts: nenhuma requisição sai para
  terceiros (privacidade, LGPD e uma CSP que pode ser restritiva), e a tipografia carrega junto
  com o app.
- **Índices do banco** (migration `0007`): as listas do produto (notificações, chat,
  contratações, extratos, depósitos e a fila de saques) passam a ter índices compostos
  `(dono, recência)`, que resolvem filtro e ordenação; os índices de coluna única que viraram
  prefixo foram removidos.
- **Dependências sem vulnerabilidade conhecida** (`npm audit` limpo, produção e desenvolvimento):
  nodemailer 10, vitest 5, react-router 7 e `qs` 6.16 fixado por `overrides`.

### Corrigido

- **Início**: a tabela de contratações mostra só as ações que avançam o contrato (aceitar,
  entregar, aprovar, avaliar) e cabe numa linha; recusar, cancelar, pedir revisão e abrir disputa
  ficam na Sala, onde há contexto. A saudação e a barra lateral usam o primeiro nome do perfil
  em vez da parte local do e-mail.
- Falha não tratada na API (`unhandledRejection` / `uncaughtException`) agora é registrada e
  encerra o processo drenando conexões, em vez de deixá-lo em estado desconhecido.

## [1.2.0] — 2026-09-10

### Adicionado

- **Publicação automática de imagens**: quarto job do CI (só em `main`, só com os três de teste
  verdes) constrói e publica `ghcr.io/guirenzo/escambo-api` e `escambo-web`.
- **Produção numa VPS**: `docker-compose.prod.yml` com imagens do registro fixadas por
  `IMAGE_TAG`, segredos obrigatórios, banco e API sem porta no host, e **Caddy** na borda
  (HTTPS automático, HTTP/3, HSTS). Guia completo em [DEPLOY.md](./DEPLOY.md).
- **Backup e restauração** do banco (`scripts/backup-db.sh`, `scripts/restore-db.sh`).
- `GET /api/health` devolve `version`, `commit` e `uptime`; o commit é gravado na imagem pelo CI.
- Primeira subida em banco vazio carrega o catálogo de referência pelo job de migrations.

### Alterado

- **Saque exige e-mail confirmado** (403 `email_not_verified`): é a única ação que tira dinheiro
  da plataforma. A Carteira mostra o bloqueio e o reenvio do link.

## [1.1.0] — 2026-08-24 a 2026-09-10

Monorepo (npm workspaces) com API, web e tipos compartilhados. Blocos entregues nesta linha:

| Data       | Bloco                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| 2026-09-10 | **Escrow por marcos** (RN-069): 2 a 10 marcos por contratação, liberação parcial, revisão e aprovação tácita por marco |
| 2026-09-09 | **E-mail transacional** com caixa de saída, confirmação de e-mail e recuperação de senha                               |
| 2026-09-09 | **LGPD**: cópia de dados baixável, exclusão por anonimização e fila do admin                                           |
| 2026-09-09 | **Torna da troca** reservada na carteira, liquidada com taxa e devolvida em recusa/disputa                             |
| 2026-09-09 | **Carteira pré-paga**: depósito PIX (gateway simulado), ledger de R$, reembolsos reais e fila de saques                |
| 2026-09-09 | **Contas e conformidade**: moderação imediata, consentimento no cadastro, páginas legais, avatar                       |
| 2026-09-09 | **Polimento do marketplace**: paginação, propor troca pelo card, Score responsivo, sair de todos os dispositivos       |
| 2026-09-09 | **Confiança**: disputas com mediação, painel admin, denúncia e moderação                                               |
| 2026-09-09 | **Engajamento**: notificações ao vivo, favoritos, busca por categoria e onboarding                                     |
| 2026-09-08 | **Ciclo completo**: sessão com refresh rotativo, ações por papel, revisão, aprovação tácita e perfil público           |
| 2026-09-08 | **Avaliações** que alimentam perfil, cards e Escambo Score                                                             |
| 2026-09-03 | **Stack completa** no Docker Compose, e2e com Playwright, dados de demonstração e README de produto                    |
| 2026-09-03 | **Redesign** do front: app shell com sidebar, sistema de design, telas dos quatro diferenciais                         |
| 2026-09-02 | **Quatro diferenciais** na API: créditos de tempo, descoberta local, Escambo Score e impulsionamento                   |
| 2026-09-02 | **Hardening** da API e runner de migrations forward-only                                                               |
| 2026-08-31 | **Chat em tempo real** (Socket.IO) e testes de integração com MySQL de verdade                                         |
| 2026-08-27 | Módulos de **favoritos, buscas salvas, denúncias, disputas, mediação e LGPD**                                          |

## [1.0.0] — 2026-08-24

Base do produto: autenticação com JWT, perfis, catálogo de serviços, contratações com escrow,
carteira, notificações e o schema das 50 tabelas com seed de referência.
