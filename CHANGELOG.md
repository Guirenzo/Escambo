# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versionamento
[semântico](https://semver.org/lang/pt-BR/). A versão que está no ar aparece em `GET /api/health`
(`version` e `commit`), e cada release publica as imagens `escambo-api` e `escambo-web` no GHCR
com as tags `latest`, o sha curto e a versão.

## [1.14.0] — 2026-09-15

### Adicionado

- **Parâmetros da plataforma no painel admin** (ADR 32): comissão (%), aprovação tácita (dias),
  validade da proposta (horas), carência do prazo (horas) e retenção dos anexos (dias) — só o
  que a API lê em tempo de execução. `GET /admin/settings` e `PUT /admin/settings/:key` com
  limites por chave, autor e data, auditoria (`setting_updated`) e efeito imediato.
- **Comissão deixa de ser fixa no código**: contratações em dinheiro e a torna das trocas leem
  `platform_fee_percentage` na criação e gravam a taxa que valia; o modal de contratação e a
  tela de trocas mostram a taxa vigente (`GET /settings/public`).

## [1.13.0] — 2026-09-14

### Adicionado

- **Expurgo de anexos** (ADR 31): o arquivo de um anexo sai do disco, a mensagem fica e diz por
  quê (`ChatAttachment.purgedAt`/`purgedReason`; download responde 410 `attachment_purged`).
  - **Retenção**: anexos com mais de `platform_settings.attachment_retention_days` dias (180) em
    conversas **sem contratação aberta** entre as duas pessoas. Job `purge-attachments`, uma vez
    por dia a partir de `ATTACHMENT_PURGE_HOUR` (4h, Brasília), com a trava do último expurgo
    guardada em `platform_settings`.
  - **LGPD**: ao concluir a anonimização, os arquivos que o titular enviou saem na hora; o texto
    das mensagens fica e a bolha mostra "removido a pedido do titular".
  - **Órfãos**: arquivo no disco sem linha no banco há mais de 24 h é apagado; linha sem arquivo
    é marcada como indisponível no primeiro download.
  - **Painel admin**: card "Armazenamento" (`GET /admin/storage`) com anexos no disco, pasta de
    uploads, cópias LGPD, removidos, inconsistências, retenção e último expurgo; botão "Rodar
    expurgo agora" (`POST /admin/storage/purge`, auditado).
  - Migration `0013`: `messages.file_purged_at`, `file_purged_reason`, coluna gerada
    `has_file` com índice, e o parâmetro `attachment_retention_days`.

## [1.12.0] — 2026-09-14

### Adicionado

- **Busca por dia de atendimento** (ADR 30): filtro "Atende" na busca (`day=0..6`, com "(hoje)"
  marcado no dia atual) sobre os dias que o freelancer marcou no perfil — só entre quem informou,
  via `JSON_CONTAINS` em `profiles_freelancer.available_days`. O card do serviço mostra
  "atende seg a sex" (`Service.ownerAvailableDays`), e o Perfil avisa quem não marcou dia que
  fica fora desse filtro. Seed com dias variados (Carla só fim de semana, Felipe sem informar).

## [1.11.1] — 2026-09-14

### Corrigido

- **Abrir a Sala podia dar 500 na conversa**: o histórico (REST) e o `contract:join` (socket)
  chegam juntos e os dois tentavam criar a conversa do par; o segundo tomava
  `Duplicate entry` — e uma mensagem enviada nesse instante falhava. A criação virou um único
  `INSERT … ON DUPLICATE KEY UPDATE` (atômico), coberto por teste de integração concorrente.
  Corrida pré-existente, exposta pelo e2e mobile do CI na 1.11.0 (cujas imagens não foram
  publicadas; use a 1.11.1).

## [1.11.0] — 2026-09-14

### Adicionado

- **Anexos no chat** (ADR 29): imagem (JPG, PNG, GIF, WebP) ou arquivo (PDF, ZIP — e docx/xlsx,
  que são ZIP por dentro) por mensagem, com legenda opcional, até `UPLOAD_MAX_MB` (10 MB).
  - `POST /messaging/contracts/:id/attachments` (multipart) e `GET /messaging/attachments/:id`,
    só para as partes do contrato. O tipo é reconhecido pelos **primeiros bytes**: Content-Type e
    extensão declarados são ignorados (HTML disfarçado de PNG e SVG são recusados com 422).
  - Arquivos no volume da API (`DATA_DIR/uploads/AAAA/MM/<ulid>.<ext>`), servidos com o token,
    `Content-Disposition` inline (imagem) ou attachment (arquivo), nome de download limpo e com a
    extensão real. Migration `0012` (`messages.file_mime`).
  - Sala: botão de clipe, colar da área de transferência e arrastar sobre o chat; prévia antes de
    enviar; imagem em miniatura que abre em tamanho real; cartão de arquivo com nome, tamanho e
    download.
  - Notificação "Enviou uma imagem" / "Enviou o arquivo …" quando não há legenda; a cópia de dados
    LGPD passa a listar nome e tamanho dos anexos.
  - `scripts/backup-uploads.sh`: os anexos vivem fora do banco e entram no backup. O nginx aceita
    corpo de 25 MB em `/api/` e a CSP permite `blob:` em `img-src`.

### Alterado

- `ChatMessage` ganha `type` (`text` | `image` | `file`) e `attachment` (`name`, `mime`,
  `size`, `url`).

## [1.10.0] — 2026-09-14

### Adicionado

- **Perfil do freelancer mais rico** (ADR 28):
  - **Portfólio**: até 12 trabalhos com imagem e/ou link, editados no Perfil e exibidos numa
    galeria no perfil público. `GET/POST /profiles/portfolio`, `PUT/DELETE /profiles/portfolio/:id`;
    a tabela `freelancer_portfolio_items` do baseline finalmente tem uso.
  - **Dias em que atende**: chips de segunda a domingo no Perfil; o público mostra "atende seg a
    sex". Migration `0011` (`profiles_freelancer.available_days`, JSON).
  - **Tempo de resposta visível**: o chat já calculava a média móvel para o Score; agora o
    perfil público diz "responde em 2 h" (ou "menos de 1 h", "1 dia").

## [1.9.0] — 2026-09-14

### Adicionado

- **Preferência de e-mail e resumo diário** (ADR 27). No Perfil, cada pessoa escolhe: **a cada
  evento** (padrão, como era), **resumo diário** (um e-mail por dia, a partir de `DIGEST_HOUR`
  em Brasília, com as notificações desde o resumo anterior) ou **só o essencial** (confirmação
  de e-mail e redefinição de senha). As notificações no app não mudam.
  `GET/PUT /notifications/preferences`, template `digest` na caixa de saída, job
  `daily-digest` com trava de um por dia (`users.last_digest_at`). Migration `0010`.

## [1.8.0] — 2026-09-14

### Adicionado

- **Busca com filtros e ordenação**. Além do texto, da categoria e do "perto de mim" com raio:
  faixa de preço, prazo máximo (3/7/15/30 dias), nota mínima do prestador (3+/4+/4,5+) e
  ordenação por relevância (destaque + recência, ou destaque + proximidade), menor/maior
  preço, melhor avaliados, mais recentes e, com localização, mais perto. Aplicam na hora, com
  "Limpar filtros" e estado vazio específico. Destaque (impulsionamento) só manda na
  relevância: quem pede "menor preço" recebe o menor preço. Serviço "a combinar" (sem preço)
  fica de fora quando há filtro de preço e vai para o fim nas ordenações por preço.
  `GET /services?minPrice&maxPrice&maxDeliveryDays&minRating&sort`.

## [1.7.0] — 2026-09-14

### Adicionado

- **Financeiro do admin**. O painel tinha só totais acumulados; agora há um relatório por
  período (por dia ou por mês, presets de 30 dias, 6 e 12 meses ou datas livres):
  - **Receita da plataforma derivada do ledger de R$**: −Σ(disponível + retido) das linhas que
    não são depósito nem saque. Fecha centavo a centavo com a liquidação de cada contratação,
    inclusive quando cancelamento ou disputa devolve parte da taxa (ADR 26).
  - Depósitos, saques (líquidos de estornos), reembolsos, contratações em dinheiro concluídas e
    GMV, com gráfico de barras e tabela; fotografia do escrow e do saldo dos usuários.
  - **Exportação do ledger em CSV** (ponto e vírgula, vírgula decimal, BOM: abre direto no
    Excel pt-BR), registrada como ação do admin. `GET /admin/finance` e
    `GET /admin/finance/export.csv`.

## [1.6.0] — 2026-09-14

### Adicionado

- **Marcos em créditos Escambo** (RN-069 + créditos). Até aqui os marcos só existiam em dinheiro.
  - Contratar em créditos aceita "Dividir em marcos": marcos inteiros, sem taxa, somando os
    créditos da contratação; "Dividir igualmente" reparte em inteiros (o último absorve a sobra).
  - Aceite retém todos os créditos e financia os marcos; cada marco aprovado (ou aprovado
    tacitamente) libera só os seus créditos, com linha no ledger; o último conclui.
  - Cancelar e disputar liquidam só os créditos dos marcos ainda abertos.
  - Sala e notificações falam em créditos ("50 créditos liberados") quando a contratação é em
    créditos; demo com "Manutenção elétrica em 2 visitas (em créditos)".

## [1.5.0] — 2026-09-14

### Adicionado

- **Prazo por marco** (RN-069 + RN-029). `due_at` existia e nunca era preenchido.
  - **Contratar**: cada marco ganha um prazo opcional; "Distribuir prazos" espalha os prazos por
    igual até o prazo da contratação (o último cai nele). A API valida: no futuro, em ordem e
    nunca depois do prazo da contratação.
  - **Sala**: cada marco mostra "até dd/mm" e, enquanto está em escrow, "faltam N dias" ou
    "atrasado há N dias"; marco entregue depois do prazo aparece como "entregue com atraso".
  - **Job**: marco financiado com prazo vencido avisa as duas partes uma vez
    (`milestone_overdue`, também por e-mail). Não abre disputa: a mediação automática continua
    sendo pelo prazo da contratação. Migration `0009`.

## [1.4.0] — 2026-09-11

### Adicionado

- **Prazo de entrega com regra** (RN-021, RN-028, RN-029). O campo `deadline_at` existia e alimentava
  o Score, mas nada o definia nem o cobrava.
  - **Contratar** pede o prazo (sugerido pelo prazo do serviço); a Sala mostra quanto falta ou há
    quanto tempo estourou; o Início mostra "faltam N dias" na contratação.
  - **Extensão única** (RN-028): o freelancer pede pela Sala, com novo prazo e motivo; o cliente
    aceita ou recusa. Aceitar troca o prazo, registra na linha do tempo e trava a segunda extensão.
    `POST /contracts/:id/extension` e `/extension/accept|decline`.
  - **Proposta expira** (RN-021): job `expire-proposals` encerra propostas sem resposta em
    `proposal_expiry_hours` (padrão 72) e devolve a reserva ao cliente; os dois são avisados.
  - **Prazo estourado** (RN-029): job `overdue-contracts` avisa as duas partes uma vez e,
    `deadline_grace_hours` (padrão 24) depois sem entrega nem extensão aprovada, abre a disputa em
    nome do cliente (motivo "prazo") — o escrow congela até a mediação. Pedido de extensão
    pendente segura o job: a decisão é do cliente.
  - Notificações e e-mails: `contract_expired`, `contract_overdue`,
    `deadline_extension_requested|accepted|declined`.
  - Migration `0008`: colunas da extensão e do aviso, índices das varreduras, parâmetros em
    `platform_settings`.

### Corrigido

- `deadline_at` e `due_at` (marcos) chegavam ao MySQL como string ISO e eram recusados; como
  nenhuma tela enviava prazo, o erro nunca tinha aparecido. O repositório passa `Date`.

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
