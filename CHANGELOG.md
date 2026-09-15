# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versionamento
[semântico](https://semver.org/lang/pt-BR/). A versão que está no ar aparece em `GET /api/health`
(`version` e `commit`), e cada release publica as imagens `escambo-api` e `escambo-web` no GHCR
com as tags `latest`, o sha curto e a versão.

## [1.23.0] — 2026-09-15

### Adicionado

- **Contestação de remoção de imagem** (ADR 41).
  - **No perfil**: o cartão "Moderação" lista as imagens removidas com motivo, nota, prazo e
    situação, e o dono contesta uma vez, dentro do prazo, com um texto de 20 a 1000 caracteres. O
    aviso da remoção já traz a data limite. `GET /api/moderation/removals` e
    `POST /api/moderation/removals/:id/appeal`.
  - **No painel admin**: fila de contestações pendentes e decididas, com a imagem guardada, o texto
    do dono e as remoções dele na janela. Manter apaga o arquivo; reverter devolve a imagem para
    onde estava, se o lugar continua vazio, tira do bloqueio e a remoção deixa de contar. O dono
    recebe notificação e e-mail com a nota. `GET /api/admin/appeals`,
    `GET /api/admin/appeals/:id/image` e `POST /api/admin/appeals/:id/uphold|overturn`.
  - **Quarentena**: a imagem removida sai do ar na hora, mas o arquivo fica em `DATA_DIR/quarantine`
    enquanto cabe contestação; o job `purge-quarantine` apaga o que não pode mais voltar.
- **Reincidência progressiva** (ADR 41).
  - Da segunda remoção em 180 dias, o envio de imagens fica bloqueado por 7 dias vezes as remoções
    depois da primeira (`403 uploads_restricted`, com a data de liberação), e o perfil mostra o
    bloqueio com o medidor de remoções.
  - Na terceira, a conta entra na fila de denúncias para revisão, uma vez enquanto a revisão estiver
    aberta, e o aviso da fila diz ao admin o que a remoção causou.
  - Prazo de contestação, janela, dias de bloqueio e limite de revisão são parâmetros do painel.
    Migration `0018_contestacao_reincidencia`.

### Alterado

- A cópia de dados da LGPD passa ao formato 1.2, com as imagens removidas e as contestações, e a
  anonimização apaga os arquivos em quarentena e o texto das contestações do titular.
- A resposta de `POST /api/admin/reports/:id/remove-image` ganha `removalId`, `ownerStrikes`,
  `uploadsBlockedUntil` e `accountReviewOpened`.

## [1.22.0] — 2026-09-15

### Adicionado

- **Galeria do portfólio** (ADR 40). No perfil público, cada trabalho com imagem abre em tela
  cheia, com título, contador, descrição e link do trabalho.
  - **Navegação**: botões, setas, Home e End ou deslizar no toque, em círculo. Esc fecha e o foco
    volta ao cartão, e a rolagem da página trava enquanto a galeria está aberta.
  - **Link direto**: o trabalho aberto fica na URL (`?trabalho=ID`), e o "voltar" do celular fecha
    a galeria em vez de sair do perfil.
  - **Imagem do tamanho da tela**: `srcset` com 480 px, 960 px e o original; a miniatura aparece
    desfocada enquanto a grande carrega, e as vizinhas são pedidas antes.
  - **API**: nova largura de miniatura, `GET /api/media/…?w=960`.

## [1.21.0] — 2026-09-15

### Adicionado

- **Moderação de imagens e fila de denúncias** (ADR 39).
  - **Denunciar foto e imagem do portfólio**: no perfil público, "Denunciar" pergunta se é o perfil
    ou a foto, e cada trabalho com imagem tem a própria bandeira. O modal mostra a imagem que vai
    para a moderação. A API guarda a imagem como estava na hora e recusa a própria imagem, alvo sem
    imagem e denúncia repetida.
  - **Fila de denúncias no painel admin**: denúncias de todos os tipos agrupadas por alvo e imagem,
    com dono, motivos contados, descrições e se a imagem ainda está no ar, em abas de pendentes e
    resolvidas. `GET /admin/reports` e `POST /admin/reports/:id/dismiss|resolve|remove-image`.
  - **Remover imagem**: a imagem sai de todo perfil e trabalho que a mostra, o arquivo e as
    miniaturas são apagados na hora, o dono recebe notificação e e-mail com o motivo e a nota, e a
    decisão fica nas ações do admin e na auditoria.
  - **Imagem removida não volta**: o envio é recusado (`image_blocked`) quando bate com a
    assinatura do arquivo ou com a impressão perceptual, o que pega a mesma foto reencodada ou
    reduzida. Migration `0017_moderacao_imagens`.

### Corrigido

- **Denúncias sem destino**: até aqui as denúncias eram gravadas, mas não apareciam em lugar
  nenhum do painel.

## [1.20.0] — 2026-09-15

### Adicionado

- **Recorte da foto de perfil e miniaturas** (ADR 38).
  - **Recorte**: escolher a foto abre a janela "Ajustar foto", com arrastar (mouse, toque ou
    setas), zoom (controle, botões, roda do mouse ou + e −) e a prévia do avatar redondo nos dois
    tamanhos em que ele aparece. A foto sobe já quadrada.
  - **A API processa a imagem**: decodifica e reencoda com a sharp. O avatar sai quadrado de até
    512 px, o portfólio cabe em 1600 px e GIF animado continua animado no portfólio. Tudo vira
    WebP, com a orientação da câmera aplicada e sem EXIF, XMP ou ICC. `POST /media` recebe
    `purpose` (`avatar` ou `portfolio`) e devolve largura e altura; imagem acima de 50 megapixels
    ou que não abre é 422.
  - **Miniaturas**: `GET /api/media/…?w=128` ou `?w=480` devolve a miniatura em WebP, gerada na
    primeira leitura e guardada ao lado do original, com o mesmo cache imutável. Vale também para
    as imagens enviadas antes desta versão. Avatares e o portfólio do perfil público passam a
    carregar a miniatura.
  - **Admin**: o card de armazenamento mostra quantas miniaturas existem, e o expurgo remove as
    miniaturas junto com as imagens que ninguém usa.

### Alterado

- **Diálogos com nome acessível**: todo modal passa a ser anunciado pelo título.
- A remoção manual de metadados por segmentos (ADR 36) saiu, porque a reencodagem já descarta
  tudo.

## [1.19.0] — 2026-09-15

### Adicionado

- **Frequência do alerta de busca salva** (ADR 37). Antes todo alerta era de hora em hora; agora
  cada busca escolhe.
  - **Na hora**: avisa na rodada seguinte dos jobs, em poucos minutos.
  - **De hora em hora**: o comportamento anterior, que continua como padrão e vale para as buscas
    que já existiam.
  - **Uma vez por dia**: um aviso no horário do resumo diário de e-mail (`DIGEST_HOUR`, em
    Brasília), com o título "Resumo do dia".
  - **Na tela**: salvar uma busca pede a frequência, e cada busca salva ganhou **Editar** (nome,
    alerta e frequência). O sino mostra a frequência no título, e desligar o alerta guarda a
    escolha.
  - **API**: `alertFrequency` (`instant`, `hourly` ou `daily`) no `POST` e no
    `PATCH /saved-searches`. Trocar a frequência mantém o cursor, então não repete nem pula
    serviço; `name: null` apaga o nome. Migration `0016_frequencia_alerta`.

### Corrigido

- **Cartão de e-mails do perfil com o radio acima do texto.** A lista de opções herdava o estilo global de rótulo, em coluna e negrito; agora o radio fica ao lado do texto, na cor da marca, e a dica volta ao peso normal. A frequência do alerta usa a mesma lista.
- **Cópia de dados (LGPD) sem as buscas salvas.** O arquivo exportado agora traz `buscasSalvas`,
  com texto, filtros, alerta e frequência, e passa ao formato `escambo-export/1.1`.

## [1.18.0] — 2026-09-15

### Adicionado

- **Foto de perfil e imagens do portfólio enviadas do aparelho** (ADR 36). Antes os dois campos
  só aceitavam link; agora têm o botão **Enviar foto** / **Enviar imagem**, e o link continua
  valendo.
  - **No navegador**: a imagem é reduzida para o tamanho de uso (512 px no avatar, 1600 px no
    portfólio), gira conforme a câmera e é reencodada em WebP, o que também descarta o EXIF com
    GPS. GIF vai como está.
  - **Na API**: `POST /media` aceita JPG, PNG, GIF ou WebP até 5 MB, reconhecidos pelo conteúdo,
    e remove de novo os metadados sem decodificar pixels: EXIF, XMP, IPTC e comentários do JPEG;
    eXIf e textos do PNG; EXIF e XMP do WebP. As imagens ficam em `DATA_DIR/media` e são
    servidas em `/api/media/AAAA/MM/<ULID>.<ext>`, públicas, com cache imutável de um ano e
    fora do rate limit.
  - **Perfil e portfólio** aceitam essa URL no lugar de um link externo; caminho inventado é 422.
  - **Expurgo**: imagem enviada que nenhum perfil ou portfólio usa há mais de um dia sai do
    disco. O card de armazenamento do admin mostra a pasta de mídia, e
    `scripts/backup-uploads.sh` passa a guardar `media/` junto com os anexos.

## [1.17.0] — 2026-09-15

### Adicionado

- **Buscas salvas com alerta** (ADR 35). A API de buscas salvas existia sem tela, sem aviso e
  com filtros em JSON livre; agora é recurso completo.
  - **Na busca**: botão **Salvar busca** (texto e filtros atuais, nome e "me avisar de serviços
    novos") e a linha de buscas salvas: aplicar com um clique, ligar/desligar o alerta e apagar.
  - **Job `saved-search-alerts`**: de hora em hora por busca, procura serviços criados desde o
    último aviso que casam com o texto e os filtros, fora os do próprio dono, e manda a
    notificação "3 serviços novos para “logo”" (também por e-mail, conforme a preferência).
    O link leva a `/servicos?busca=ID`, que reaplica a busca.
  - **API**: filtros validados (os mesmos da busca; chave desconhecida é 422), até 20 buscas por
    conta (409 `saved_search_limit`) e `PATCH /saved-searches/:id` para renomear e
    ligar/desligar. Ligar o alerta reinicia o cursor, sem despejar o catálogo antigo.
    Migration `0015` (índice do job).
  - **Notificações**: as que têm destino ganham o link "Abrir" (ou "Ver serviços") na tela de
    notificações, espelhando o link do e-mail.

## [1.16.0] — 2026-09-15

### Adicionado

- **Horário de atendimento** (ADR 34): por dia marcado, os períodos em que o freelancer atende
  (manhã 6h–12h, tarde 12h–18h, noite 18h–24h, horário de Brasília); dia sem período vale o dia
  todo. Migration `0014` (`profiles_freelancer.available_periods`, JSON).
  - **Perfil**: chips de período por dia marcado e a chave **Aceitando novos pedidos**, que pausa
    a agenda sem apagar os dias (antes todo salvamento religava a disponibilidade).
  - **Perfil público e card do serviço**: "atende seg a sex · manhã e tarde" e o selo
    **atende agora** (`availableNow` / `ownerAvailableNow`, calculados na hora).
  - **Busca**: filtro de período junto com o dia (`period`; sem `day` é 422
    `period_requires_day`) e o botão **Atende agora** (`now=true`): aceitando pedidos, no dia e
    no período de agora. De madrugada ninguém atende agora.

## [1.15.0] — 2026-09-15

### Adicionado

- **As chaves restantes de `platform_settings` ganharam efeito** (ADR 33), editáveis no painel
  com tipos (inteiro, decimal, liga/desliga):
  - **Modo de manutenção**: ligado, a API responde 503 `maintenance` (com `Retry-After`) para
    quem não é admin; health, login, parâmetros públicos e o painel admin continuam, e o admin
    passa em qualquer rota. O app mostra a tela "Estamos em manutenção" (tenta de novo sozinho)
    e o admin vê uma faixa lembrando de desligar.
  - **Trocas de serviço on/off**: desligadas, propor troca dá 403 `barter_disabled`; o app esconde
    "Propor troca" e avisa na tela de Trocas. Trocas já propostas seguem o fluxo.
  - **Saque mínimo** e **preço mínimo de serviço** lidos das settings (422 `below_minimum` /
    `price_below_minimum` com o valor vigente); a Carteira e o formulário de serviço mostram o
    mínimo atual.
  - `GET /settings/public` passa a trazer mínimos, trocas e manutenção. Leituras em caminhos
    quentes têm cache de 5 s, limpo no processo a cada mudança.

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
