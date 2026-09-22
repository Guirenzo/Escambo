/* eslint-disable @typescript-eslint/no-explicit-any */
// Documento OpenAPI 3.0 da API do Escambo (RNF-010). Servido em /api/openapi.json e /api/docs.

const bearer = [{ bearerAuth: [] as string[] }];
const res200 = { '200': { description: 'OK' } };
const res201 = { '201': { description: 'Criado' } };
const res204 = { '204': { description: 'Sem conteúdo' } };

function op(
  tag: string,
  summary: string,
  opts: { auth?: boolean; responses?: Record<string, unknown>; body?: unknown } = {},
): Record<string, unknown> {
  const o: Record<string, unknown> = {
    tags: [tag],
    summary,
    responses: opts.responses ?? { ...res200 },
  };
  if (opts.auth) o.security = bearer;
  if (opts.body) {
    o.requestBody = {
      required: true,
      content: { 'application/json': { schema: opts.body } },
    };
  }
  return o;
}

const obj = (properties: Record<string, unknown>, required?: string[]) => ({
  type: 'object',
  ...(required ? { required } : {}),
  properties,
});

export const openapiDocument: Record<string, any> = {
  openapi: '3.0.3',
  info: {
    title: 'Escambo API',
    version: '1.1.0',
    description:
      'API do Escambo — marketplace de serviços com escrow, gamificação e troca de serviços (escambo). Autenticação via Bearer JWT.',
  },
  servers: [{ url: '/api', description: 'API' }],
  tags: [
    { name: 'Health' },
    { name: 'Auth' },
    { name: 'Perfis' },
    { name: 'Categorias' },
    { name: 'Serviços' },
    { name: 'Contratações' },
    { name: 'Carteira' },
    { name: 'Impulsionamento' },
    { name: 'Saques' },
    { name: 'Avaliações' },
    { name: 'Gamificação' },
    { name: 'Troca (Escambo)' },
    { name: 'Notificações' },
    { name: 'Trust & Safety' },
    { name: 'Disputas' },
    { name: 'Admin' },
    { name: 'LGPD' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      Error: obj({ error: { type: 'string' }, message: { type: 'string' } }),
      Register: obj(
        {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 8 },
          role: { type: 'string', enum: ['client', 'freelancer', 'company'] },
          timezone: {
            type: 'string',
            enum: [
              'America/Noronha',
              'America/Sao_Paulo',
              'America/Cuiaba',
              'America/Manaus',
              'America/Rio_Branco',
            ],
            description:
              'Fuso do aparelho (ADR 51); sem ele a conta fica em Brasília e marcada como não escolhida (timezoneChosen)',
          },
        },
        ['email', 'password'],
      ),
      Login: obj({ email: { type: 'string' }, password: { type: 'string' } }, [
        'email',
        'password',
      ]),
      CreateService: obj(
        {
          categoryId: { type: 'integer' },
          title: { type: 'string' },
          description: { type: 'string' },
          priceType: { type: 'string', enum: ['fixed', 'hourly', 'negotiable'] },
          price: { type: 'number', nullable: true },
          deliveryDays: { type: 'integer', nullable: true },
          isRemote: { type: 'boolean' },
        },
        ['categoryId', 'title', 'description'],
      ),
      CreateContract: obj(
        {
          freelancerId: { type: 'integer' },
          serviceId: { type: 'integer', nullable: true },
          title: { type: 'string' },
          description: { type: 'string' },
          price: { type: 'number', minimum: 10 },
          deadlineAt: { type: 'string', format: 'date-time', nullable: true },
        },
        ['freelancerId', 'title', 'description', 'price'],
      ),
      CreateBarter: obj(
        {
          receiverId: { type: 'integer' },
          offeredServiceId: { type: 'integer', nullable: true },
          offeredDescription: { type: 'string', nullable: true },
          requestedServiceId: { type: 'integer', nullable: true },
          requestedDescription: { type: 'string', nullable: true },
          estimatedValueOffered: { type: 'number' },
          estimatedValueRequested: { type: 'number' },
        },
        ['receiverId', 'estimatedValueOffered', 'estimatedValueRequested'],
      ),
      CreateDeposit: obj(
        { amount: { type: 'number', minimum: 10 }, method: { type: 'string', enum: ['pix'] } },
        ['amount'],
      ),
      PaymentWebhook: obj(
        {
          event: { type: 'string' },
          gatewayPaymentId: { type: 'string' },
          status: { type: 'string', enum: ['paid', 'failed'] },
        },
        ['gatewayPaymentId', 'status'],
      ),
      CreateWithdrawal: obj(
        {
          amount: { type: 'number', minimum: 20 },
          method: { type: 'string', enum: ['pix', 'bank'] },
          pixKey: { type: 'string', nullable: true },
        },
        ['amount', 'method'],
      ),
      ResolveDispute: obj(
        {
          resolution: {
            type: 'string',
            enum: ['refund_client', 'release_freelancer', 'partial_split'],
          },
          refundPercentage: { type: 'integer', minimum: 0, maximum: 100, nullable: true },
          note: { type: 'string', nullable: true },
        },
        ['resolution'],
      ),
    },
  },
  paths: {
    '/health': { get: op('Health', 'Readiness — status da API + ping no banco') },
    '/health/live': { get: op('Health', 'Liveness — processo responde (sem tocar no banco)') },

    '/auth/register': {
      post: op('Auth', 'Cria conta', {
        body: { $ref: '#/components/schemas/Register' },
        responses: res201,
      }),
    },
    '/auth/login': {
      post: op('Auth', 'Autentica (accessToken + refreshToken)', {
        body: { $ref: '#/components/schemas/Login' },
      }),
    },
    '/auth/refresh': { post: op('Auth', 'Rotaciona o refresh token') },
    '/auth/logout': { post: op('Auth', 'Revoga a sessão') },
    '/auth/logout-all': {
      post: op('Auth', 'Encerra todas as sessões', { auth: true, responses: res200 }),
    },
    '/auth/me': { get: op('Auth', 'Dados do usuário do token', { auth: true }) },

    '/categories': { get: op('Categorias', 'Árvore de categorias') },

    '/profiles/me': { get: op('Perfis', 'Meus perfis', { auth: true }) },
    '/profiles/freelancer': {
      put: op('Perfis', 'Cria/edita perfil de freelancer', { auth: true }),
    },
    '/profiles/client': { put: op('Perfis', 'Cria/edita perfil de cliente', { auth: true }) },
    '/profiles/portfolio': {
      get: op('Perfis', 'Meu portfólio', { auth: true }),
      post: op('Perfis', 'Adiciona item ao portfólio (máx. 12; imagem e/ou link)', { auth: true }),
    },
    '/profiles/portfolio/order': {
      put: op(
        'Perfis',
        'Reordena o portfólio: ids de todos os trabalhos, do primeiro ao último (409 portfolio_order_mismatch se a lista não bate com o portfólio de agora)',
        {
          auth: true,
          body: obj({ ids: { type: 'array', items: { type: 'integer' } } }, ['ids']),
        },
      ),
    },
    '/profiles/portfolio/{id}': {
      put: op('Perfis', 'Edita item do portfólio', { auth: true }),
      delete: op('Perfis', 'Remove item do portfólio', { auth: true }),
    },
    '/profiles/freelancer/{ulid}': {
      get: {
        ...op('Perfis', 'Perfil público do freelancer (nota + nível)'),
        parameters: [{ name: 'ulid', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },

    '/services': {
      get: op(
        'Serviços',
        'Lista/busca serviços (categoryId, q, isRemote, minPrice/maxPrice, maxDeliveryDays, minRating, day=0..6 (atende no dia), period=morning|afternoon|evening (com day; dia e período valem no fuso de cada freelancer), now=true (atende agora, no fuso de cada freelancer — ADR 48), sort, page, limit; lat+lng+radiusKm = descoberta local por proximidade)',
      ),
      post: op('Serviços', 'Cria serviço', {
        auth: true,
        body: { $ref: '#/components/schemas/CreateService' },
        responses: res201,
      }),
    },
    '/services/{id}': {
      get: op('Serviços', 'Detalhe do serviço'),
      patch: op('Serviços', 'Atualiza (dono)', { auth: true }),
      delete: op('Serviços', 'Remove (dono, soft delete)', { auth: true, responses: res204 }),
    },

    '/contracts': {
      get: op('Contratações', 'Minhas contratações', { auth: true }),
      post: op('Contratações', 'Cria proposta (taxa 15%)', {
        auth: true,
        body: { $ref: '#/components/schemas/CreateContract' },
        responses: res201,
      }),
    },
    '/contracts/{id}': { get: op('Contratações', 'Detalhe + histórico', { auth: true }) },
    '/contracts/{id}/accept': {
      post: op('Contratações', 'Freelancer aceita (financia escrow)', { auth: true }),
    },
    '/contracts/{id}/reject': { post: op('Contratações', 'Freelancer recusa', { auth: true }) },
    '/contracts/{id}/deliver': { post: op('Contratações', 'Registra entrega', { auth: true }) },
    '/contracts/{id}/approve': {
      post: op('Contratações', 'Cliente aprova (libera escrow)', { auth: true }),
    },
    '/contracts/{id}/cancel': {
      post: op('Contratações', 'Cancela (reembolso RN-025)', { auth: true }),
    },
    '/notifications/preferences': {
      get: op(
        'Notificações',
        'Preferência de e-mail (instant | daily | off), hora do resumo do dia (digestHour, 0 a 23; sem escolha, a hora padrão) e fuso da conta (timezone, um dos fusos do Brasil; sem escolha, America/Sao_Paulo)',
        { auth: true },
      ),
      put: op(
        'Notificações',
        'Muda a frequência dos e-mails, a hora do resumo do dia e/ou o fuso da conta; hora e fuso valem para o e-mail diário, para os alertas diários das buscas salvas e para as datas nos avisos (null volta ao padrão)',
        {
          auth: true,
          body: obj({
            emailFrequency: { type: 'string', enum: ['instant', 'daily', 'off'] },
            digestHour: { type: 'integer', minimum: 0, maximum: 23, nullable: true },
            timezone: {
              type: 'string',
              enum: [
                'America/Noronha',
                'America/Sao_Paulo',
                'America/Cuiaba',
                'America/Manaus',
                'America/Rio_Branco',
              ],
              nullable: true,
            },
          }),
        },
      ),
    },
    '/admin/finance': {
      get: op(
        'Admin',
        'Relatório financeiro por período (receita do ledger, depósitos, saques, reembolsos, GMV)',
        { auth: true },
      ),
    },
    '/admin/finance/export.csv': {
      get: op('Admin', 'Ledger de R$ do período em CSV', { auth: true }),
    },
    '/contracts/{id}/extension': {
      post: op('Contratações', 'Freelancer pede a única extensão de prazo (RN-028)', {
        auth: true,
      }),
    },
    '/contracts/{id}/extension/{decision}': {
      post: op('Contratações', 'Cliente aceita (accept) ou recusa (decline) a extensão', {
        auth: true,
      }),
    },
    '/contracts/{id}/milestones/{milestoneId}/deliver': {
      post: op('Contratações', 'Marco: freelancer entrega (RN-069)', { auth: true }),
    },
    '/contracts/{id}/milestones/{milestoneId}/approve': {
      post: op('Contratações', 'Marco: cliente aprova e libera só aquele valor; o último conclui', {
        auth: true,
      }),
    },
    '/contracts/{id}/milestones/{milestoneId}/request-revision': {
      post: op('Contratações', 'Marco: cliente pede revisão', { auth: true }),
    },

    '/auth/verify-email': { post: op('Auth', 'Confirma o e-mail pelo token do link (uso único)') },
    '/auth/resend-verification': {
      post: op('Auth', 'Reenvia o link de confirmação', { auth: true }),
    },
    '/auth/forgot-password': {
      post: op(
        'Auth',
        'Esqueci minha senha: envia link de redefinição (resposta igual exista ou não a conta)',
      ),
    },
    '/auth/reset-password': {
      post: op('Auth', 'Define nova senha pelo token; encerra todas as sessões', {
        responses: res204,
      }),
    },
    '/admin/emails': {
      get: op('Admin', 'Caixa de saída de e-mails (limit, userId)', { auth: true }),
    },

    '/wallet': {
      get: op('Carteira', 'Saldo R$ + créditos Escambo (disponível e em escrow)', { auth: true }),
    },
    '/wallet/transactions': {
      get: op('Carteira', 'Extrato de R$ (depósitos, reservas, escrow, reembolsos, saques)', {
        auth: true,
      }),
    },
    '/wallet/deposits': {
      get: op('Carteira', 'Meus depósitos', { auth: true }),
      post: op('Carteira', 'Gera cobrança PIX de depósito na carteira', {
        auth: true,
        body: { $ref: '#/components/schemas/CreateDeposit' },
        responses: res201,
      }),
    },
    '/wallet/deposits/{id}': { get: op('Carteira', 'Situação da cobrança', { auth: true }) },
    '/wallet/deposits/{id}/simulate': {
      post: op('Carteira', 'Demo: confirma a cobrança sem gateway (PAYMENTS_SIMULATE)', {
        auth: true,
      }),
    },
    '/payments/webhook': {
      post: op('Carteira', 'Webhook do gateway (header x-webhook-secret)', {
        body: { $ref: '#/components/schemas/PaymentWebhook' },
      }),
    },
    '/credits/transactions': {
      get: op('Carteira', 'Extrato de créditos Escambo (time-bank)', { auth: true }),
    },
    '/boosts/plans': {
      get: op('Impulsionamento', 'Planos de impulsionamento (custo em créditos)', { auth: true }),
    },
    '/boosts': {
      get: op('Impulsionamento', 'Meus impulsionamentos', { auth: true }),
      post: op('Impulsionamento', 'Impulsiona um serviço meu (paga em créditos)', {
        auth: true,
        responses: res201,
      }),
    },
    '/withdrawals': {
      get: op('Saques', 'Meus saques', { auth: true }),
      post: op('Saques', 'Solicita saque (mín. R$20)', {
        auth: true,
        body: { $ref: '#/components/schemas/CreateWithdrawal' },
        responses: res201,
      }),
    },
    '/withdrawals/{id}/cancel': {
      post: op('Saques', 'Cancela saque ainda não processado (valor volta)', { auth: true }),
    },

    '/reviews': {
      get: op('Avaliações', 'Avaliações de um freelancer (freelancerId)'),
      post: op('Avaliações', 'Avalia contratação concluída', { auth: true, responses: res201 }),
    },
    '/reviews/{id}/response': {
      post: op('Avaliações', 'Freelancer responde', { auth: true, responses: res201 }),
    },

    '/gamification/me': {
      get: op('Gamificação', 'XP, nível, progresso, streak, ranking, badges', { auth: true }),
    },
    '/gamification/me/history': { get: op('Gamificação', 'Feed de XP', { auth: true }) },
    '/gamification/leaderboard': { get: op('Gamificação', 'Ranking por XP', { auth: true }) },

    '/barters': {
      get: op('Troca (Escambo)', 'Minhas trocas', { auth: true }),
      post: op('Troca (Escambo)', 'Propõe troca (torna + taxa)', {
        auth: true,
        body: { $ref: '#/components/schemas/CreateBarter' },
        responses: res201,
      }),
    },
    '/barters/{id}': { get: op('Troca (Escambo)', 'Detalhe da troca', { auth: true }) },
    '/barters/{id}/accept': {
      post: op(
        'Troca (Escambo)',
        'Aceita a troca (gera 2 contratos recíprocos; reserva a torna se o receptor paga — 402 sem saldo)',
        { auth: true },
      ),
    },

    '/notifications': {
      get: op('Notificações', 'Minhas notificações + não lidas', { auth: true }),
    },
    '/notifications/read-all': {
      post: op('Notificações', 'Marca todas como lidas', { auth: true }),
    },

    '/messaging/contracts/{id}': {
      get: op('Chat', 'Histórico do chat do contrato (partes)', { auth: true }),
      post: op(
        'Chat',
        'Envia mensagem (persiste + broadcast Socket.IO). Texto com sinal de negociação por fora (chave Pix, CPF, telefone, e-mail, WhatsApp, "por fora") sai com signals para as duas partes e entra sozinho na fila de denúncias, sem ser barrado (ADR 45)',
        { auth: true, responses: res201 },
      ),
    },
    '/messaging/contracts/{id}/attachments': {
      post: op(
        'Chat',
        'Envia imagem ou arquivo (multipart: file + content opcional). JPG, PNG, GIF, WebP, PDF ou ZIP, reconhecidos pelo conteúdo, até UPLOAD_MAX_MB',
        { auth: true, responses: res201 },
      ),
    },
    '/messaging/attachments/{id}': {
      get: op('Chat', 'Baixa o anexo de uma mensagem (só as partes do contrato)', { auth: true }),
    },

    '/favorites': {
      get: op('Trust & Safety', 'Meus favoritos', { auth: true }),
      post: op('Trust & Safety', 'Favoritar serviço/freelancer', { auth: true, responses: res201 }),
    },
    '/saved-searches': {
      get: op('Serviços', 'Minhas buscas salvas', { auth: true }),
      post: op(
        'Serviços',
        'Salva a busca (texto + filtros da busca de serviços; até 20 por conta; alertEnabled liga o aviso de serviço novo e alertFrequency escolhe instant, hourly ou daily, padrão hourly)',
        { auth: true, responses: res201 },
      ),
    },
    '/saved-searches/{id}': {
      patch: op(
        'Serviços',
        'Renomeia (null apaga o nome), liga/desliga o alerta (ligar reinicia o cursor) e troca a frequência (o cursor fica)',
        {
          auth: true,
        },
      ),
      delete: op('Serviços', 'Apaga a busca salva', { auth: true }),
    },
    '/reports': {
      post: op(
        'Trust & Safety',
        'Denunciar conteúdo, usuário ou imagem (avatar e portfolio_item guardam a imagem denunciada; recusa a própria imagem, alvo sem imagem e denúncia repetida)',
        { auth: true, responses: res201 },
      ),
    },
    '/admin/reports': {
      get: op(
        'Admin',
        'Fila de moderação: denúncias pendentes ou resolvidas (?status=pending|resolved), agrupadas por alvo e imagem; automatic marca o grupo com sinalização automática de negociação por fora (ADR 45)',
        { auth: true },
      ),
    },
    '/admin/reports/{id}/{action}': {
      post: op(
        'Admin',
        'dismiss, resolve, remove-image ou remove-content no grupo da denúncia, com nota. remove-content tira do ar a avaliação (recalcula a nota) ou a mensagem (aviso no chat), registra a remoção contestável com o texto e avisa o autor (ADR 44). remove-image tira a imagem de todo perfil e trabalho, guarda o arquivo em quarentena, bloqueia o reenvio, registra a remoção contestável e avisa o dono com o prazo; devolve as remoções do dono na janela, o bloqueio de envio e se a conta foi para revisão (ADR 41)',
        { auth: true },
      ),
    },
    '/moderation/removals': {
      get: op(
        'Trust & Safety',
        'Minhas imagens removidas pela moderação, com motivo, prazo e situação da contestação, e a reincidência: remoções na janela, limite de revisão e bloqueio de envio',
        { auth: true },
      ),
    },
    '/moderation/removals/{id}/appeal': {
      post: op(
        'Trust & Safety',
        'Contesta a remoção com um texto de 20 a 1000 caracteres, uma vez e dentro do prazo (404 removal_not_found, 409 appeal_exists, 410 appeal_window_closed)',
        {
          auth: true,
          body: obj({ text: { type: 'string', minLength: 20, maxLength: 1000 } }, ['text']),
        },
      ),
    },
    '/admin/appeals': {
      get: op(
        'Admin',
        'Contestações pendentes (das mais antigas) ou decididas (?status=pending|decided), com dono, texto e remoções na janela',
        { auth: true },
      ),
    },
    '/admin/appeals/{id}/image': {
      get: op('Admin', 'Imagem guardada em quarentena, sem cache, para decidir a contestação', {
        auth: true,
      }),
    },
    '/admin/appeals/{id}/{decision}': {
      post: op(
        'Admin',
        'uphold mantém a remoção e apaga o arquivo guardado; overturn devolve o arquivo, recoloca a imagem onde o lugar continua vazio, tira do bloqueio e a remoção deixa de contar. Nota opcional e dono avisado (409 appeal_not_pending)',
        { auth: true },
      ),
    },

    '/disputes': {
      get: op('Disputas', 'Minhas disputas', { auth: true }),
      post: op('Disputas', 'Abre disputa de contrato', { auth: true, responses: res201 }),
    },
    '/disputes/{id}': { get: op('Disputas', 'Detalhe da disputa', { auth: true }) },

    '/media': {
      post: op(
        'Perfil',
        'Envia imagem para avatar ou portfólio (multipart file + purpose avatar|portfolio, padrão portfolio; JPG, PNG, GIF ou WebP até 5 MB e 50 MP). A API reencoda em WebP orientado e sem metadados: avatar quadrado de até 512 px, portfólio de até 1600 px. Devolve URL, largura e altura. 422 image_blocked para imagem removida pela moderação e 403 uploads_restricted durante o bloqueio por reincidência',
        { auth: true, responses: res201 },
      ),
    },
    '/media/{year}/{month}/{file}': {
      get: op(
        'Perfil',
        'Imagem pública de perfil ou portfólio (cache imutável de um ano); ?w=128, ?w=480 ou ?w=960 devolve a miniatura em WebP, gerada na primeira leitura',
      ),
    },
    '/admin/metrics': { get: op('Admin', 'Métricas da plataforma', { auth: true }) },
    '/admin/moderation/health': {
      get: op(
        'Admin',
        'Saúde da moderação (ADR 47): fila e contestações esperando agora e, no período (?days=1..365, padrão 30), decisões com mediana e p90 do tempo até decidir, sinalizações automáticas por resultado e por sinal com o acerto, contestações mantidas e revertidas e remoções por tipo, mais a série por dia (Brasília) e a meta de tempo (moderation_sla_hours, ADR 50)',
        { auth: true },
      ),
    },
    '/admin/storage': {
      get: op('Admin', 'Uso do volume: anexos do chat, cópias LGPD, órfãos e último expurgo', {
        auth: true,
      }),
    },
    '/settings/public': {
      get: op(
        'Plataforma',
        'Parâmetros públicos: comissão (%), aprovação tácita (dias), validade da proposta (horas), mínimos de serviço e saque (R$), trocas ligadas, modo de manutenção',
      ),
    },
    '/admin/settings': {
      get: op('Admin', 'Parâmetros editáveis: valor atual, limites, padrão e último autor', {
        auth: true,
      }),
    },
    '/admin/settings/{key}': {
      put: op(
        'Admin',
        'Muda um parâmetro (inteiro, decimal ou liga/desliga, dentro dos limites; auditado; efeito imediato)',
        { auth: true },
      ),
    },
    '/admin/storage/purge': {
      post: op('Admin', 'Roda o expurgo de anexos agora (retenção + órfãos)', { auth: true }),
    },
    '/admin/disputes': { get: op('Admin', 'Disputas abertas', { auth: true }) },
    '/admin/disputes/{id}/resolve': {
      post: op('Admin', 'Resolve disputa (decisão de escrow)', {
        auth: true,
        body: { $ref: '#/components/schemas/ResolveDispute' },
      }),
    },
    '/admin/users/{ulid}/ban': {
      post: op('Admin', 'Bane usuário', { auth: true, responses: res204 }),
    },
    '/admin/withdrawals': {
      get: op('Admin', 'Fila de saques (status=open|all|…)', { auth: true }),
    },
    '/admin/withdrawals/{id}/process': {
      post: op('Admin', 'Assume o saque (requested → processing)', { auth: true }),
    },
    '/admin/withdrawals/{id}/complete': {
      post: op('Admin', 'Marca o saque como pago', { auth: true }),
    },
    '/admin/withdrawals/{id}/fail': {
      post: op('Admin', 'Saque falhou: valor devolvido à carteira', { auth: true }),
    },

    '/lgpd/consents': {
      get: op('LGPD', 'Meus consentimentos', { auth: true }),
      post: op('LGPD', 'Registra consentimento', { auth: true, responses: res201 }),
    },
    '/lgpd/deletion-requests': {
      post: op('LGPD', 'Direito ao esquecimento', { auth: true, responses: res201 }),
    },
    '/lgpd/export-requests': {
      get: op('LGPD', 'Minhas cópias de dados (status e link de download)', { auth: true }),
      post: op('LGPD', 'Portabilidade: gera a cópia JSON na hora (válida por EXPORT_TTL_DAYS)', {
        auth: true,
        responses: res201,
      }),
    },
    '/lgpd/export-requests/{id}/download': {
      get: op('LGPD', 'Baixa a cópia de dados (só o titular; 410 se expirou)', { auth: true }),
    },
    '/admin/deletion-requests': {
      get: op('Admin', 'Pedidos de exclusão de conta (status=pending|all)', { auth: true }),
    },
    '/admin/deletion-requests/{id}/complete': {
      post: op('Admin', 'Conclui a exclusão: anonimiza a conta e bloqueia o acesso', {
        auth: true,
      }),
    },
    '/admin/deletion-requests/{id}/reject': {
      post: op('Admin', 'Recusa com justificativa (titular é avisado)', { auth: true }),
    },
  },
};

/** Página do Swagger UI (assets via CDN — carregados pelo navegador). */
export const swaggerHtml = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Escambo API — Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
    <script>
      window.ui = SwaggerUIBundle({ url: '/api/openapi.json', dom_id: '#swagger-ui' });
    </script>
  </body>
</html>`;
