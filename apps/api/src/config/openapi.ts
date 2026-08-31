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
        },
        ['email', 'password'],
      ),
      Login: obj({ email: { type: 'string' }, password: { type: 'string' } }, ['email', 'password']),
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
          resolution: { type: 'string', enum: ['refund_client', 'release_freelancer', 'partial_split'] },
          refundPercentage: { type: 'integer', minimum: 0, maximum: 100, nullable: true },
          note: { type: 'string', nullable: true },
        },
        ['resolution'],
      ),
    },
  },
  paths: {
    '/health': { get: op('Health', 'Status da API + ping no banco') },

    '/auth/register': {
      post: op('Auth', 'Cria conta', { body: { $ref: '#/components/schemas/Register' }, responses: res201 }),
    },
    '/auth/login': {
      post: op('Auth', 'Autentica (accessToken + refreshToken)', { body: { $ref: '#/components/schemas/Login' } }),
    },
    '/auth/refresh': { post: op('Auth', 'Rotaciona o refresh token') },
    '/auth/logout': { post: op('Auth', 'Revoga a sessão') },
    '/auth/logout-all': { post: op('Auth', 'Encerra todas as sessões', { auth: true, responses: res200 }) },
    '/auth/me': { get: op('Auth', 'Dados do usuário do token', { auth: true }) },

    '/categories': { get: op('Categorias', 'Árvore de categorias') },

    '/profiles/me': { get: op('Perfis', 'Meus perfis', { auth: true }) },
    '/profiles/freelancer': { put: op('Perfis', 'Cria/edita perfil de freelancer', { auth: true }) },
    '/profiles/client': { put: op('Perfis', 'Cria/edita perfil de cliente', { auth: true }) },
    '/profiles/freelancer/{ulid}': {
      get: {
        ...op('Perfis', 'Perfil público do freelancer (nota + nível)'),
        parameters: [{ name: 'ulid', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },

    '/services': {
      get: op('Serviços', 'Lista/busca serviços (categoryId, q, isRemote, page, limit)'),
      post: op('Serviços', 'Cria serviço', { auth: true, body: { $ref: '#/components/schemas/CreateService' }, responses: res201 }),
    },
    '/services/{id}': {
      get: op('Serviços', 'Detalhe do serviço'),
      patch: op('Serviços', 'Atualiza (dono)', { auth: true }),
      delete: op('Serviços', 'Remove (dono, soft delete)', { auth: true, responses: res204 }),
    },

    '/contracts': {
      get: op('Contratações', 'Minhas contratações', { auth: true }),
      post: op('Contratações', 'Cria proposta (taxa 15%)', { auth: true, body: { $ref: '#/components/schemas/CreateContract' }, responses: res201 }),
    },
    '/contracts/{id}': { get: op('Contratações', 'Detalhe + histórico', { auth: true }) },
    '/contracts/{id}/accept': { post: op('Contratações', 'Freelancer aceita (financia escrow)', { auth: true }) },
    '/contracts/{id}/reject': { post: op('Contratações', 'Freelancer recusa', { auth: true }) },
    '/contracts/{id}/deliver': { post: op('Contratações', 'Registra entrega', { auth: true }) },
    '/contracts/{id}/approve': { post: op('Contratações', 'Cliente aprova (libera escrow)', { auth: true }) },
    '/contracts/{id}/cancel': { post: op('Contratações', 'Cancela (reembolso RN-025)', { auth: true }) },

    '/wallet': { get: op('Carteira', 'Saldo disponível + retido em escrow', { auth: true }) },
    '/withdrawals': {
      get: op('Saques', 'Meus saques', { auth: true }),
      post: op('Saques', 'Solicita saque (mín. R$20)', { auth: true, body: { $ref: '#/components/schemas/CreateWithdrawal' }, responses: res201 }),
    },

    '/reviews': {
      get: op('Avaliações', 'Avaliações de um freelancer (freelancerId)'),
      post: op('Avaliações', 'Avalia contratação concluída', { auth: true, responses: res201 }),
    },
    '/reviews/{id}/response': { post: op('Avaliações', 'Freelancer responde', { auth: true, responses: res201 }) },

    '/gamification/me': { get: op('Gamificação', 'XP, nível, progresso, streak, ranking, badges', { auth: true }) },
    '/gamification/me/history': { get: op('Gamificação', 'Feed de XP', { auth: true }) },
    '/gamification/leaderboard': { get: op('Gamificação', 'Ranking por XP', { auth: true }) },

    '/barters': {
      get: op('Troca (Escambo)', 'Minhas trocas', { auth: true }),
      post: op('Troca (Escambo)', 'Propõe troca (torna + taxa)', { auth: true, body: { $ref: '#/components/schemas/CreateBarter' }, responses: res201 }),
    },
    '/barters/{id}': { get: op('Troca (Escambo)', 'Detalhe da troca', { auth: true }) },
    '/barters/{id}/accept': { post: op('Troca (Escambo)', 'Aceita a troca (gera 2 contratos recíprocos)', { auth: true }) },

    '/notifications': { get: op('Notificações', 'Minhas notificações + não lidas', { auth: true }) },
    '/notifications/read-all': { post: op('Notificações', 'Marca todas como lidas', { auth: true }) },

    '/messaging/contracts/{id}': {
      get: op('Chat', 'Histórico do chat do contrato (partes)', { auth: true }),
      post: op('Chat', 'Envia mensagem (persiste + broadcast Socket.IO)', { auth: true, responses: res201 }),
    },

    '/favorites': {
      get: op('Trust & Safety', 'Meus favoritos', { auth: true }),
      post: op('Trust & Safety', 'Favoritar serviço/freelancer', { auth: true, responses: res201 }),
    },
    '/saved-searches': {
      get: op('Trust & Safety', 'Buscas salvas', { auth: true }),
      post: op('Trust & Safety', 'Salvar busca', { auth: true, responses: res201 }),
    },
    '/reports': { post: op('Trust & Safety', 'Denunciar conteúdo/usuário', { auth: true, responses: res201 }) },

    '/disputes': {
      get: op('Disputas', 'Minhas disputas', { auth: true }),
      post: op('Disputas', 'Abre disputa de contrato', { auth: true, responses: res201 }),
    },
    '/disputes/{id}': { get: op('Disputas', 'Detalhe da disputa', { auth: true }) },

    '/admin/metrics': { get: op('Admin', 'Métricas da plataforma', { auth: true }) },
    '/admin/disputes': { get: op('Admin', 'Disputas abertas', { auth: true }) },
    '/admin/disputes/{id}/resolve': {
      post: op('Admin', 'Resolve disputa (decisão de escrow)', { auth: true, body: { $ref: '#/components/schemas/ResolveDispute' } }),
    },
    '/admin/users/{ulid}/ban': { post: op('Admin', 'Bane usuário', { auth: true, responses: res204 }) },

    '/lgpd/consents': {
      get: op('LGPD', 'Meus consentimentos', { auth: true }),
      post: op('LGPD', 'Registra consentimento', { auth: true, responses: res201 }),
    },
    '/lgpd/deletion-requests': { post: op('LGPD', 'Direito ao esquecimento', { auth: true, responses: res201 }) },
    '/lgpd/export-requests': { post: op('LGPD', 'Portabilidade dos dados', { auth: true, responses: res201 }) },
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
