/* eslint-disable @typescript-eslint/no-explicit-any */
// Documento OpenAPI 3.0 da API do Escambo (RNF-010). Servido em /api/openapi.json e /api/docs.

import { dirname } from 'node:path';
import type {
  BrazilTimezone,
  DropoutDecision,
  DropoutStatus,
  NegotiationTurn,
  OfferOutcome,
  PackageTier,
  WithdrawalStatus,
} from '@escambo/types';
import { buildInfo } from './build-info';

const bearer = [{ bearerAuth: [] as string[] }];
const res200 = { '200': { description: 'OK' } };
const res201 = { '201': { description: 'Criado' } };
const res204 = { '204': { description: 'Sem conteúdo' } };

function op(
  tag: string,
  summary: string,
  opts: {
    auth?: boolean;
    responses?: Record<string, unknown>;
    body?: unknown;
    bodyRequired?: boolean;
  } = {},
): Record<string, unknown> {
  const o: Record<string, unknown> = {
    tags: [tag],
    summary,
    responses: opts.responses ?? { ...res200 },
  };
  if (opts.auth) o.security = bearer;
  if (opts.body) {
    o.requestBody = {
      required: opts.bodyRequired ?? true,
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

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
/** OpenAPI 3.0: a alternativa nullable só admite null; a outra conserva o schema completo. */
const nullableRef = (name: string) => ({
  oneOf: [ref(name), { type: 'object', nullable: true, enum: [null] }],
});
const implemented = (schema: Record<string, unknown>) => ({
  ...schema,
  'x-implementation-status': 'active',
});
const offerOutcomes = [
  'open',
  'countered',
  'accepted',
  'declined',
  'withdrawn',
  'expired',
  'closed',
] as const satisfies readonly OfferOutcome[];
const negotiationTurns = ['client', 'freelancer'] as const satisfies readonly NegotiationTurn[];
const dropoutDecisions = ['excused', 'upheld'] as const satisfies readonly DropoutDecision[];
const dropoutStatuses = [
  'counting',
  'agreed',
  'excused',
  'expired',
] as const satisfies readonly DropoutStatus[];
const brazilTimezones = [
  'America/Noronha',
  'America/Sao_Paulo',
  'America/Cuiaba',
  'America/Manaus',
  'America/Rio_Branco',
] as const satisfies readonly BrazilTimezone[];
const timestamp = { type: 'string', format: 'date-time' };
const nullableTimestamp = { ...timestamp, nullable: true };
const jsonResponse = (status: '200' | '201', schema: string) => ({
  [status]: {
    description: status === '201' ? 'Criado' : 'OK',
    content: { 'application/json': { schema: ref(schema) } },
  },
});
/** Resposta de erro no formato padrão ({ error, message }), com os códigos possíveis na descrição. */
const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ref('Error') } },
});
const pageParameters = [
  {
    name: 'page',
    in: 'query',
    schema: { type: 'integer', minimum: 1, maximum: 10_000, default: 1 },
  },
  {
    name: 'limit',
    in: 'query',
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
];
const idPathParameter = (name: string, schema: Record<string, unknown>) => ({
  name,
  in: 'path',
  required: true,
  schema,
});
const offerPathParameters = [
  { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
];
const nonnegativeInteger = { type: 'integer', minimum: 0 };
const milestoneAmount = { type: 'number', minimum: 0.01, maximum: 99_999_999.99, multipleOf: 0.01 };

/** Contratos públicos das regras de negociação, revisão e desistência (ADR 61). */
const preparedContractSchemas = {
  NegotiationTurn: implemented({ type: 'string', enum: negotiationTurns }),
  OfferOutcome: implemented({ type: 'string', enum: offerOutcomes }),
  OfferMilestone: implemented(
    obj(
      {
        id: { type: 'integer', minimum: 1 },
        title: { type: 'string' },
        amount: milestoneAmount,
        freelancerNet: { type: 'number', minimum: 0, multipleOf: 0.01 },
        dueAt: nullableTimestamp,
      },
      ['id', 'title', 'amount', 'freelancerNet', 'dueAt'],
    ),
  ),
  ContractOffer: implemented(
    obj(
      {
        seq: { type: 'integer', minimum: 1, maximum: 5 },
        madeBy: ref('NegotiationTurn'),
        price: { type: 'number', minimum: 10, maximum: 99_999_999.99, multipleOf: 0.01 },
        platformFee: { type: 'number', minimum: 0, multipleOf: 0.01 },
        freelancerNet: { type: 'number', minimum: 0, multipleOf: 0.01 },
        deadlineAt: nullableTimestamp,
        deadlineZone: { type: 'string', enum: brazilTimezones },
        milestones: { type: 'array', nullable: true, items: ref('OfferMilestone') },
        message: { type: 'string', nullable: true },
        respondBy: nullableTimestamp,
        outcome: ref('OfferOutcome'),
        createdAt: timestamp,
        resolvedAt: nullableTimestamp,
      },
      [
        'seq',
        'madeBy',
        'price',
        'platformFee',
        'freelancerNet',
        'deadlineAt',
        'deadlineZone',
        'milestones',
        'message',
        'respondBy',
        'outcome',
        'createdAt',
        'resolvedAt',
      ],
    ),
  ),
  Negotiation: implemented(
    obj(
      {
        seq: { type: 'integer', minimum: 1, maximum: 5 },
        round: { type: 'integer', enum: [1, 2, 3] },
        feePercentage: { type: 'number', minimum: 0, maximum: 50, multipleOf: 0.01 },
        deadlineZone: {
          type: 'string',
          enum: brazilTimezones,
          description: 'Fuso atual do freelancer para escolher dias em uma nova contraproposta.',
        },
        turn: ref('NegotiationTurn'),
        respondBy: nullableTimestamp,
        canCounter: { type: 'boolean' },
        countersLeft: { type: 'integer', minimum: 0, maximum: 2 },
        current: nullableRef('ContractOffer'),
      },
      ['seq', 'round', 'turn', 'respondBy', 'canCounter', 'countersLeft', 'current'],
    ),
  ),
  CounterOfferMilestone: implemented({
    ...obj(
      { id: { type: 'integer', minimum: 1 }, amount: milestoneAmount, dueAt: nullableTimestamp },
      ['id', 'amount', 'dueAt'],
    ),
    additionalProperties: false,
  }),
  CounterOfferRequest: implemented({
    ...obj(
      {
        seq: { type: 'integer', minimum: 1, maximum: 5 },
        price: { type: 'number', minimum: 10, maximum: 99_999_999.99, multipleOf: 0.01 },
        deadlineAt: nullableTimestamp,
        milestones: {
          type: 'array',
          minItems: 2,
          maxItems: 10,
          items: ref('CounterOfferMilestone'),
        },
        message: { type: 'string', minLength: 5, maxLength: 500 },
      },
      ['seq', 'price', 'deadlineAt', 'message'],
    ),
    additionalProperties: false,
    description:
      'Termos completos da próxima oferta. Conserva entrega única ou os mesmos ids e ordem dos marcos; títulos e forma de pagamento não mudam. Valores em créditos devem ser inteiros. Datas devem estar no futuro, em ordem, e marcos somam o preço.',
  }),
  RevisionState: implemented(
    obj({ used: nonnegativeInteger, limit: { ...nonnegativeInteger, nullable: true } }, [
      'used',
      'limit',
    ]),
  ),
  ContractRevisions: implemented({
    allOf: [ref('RevisionState')],
    description: 'Alias anterior de RevisionState; limit null mantém o legado ilimitado.',
  }),
  ContractDropout: implemented(
    obj(
      {
        at: timestamp,
        agreedAt: nullableTimestamp,
        agreeUntil: timestamp,
        counts: { type: 'boolean' },
      },
      ['at', 'agreedAt', 'agreeUntil', 'counts'],
    ),
  ),
  DropoutSummary: implemented({
    ...obj(
      {
        count: nonnegativeInteger,
        windowDays: { type: 'integer', enum: [60] },
        alert: { type: 'boolean' },
      },
      ['count', 'windowDays', 'alert'],
    ),
    description: 'Resumo público sem contratações, participantes, datas ou textos de contestação.',
  }),
  DropoutPreview: implemented({
    ...obj(
      {
        countAfter: nonnegativeInteger,
        windowDays: { type: 'integer', enum: [60] },
        alertAt: { type: 'integer', enum: [3] },
        alertUntil: nullableTimestamp,
      },
      ['countAfter', 'windowDays', 'alertAt', 'alertUntil'],
    ),
    description: 'Prévia informativa; a contagem pode mudar entre a leitura e a desistência.',
  }),
  DropoutDecision: implemented({ type: 'string', enum: dropoutDecisions }),
  DropoutStatus: implemented({ type: 'string', enum: dropoutStatuses }),
  MyDropout: implemented(
    obj(
      {
        id: { type: 'integer', minimum: 1 },
        contractId: { type: 'integer', minimum: 1 },
        contractTitle: { type: 'string' },
        droppedAt: timestamp,
        countsUntil: nullableTimestamp,
        status: ref('DropoutStatus'),
        appealText: { type: 'string', nullable: true },
        appealedAt: nullableTimestamp,
        canAppeal: { type: 'boolean' },
        decision: nullableRef('DropoutDecision'),
        decisionNote: { type: 'string', nullable: true },
      },
      [
        'id',
        'contractId',
        'contractTitle',
        'droppedAt',
        'countsUntil',
        'status',
        'appealText',
        'appealedAt',
        'canAppeal',
        'decision',
        'decisionNote',
      ],
    ),
  ),
  MyDropouts: implemented(
    obj(
      {
        items: { type: 'array', items: ref('MyDropout') },
        count: nonnegativeInteger,
        alert: { type: 'boolean' },
        alertUntil: nullableTimestamp,
        acceptedInWindow: nonnegativeInteger,
      },
      ['items', 'count', 'alert', 'alertUntil', 'acceptedInWindow'],
    ),
  ),
  AdminDropout: implemented({
    allOf: [
      ref('MyDropout'),
      obj(
        {
          freelancer: obj(
            {
              id: { type: 'integer', minimum: 1 },
              ulid: { type: 'string' },
              name: { type: 'string', nullable: true },
            },
            ['id', 'ulid', 'name'],
          ),
          clientAgreed: { type: 'boolean' },
          ownerCount: nonnegativeInteger,
        },
        ['freelancer', 'clientAgreed', 'ownerCount'],
      ),
    ],
  }),
};

const packageTiers = ['basic', 'standard', 'premium'] as const satisfies readonly PackageTier[];

/** Pacotes Básico, Padrão e Premium por serviço (RF-086, RN-068, ADR 69). */
const packageSchemas = {
  PackageTier: {
    type: 'string',
    enum: packageTiers,
    description: 'Nível do pacote: basic (Básico), standard (Padrão) e premium (Premium).',
  },
  ServicePackage: {
    ...obj(
      {
        tier: ref('PackageTier'),
        name: { type: 'string', minLength: 3, maxLength: 60 },
        description: { type: 'string', maxLength: 600, nullable: true },
        price: { type: 'number', minimum: 10, maximum: 99_999_999.99, multipleOf: 0.01 },
        deliveryDays: { type: 'integer', minimum: 1, maximum: 365 },
        revisions: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          default: 2,
          description: 'Revisões sem custo por entrega ou por marco (RN-023); sem ilimitado.',
        },
        features: {
          type: 'array',
          maxItems: 10,
          default: [],
          items: { type: 'string', minLength: 2, maxLength: 80 },
          description: 'Itens inclusos, na ordem escrita; repetido (sem caixa) é 422.',
        },
      },
      ['tier', 'name', 'price', 'deliveryDays'],
    ),
    additionalProperties: false,
    description:
      'Um pacote do serviço. Na resposta, description é null sem descrição e revisions e features vêm sempre. Na contratação, é a cópia do pacote como estava publicado.',
  },
  ServicePackages: {
    type: 'array',
    maxItems: 3,
    items: ref('ServicePackage'),
    description:
      'RF-086/RN-068: até 3 pacotes, um por nível, com o Básico e sem pular nível (o Premium exige o Padrão), só no preço fixo (422 packages_require_fixed_price). Cada preço vale pelo menos o maior entre R$ 10,00 e o mínimo do serviço (422 price_below_minimum) e não desce do Básico ao Premium (422 package_price_order). Com pacotes, price e deliveryDays não vêm (422 price_from_packages): o serviço guarda os do Básico, que a busca, a ordenação e a troca usam ("a partir de"). Na edição, a lista substitui a anterior; [] tira os pacotes.',
  },
};

/** Leitura no chat (RF-059): o pedido, a resposta e o evento Socket.IO message:read. */
const chatReadSchemas = {
  MarkChatRead: {
    ...obj({
      upTo: {
        type: 'integer',
        minimum: 1,
        description: 'Última mensagem exibida; sem ele, todas as recebidas contam como lidas.',
      },
    }),
    description: 'Corpo opcional: só as mensagens recebidas até upTo viram lidas.',
  },
  ChatReadReceipt: obj(
    {
      conversationId: { type: 'integer', minimum: 1, nullable: true },
      marked: {
        ...nonnegativeInteger,
        description: 'Quantas viraram lidas agora (0 = já estavam).',
      },
      upToId: { type: 'integer', minimum: 1, nullable: true },
      readAt: nullableTimestamp,
    },
    ['conversationId', 'marked', 'upToId', 'readAt'],
  ),
  ChatReadEvent: {
    ...obj(
      {
        contractId: { type: 'integer', minimum: 1 },
        conversationId: { type: 'integer', minimum: 1 },
        readerId: { type: 'integer', minimum: 1 },
        upToId: { type: 'integer', minimum: 1 },
        readAt: timestamp,
      },
      ['contractId', 'conversationId', 'readerId', 'upToId', 'readAt'],
    ),
    description:
      'Evento Socket.IO message:read, emitido na sala contract:<id> de cada contratação do par, só quando alguma mensagem mudou: as recebidas por readerId até upToId estão lidas.',
  },
};

const supportStatuses = ['open', 'in_progress', 'waiting_user', 'resolved', 'closed'];
const supportPriorities = ['low', 'medium', 'high', 'critical'];
const supportSchemas = {
  SupportTicket: obj({
    id: { type: 'integer', minimum: 1 },
    ulid: { type: 'string' },
    userId: { type: 'integer', minimum: 1 },
    ownerDeleted: { type: 'boolean' },
    contractId: { type: 'integer', minimum: 1, nullable: true },
    category: { type: 'string', enum: ['payment', 'dispute', 'account', 'fraud', 'other'] },
    subject: { type: 'string', minLength: 3, maxLength: 150 },
    status: { type: 'string', enum: supportStatuses },
    priority: { type: 'string', enum: supportPriorities },
    assignedTo: { type: 'integer', minimum: 1, nullable: true },
    firstResponseAt: nullableTimestamp,
    slaDueAt: timestamp,
    slaAlertedAt: nullableTimestamp,
    resolvedAt: nullableTimestamp,
    closedAt: nullableTimestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
  SupportMessage: obj({
    id: { type: 'integer', minimum: 1 },
    ticketId: { type: 'integer', minimum: 1 },
    senderId: { type: 'integer', minimum: 1 },
    from: { type: 'string', enum: ['user', 'support'] },
    message: { type: 'string', minLength: 1, maxLength: 5000 },
    internal: { type: 'boolean' },
    createdAt: timestamp,
  }),
  SupportTicketDetail: {
    allOf: [
      ref('SupportTicket'),
      obj(
        {
          messages: { type: 'array', maxItems: 50, items: ref('SupportMessage') },
          nextBeforeId: { type: 'integer', minimum: 1, nullable: true },
        },
        ['messages', 'nextBeforeId'],
      ),
    ],
  },
  SupportTicketPage: obj(
    {
      items: { type: 'array', items: ref('SupportTicket') },
      page: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
    ['items', 'page', 'limit'],
  ),
  CreateSupportTicket: {
    ...obj(
      {
        category: { type: 'string', enum: ['payment', 'dispute', 'account', 'fraud', 'other'] },
        subject: { type: 'string', minLength: 3, maxLength: 150 },
        description: { type: 'string', minLength: 10, maxLength: 5000 },
        contractId: {
          type: 'integer',
          minimum: 1,
          nullable: true,
          description: 'Obrigatório para categoria dispute; exige participação na contratação.',
        },
      },
      ['category', 'subject', 'description'],
    ),
    additionalProperties: false,
  },
  ReplySupportTicket: {
    ...obj({ message: { type: 'string', minLength: 1, maxLength: 5000 } }, ['message']),
    additionalProperties: false,
  },
  AdminReplySupportTicket: {
    ...obj(
      {
        message: { type: 'string', minLength: 1, maxLength: 5000 },
        internal: { type: 'boolean', default: false },
        resolve: { type: 'boolean', default: false },
      },
      ['message'],
    ),
    additionalProperties: false,
    description:
      'Nota interna não pode resolver, não conta como primeira resposta nem notifica o titular.',
  },
  UpdateSupportTicket: {
    ...obj({
      priority: { type: 'string', enum: supportPriorities },
      status: { type: 'string', enum: ['in_progress', 'waiting_user'] },
    }),
    minProperties: 1,
    additionalProperties: false,
  },
};
const supportListParameters = [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
  { name: 'status', in: 'query', schema: { type: 'string', enum: supportStatuses } },
];
const supportDetailParameters = [
  ...offerPathParameters,
  {
    name: 'beforeId',
    in: 'query',
    schema: { type: 'integer', minimum: 1 },
    description:
      'Mensagens anteriores a este ID; a resposta traz até 50 mensagens em ordem crescente. Notas internas são filtradas antes da paginação pública.',
  },
];
const supportErrors = {
  '403': {
    description:
      'Conta bloqueada ou sem papel administrativo atual; titular removido não pode receber novas alterações.',
  },
  '404': { description: 'Chamado ou contratação não encontrado para este titular.' },
  '409': {
    description: 'ticket_duplicate, ticket_limit (3 chamados não encerrados) ou ticket_closed.',
  },
  '422': {
    description: 'Dados inválidos; corpos estritos, IDs positivos e mensagens dentro do limite.',
  },
  '503': {
    description: 'support_unavailable; falha temporária sem exposição de conteúdo privado.',
  },
};

/** Prazo de saque (RN-035, RF-046, RF-078) e extrato de créditos com período (RF-047). */
const withdrawalStatuses = [
  'requested',
  'processing',
  'completed',
  'failed',
  'cancelled',
] as const satisfies readonly WithdrawalStatus[];
const withdrawalProperties = {
  id: { type: 'integer' },
  amount: { type: 'number' },
  status: { type: 'string', enum: withdrawalStatuses },
  method: { type: 'string', enum: ['pix', 'bank'] },
  maskedDestination: {
    type: 'string',
    description:
      'Chave PIX ou conta com só os 4 últimos caracteres; "[indisponível]" se o dado cifrado não pôde ser lido (RNF-017).',
  },
  createdAt: timestamp,
  processedAt: nullableTimestamp,
  dueAt: {
    ...nullableTimestamp,
    description:
      'Prazo de pagamento (RN-035): 23:59:59 de Brasília do n-ésimo dia útil (seg a sex, sem descontar feriados) depois do dia do pedido, com n = withdrawal_pix_business_days ou withdrawal_bank_business_days no momento do pedido. Gravado no saque: mudar o parâmetro depois não o altera. null só em saque encerrado antes da 1.44.0.',
  },
};
const withdrawalRequired = [
  'id',
  'amount',
  'status',
  'method',
  'maskedDestination',
  'createdAt',
  'processedAt',
  'dueAt',
];
const withdrawalSchemas = {
  Withdrawal: obj(withdrawalProperties, withdrawalRequired),
  WithdrawalsPage: obj(
    {
      items: { type: 'array', items: ref('Withdrawal') },
      page: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
    ['items', 'page', 'limit'],
  ),
  AdminWithdrawal: obj(
    {
      ...withdrawalProperties,
      userId: { type: 'integer' },
      userUlid: { type: 'string' },
      userEmail: { type: 'string' },
      userName: { type: 'string', nullable: true },
      destination: {
        type: 'string',
        description:
          'Destino completo: é o admin quem paga. Gravado cifrado (RNF-017); o que não decifra vem como "[indisponível]".',
      },
      overdue: {
        type: 'boolean',
        description: 'Aguardando ou em processamento e já passou de dueAt (RN-035).',
      },
    },
    [
      ...withdrawalRequired,
      'userId',
      'userUlid',
      'userEmail',
      'userName',
      'destination',
      'overdue',
    ],
  ),
  AdminMetrics: obj(
    {
      users: nonnegativeInteger,
      freelancers: nonnegativeInteger,
      contracts: nonnegativeInteger,
      completedContracts: nonnegativeInteger,
      openDisputes: nonnegativeInteger,
      platformFees: { type: 'number' },
      inEscrow: { type: 'number' },
      pendingWithdrawals: nonnegativeInteger,
      pendingWithdrawalsAmount: { type: 'number' },
      overdueWithdrawals: {
        ...nonnegativeInteger,
        description: 'Saques aguardando ou em processamento que já passaram do prazo (RN-035).',
      },
      depositsTotal: { type: 'number' },
      usersBalance: { type: 'number' },
      pendingDeletions: nonnegativeInteger,
      supportOpen: {
        ...nonnegativeInteger,
        description:
          'Chamados de suporte em aberto (aberto, em atendimento ou aguardando o titular), sem os de conta anonimizada (RF-076).',
      },
      supportAwaitingReply: {
        ...nonnegativeInteger,
        description: 'Dos em aberto, os que esperam a equipe (aberto ou em atendimento).',
      },
      supportSlaOverdue: {
        ...nonnegativeInteger,
        description:
          'Dos em aberto, os sem primeira resposta pública com o prazo do SLA (sla_due_at) vencido.',
      },
    },
    [
      'users',
      'freelancers',
      'contracts',
      'completedContracts',
      'openDisputes',
      'platformFees',
      'inEscrow',
      'pendingWithdrawals',
      'pendingWithdrawalsAmount',
      'overdueWithdrawals',
      'depositsTotal',
      'usersBalance',
      'pendingDeletions',
      'supportOpen',
      'supportAwaitingReply',
      'supportSlaOverdue',
    ],
  ),
  UsageTotals: obj(
    {
      newUsers: { ...nonnegativeInteger, description: 'Contas criadas (sem administradores).' },
      newContracts: { ...nonnegativeInteger, description: 'Contratações criadas.' },
      completedContracts: { ...nonnegativeInteger, description: 'Contratações concluídas.' },
      cancelledContracts: { ...nonnegativeInteger, description: 'Contratações canceladas.' },
      activeUsers: {
        ...nonnegativeInteger,
        description:
          'Pessoas distintas ativas (ver activeDefinition). Nos totais, cada pessoa conta uma vez no período inteiro: não é a soma dos baldes.',
      },
    },
    ['newUsers', 'newContracts', 'completedContracts', 'cancelledContracts', 'activeUsers'],
  ),
  UsageBucket: {
    allOf: [
      ref('UsageTotals'),
      obj(
        {
          bucket: {
            type: 'string',
            description:
              'AAAA-MM-DD (dia; na semana, a segunda-feira) ou AAAA-MM (mês), em horário de Brasília.',
          },
          source: {
            type: 'string',
            enum: ['snapshot', 'live'],
            description:
              'snapshot: balde inteiro e fechado, lido de report_snapshots (gravado pelo job report-snapshots); live: calculado agora.',
          },
        },
        ['bucket', 'source'],
      ),
    ],
  },
  AdminUsageReport: obj(
    {
      from: { type: 'string', format: 'date' },
      to: { type: 'string', format: 'date' },
      granularity: { type: 'string', enum: ['day', 'week', 'month'] },
      totals: ref('UsageTotals'),
      series: {
        type: 'array',
        items: ref('UsageBucket'),
        description: 'Todos os baldes do período, em ordem, inclusive os zerados.',
      },
      activeDefinition: { type: 'string' },
    },
    ['from', 'to', 'granularity', 'totals', 'series', 'activeDefinition'],
  ),
  CreditTransaction: obj(
    {
      id: { type: 'integer' },
      amount: { type: 'integer', description: 'Assinado: + entra, - sai.' },
      balanceAfter: { type: 'integer' },
      reason: {
        type: 'string',
        enum: [
          'welcome',
          'escrow_hold',
          'escrow_in',
          'escrow_release',
          'escrow_refund',
          'refund',
          'grant',
          'boost',
        ],
      },
      contractId: { type: 'integer', nullable: true },
      createdAt: timestamp,
    },
    ['id', 'amount', 'balanceAfter', 'reason', 'contractId', 'createdAt'],
  ),
  CreditTransactionsPage: obj(
    {
      items: { type: 'array', items: ref('CreditTransaction') },
      page: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      hasMore: { type: 'boolean', description: 'Há lançamentos depois desta página.' },
    },
    ['items', 'page', 'limit', 'hasMore'],
  ),
};
/** Período dos extratos (RF-047): os mesmos `from`/`to` no de R$ e no de créditos. */
const ledgerPeriodParameters = ['from', 'to'].map((name) => ({
  name,
  in: 'query',
  description:
    name === 'from'
      ? 'Primeiro dia (AAAA-MM-DD, no fuso da conta; sem escolha, America/Sao_Paulo).'
      : 'Último dia (AAAA-MM-DD), inclusivo até 23:59:59 no fuso da conta.',
  schema: { type: 'string', format: 'date' },
}));

export const openapiDocument: Record<string, any> = {
  openapi: '3.0.3',
  info: {
    title: 'Escambo API',
    // A do app (package.json): o documento acompanha cada release sem edição à mão.
    version: buildInfo.version,
    description:
      'API do Escambo — marketplace de serviços com escrow, gamificação e troca de serviços (escambo). Autenticação via Bearer JWT; identidade, papel e status são conferidos no banco a cada requisição. RN-007: suspensos podem entrar, renovar sessão e consultar; ações de negócio retornam 403 account_suspended, incluindo acesso administrativo. Permanecem disponíveis suporte próprio (abrir, responder e encerrar), logout/logout-all, consentimentos, solicitações LGPD, remoção de push, contestações próprias de remoção/desistência e o registro de leitura do chat (RF-059). Banimento ou exclusão bloqueiam o acesso autenticado. Prazos e processamento já iniciado continuam. Atendimento de suporte não altera dinheiro ou prazos de contratos; disputa financeira mantém suas próprias regras.',
  },
  servers: [{ url: '/api', description: 'API' }],
  tags: [
    { name: 'Health' },
    { name: 'Auth' },
    { name: 'Perfis' },
    { name: 'Categorias' },
    { name: 'Serviços' },
    { name: 'Contratações' },
    { name: 'Chat' },
    { name: 'Carteira' },
    { name: 'Impulsionamento' },
    { name: 'Saques' },
    { name: 'Avaliações' },
    { name: 'Gamificação' },
    { name: 'Troca (Escambo)' },
    { name: 'Notificações' },
    { name: 'Trust & Safety' },
    { name: 'Disputas' },
    { name: 'Suporte' },
    { name: 'Admin' },
    { name: 'LGPD' },
    { name: 'Plataforma' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      Error: obj({ error: { type: 'string' }, message: { type: 'string' } }),
      UserStatus: {
        type: 'string',
        enum: ['active', 'pending_verification', 'suspended', 'banned'],
      },
      PublicUser: obj(
        {
          id: { type: 'integer', minimum: 1 },
          ulid: { type: 'string' },
          email: { type: 'string', format: 'email' },
          role: { type: 'string', enum: ['client', 'freelancer', 'company', 'admin'] },
          status: ref('UserStatus'),
          emailVerified: { type: 'boolean' },
          emailFrequency: { type: 'string', enum: ['instant', 'daily', 'off'] },
          digestHour: { type: 'integer', minimum: 0, maximum: 23 },
          timezone: { type: 'string', enum: brazilTimezones },
          timezoneChosen: { type: 'boolean' },
          quietHours: {
            ...obj(
              {
                start: { type: 'integer', minimum: 0, maximum: 23 },
                end: { type: 'integer', minimum: 0, maximum: 23 },
              },
              ['start', 'end'],
            ),
            nullable: true,
          },
          quietPass: {
            type: 'array',
            nullable: true,
            items: { type: 'string', enum: ['deadline'] },
          },
        },
        [
          'id',
          'ulid',
          'email',
          'role',
          'status',
          'emailVerified',
          'emailFrequency',
          'digestHour',
          'timezone',
          'timezoneChosen',
          'quietHours',
          'quietPass',
        ],
      ),
      AuthResponse: obj(
        {
          accessToken: { type: 'string' },
          refreshToken: { type: 'string' },
          user: ref('PublicUser'),
        },
        ['accessToken', 'refreshToken', 'user'],
      ),
      DisputeTooEarlyError: obj(
        {
          error: { type: 'string', enum: ['dispute_too_early'] },
          message: { type: 'string' },
          opensAt: nullableTimestamp,
        },
        ['error', 'message', 'opensAt'],
      ),
      ActiveContractError: obj(
        {
          error: { type: 'string', enum: ['active_contract_exists'] },
          message: { type: 'string' },
          contractId: {
            type: 'integer',
            minimum: 1,
            description: 'Contratação aberta do próprio cliente com este freelancer.',
          },
        },
        ['error', 'message', 'contractId'],
      ),
      RevisionGrant: { ...obj({}), additionalProperties: false },
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
          company: {
            ...ref('RegisterCompany'),
            description:
              'RF-018: obrigatório com role company e recusado nas outras (422 validation_error: details.company).',
          },
        },
        ['email', 'password'],
      ),
      RegisterCompany: obj(
        {
          legalName: { type: 'string', minLength: 2, maxLength: 150, description: 'Razão social' },
          tradeName: {
            type: 'string',
            minLength: 2,
            maxLength: 150,
            description: 'Nome fantasia: o nome exibido',
          },
          cnpj: {
            type: 'string',
            maxLength: 30,
            description:
              'Com ou sem máscara; numérico ou alfanumérico (IN RFB 2.229/2024: 12 posições A–Z ou 0–9 e 2 dígitos verificadores). Sai normalizado: 14 caracteres em maiúsculas.',
          },
        },
        ['legalName', 'tradeName', 'cnpj'],
      ),
      CompanyRef: obj({ ulid: { type: 'string' }, tradeName: { type: 'string' } }, [
        'ulid',
        'tradeName',
      ]),
      CompanyProfile: obj(
        {
          legalName: { type: 'string', description: 'Razão social' },
          tradeName: { type: 'string', description: 'Nome fantasia' },
          cnpj: {
            type: 'string',
            pattern: '^[0-9A-Z]{12}[0-9]{2}$',
            description: 'Dado público: 14 caracteres, maiúsculas, sem máscara.',
          },
          logoUrl: { type: 'string', nullable: true },
          bio: { type: 'string', nullable: true, maxLength: 280, description: 'Descrição curta' },
          website: { type: 'string', nullable: true },
          city: { type: 'string', nullable: true },
          state: { type: 'string', nullable: true },
        },
        ['legalName', 'tradeName', 'cnpj', 'logoUrl', 'bio', 'website', 'city', 'state'],
      ),
      PublicCompanyProfile: {
        allOf: [
          ref('CompanyProfile'),
          obj({ userUlid: { type: 'string' }, memberSince: timestamp }, [
            'userUlid',
            'memberSince',
          ]),
        ],
      },
      UpsertCompanyProfile: obj(
        {
          legalName: { type: 'string', minLength: 2, maxLength: 150 },
          tradeName: { type: 'string', minLength: 2, maxLength: 150 },
          cnpj: { type: 'string', maxLength: 30 },
          logoUrl: {
            type: 'string',
            nullable: true,
            description: 'URL externa ou imagem enviada pela plataforma (/api/media/..., ADR 36)',
          },
          bio: { type: 'string', nullable: true, maxLength: 280 },
          website: {
            type: 'string',
            nullable: true,
            maxLength: 255,
            description: 'Só http(s); vazio apaga',
          },
          city: { type: 'string', nullable: true, maxLength: 100 },
          state: { type: 'string', nullable: true, minLength: 2, maxLength: 2 },
        },
        ['legalName', 'tradeName', 'cnpj'],
      ),
      CpfStatus: obj(
        {
          available: {
            type: 'boolean',
            description: 'O servidor guarda o CPF cifrado (sem FIELD_ENCRYPTION_KEY, false)',
          },
          required: {
            type: 'boolean',
            description:
              'A conta entrega trabalho (ADR 56: papel freelancer, algum serviço ou alguma contratação como freelancer): o saque pede o CPF validado',
          },
          hasFreelancerProfile: { type: 'boolean' },
          verified: { type: 'boolean' },
          maskedCpf: {
            type: 'string',
            nullable: true,
            description: '***.456.789-**; null antes de validar',
          },
          birthDate: { type: 'string', format: 'date', nullable: true },
          verifiedAt: nullableTimestamp,
        },
        [
          'available',
          'required',
          'hasFreelancerProfile',
          'verified',
          'maskedCpf',
          'birthDate',
          'verifiedAt',
        ],
      ),
      VerifyCpf: obj(
        {
          cpf: { type: 'string', maxLength: 20, description: 'Com ou sem máscara' },
          birthDate: {
            type: 'string',
            format: 'date',
            description: 'AAAA-MM-DD, de 1900 em diante',
          },
        },
        ['cpf', 'birthDate'],
      ),
      AdminCpfSummary: obj(
        {
          verified: { type: 'boolean' },
          maskedCpf: {
            type: 'string',
            nullable: true,
            description: 'Só mascarado; "[indisponível]" se o cifrado não abriu',
          },
          verifiedAt: nullableTimestamp,
        },
        ['verified', 'maskedCpf', 'verifiedAt'],
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
          isRemote: {
            type: 'boolean',
            description: 'Compatível: true = remoto, false = presencial (padrão).',
          },
          modality: ref('ServiceModality'),
          tags: ref('ServiceTags'),
          packages: ref('ServicePackages'),
        },
        ['categoryId', 'title', 'description'],
      ),
      ServiceModality: {
        type: 'string',
        enum: ['remote', 'onsite', 'both'],
        description:
          'RF-023: remoto, presencial ou os dois. Quando vem junto do isRemote, vale a modality.',
      },
      ServiceTags: {
        type: 'array',
        maxItems: 10,
        items: { type: 'string', minLength: 2, maxLength: 30 },
        description:
          'RF-024/RN-018: até 10 tags de 2 a 30 caracteres (depois do trim), com letras, números, espaço e + # . / _ -. Gravadas normalizadas (espaços reduzidos, minúsculas); repetida, sem diferenciar maiúsculas nem acento, é 422. Na edição, a lista substitui a anterior ([] tira todas).',
      },
      CreateContract: obj(
        {
          freelancerId: { type: 'integer' },
          serviceId: { type: 'integer', nullable: true },
          title: { type: 'string' },
          description: { type: 'string' },
          price: { type: 'number', minimum: 10 },
          deadlineAt: { type: 'string', format: 'date-time', nullable: true },
          packageTier: {
            ...ref('PackageTier'),
            description:
              'RF-086: o pacote escolhido, com serviceId. Obrigatório quando o serviço tem pacotes (422 package_required); nível que o serviço não tem é 422 package_not_found. O price precisa ser o do pacote, ao centavo (409 package_changed). Sem deadlineAt, o prazo é o fim do dia daqui a deliveryDays dias no fuso de quem entrega (marco com prazo depois dele: 422 milestone_after_deadline); data antes disso é 422 deadline_before_package. As revisões da contratação (e de cada marco) são as do pacote.',
          },
        },
        ['freelancerId', 'title', 'description', 'price'],
      ),
      CancelContract: {
        ...obj({
          seq: {
            type: 'integer',
            minimum: 1,
            maximum: 5,
            description:
              'Sequência da oferta vista. Obrigatória na negociação após a oferta 1; outra oferta no lugar: 409 offer_changed.',
          },
          expectedRefund: {
            type: 'number',
            minimum: 0,
            description:
              'Reembolso ao cliente que a tela mostrou (cancellation.refundClient). Diferente do calculado agora: 409 cancel_quote_changed',
          },
          expectedDropoutCount: {
            type: 'integer',
            minimum: 1,
            description:
              'Contagem exibida na prévia da desistência; campo opcional de compatibilidade.',
          },
        }),
        additionalProperties: false,
      },
      DropoutAgreement: { ...obj({}), additionalProperties: false },
      DropoutAppeal: {
        ...obj({ text: { type: 'string', minLength: 20, maxLength: 1000 } }, ['text']),
        additionalProperties: false,
      },
      DropoutDecisionRequest: {
        ...obj({ note: { type: 'string', minLength: 10, maxLength: 500 } }, ['note']),
        additionalProperties: false,
      },
      Mission: obj(
        {
          id: { type: 'integer', minimum: 1 },
          title: { type: 'string' },
          description: { type: 'string', nullable: true },
          type: { type: 'string', enum: ['daily', 'weekly', 'achievement'] },
          action: {
            type: 'string',
            enum: ['complete_contracts', 'fast_response_hours', 'daily_login', 'complete_barter'],
          },
          xpReward: nonnegativeInteger,
          progress: nonnegativeInteger,
          target: { type: 'integer', minimum: 1 },
          completed: { type: 'boolean' },
          completedAt: nullableTimestamp,
          expiresAt: {
            ...nullableTimestamp,
            description:
              'Fim do período: 23:59:59 do dia ou do domingo no fuso da conta; null na conquista sem prazo.',
          },
        },
        [
          'id',
          'title',
          'description',
          'type',
          'action',
          'xpReward',
          'progress',
          'target',
          'completed',
          'completedAt',
          'expiresAt',
        ],
      ),
      LeaderboardEntry: obj(
        {
          rank: { type: 'integer', minimum: 1 },
          userUlid: { type: 'string' },
          name: { type: 'string', nullable: true },
          totalXp: nonnegativeInteger,
          level: { type: 'integer', minimum: 1 },
          levelName: { type: 'string' },
          avgRating: { type: 'number', minimum: 0, maximum: 5 },
          completedContracts: nonnegativeInteger,
          distanceKm: { type: 'number', minimum: 0, description: 'Só no ranking local.' },
        },
        [
          'rank',
          'userUlid',
          'name',
          'totalXp',
          'level',
          'levelName',
          'avgRating',
          'completedContracts',
        ],
      ),
      Badge: obj({ slug: { type: 'string' }, name: { type: 'string' }, awardedAt: timestamp }, [
        'slug',
        'name',
        'awardedAt',
      ]),
      PublicFreelancerProfile: obj({
        latitude: {
          type: 'number',
          nullable: true,
          minimum: -90,
          maximum: 90,
          description:
            'Arredondada para 2 casas (~1 km) para quem não é o dono, logado ou não; o dono (com token) vê a exata, como em /profiles/me.',
        },
        longitude: {
          type: 'number',
          nullable: true,
          minimum: -180,
          maximum: 180,
          description:
            'Arredondada para 2 casas (~1 km) para quem não é o dono, logado ou não; o dono (com token) vê a exata, como em /profiles/me.',
        },
        dropouts: ref('DropoutSummary'),
        totalXp: { ...nonnegativeInteger, description: 'XP acumulado (0 sem XP registrado).' },
        badges: {
          type: 'array',
          items: ref('Badge'),
          description:
            'Da mais recente para a mais antiga; no mesmo segundo, a concedida por último vem antes.',
        },
        featuredBadges: {
          type: 'array',
          maxItems: 3,
          items: ref('Badge'),
          description: 'RN-058: as 3 primeiras de badges (não há escolha do freelancer).',
        },
      }),
      CancelTerms: obj({ dropout: nullableRef('DropoutPreview') }),
      AdminDropouts: { type: 'array', items: ref('AdminDropout') },
      OfferDecision: {
        ...obj({ seq: { type: 'integer', minimum: 1, maximum: 5 } }),
        additionalProperties: false,
        description:
          'Sequência da oferta vista; outra oferta no lugar: 409 offer_changed. Corpo vazio só é compatível com a proposta inicial (oferta 1).',
      },
      Contract: obj({
        id: { type: 'integer' },
        ulid: { type: 'string' },
        clientId: { type: 'integer' },
        freelancerId: { type: 'integer' },
        serviceId: { type: 'integer', nullable: true },
        title: { type: 'string' },
        description: { type: 'string' },
        price: { type: 'number' },
        platformFee: { type: 'number' },
        freelancerNet: { type: 'number' },
        paymentMode: { type: 'string', enum: ['cash', 'credits', 'barter', 'hybrid'] },
        status: {
          type: 'string',
          enum: [
            'pending',
            'accepted',
            'rejected',
            'in_progress',
            'delivered',
            'revision_requested',
            'completed',
            'cancelled',
            'disputed',
          ],
        },
        deadlineAt: nullableTimestamp,
        createdAt: timestamp,
        hasReview: { type: 'boolean' },
        hasMilestones: { type: 'boolean' },
        deadlineExtendedAt: nullableTimestamp,
        overdueNotifiedAt: nullableTimestamp,
        extension: { type: 'object', nullable: true },
        deadline: { type: 'object' },
        approvalDueAt: nullableTimestamp,
        proposalExpiresAt: nullableTimestamp,
        deadlineZone: { type: 'string', enum: brazilTimezones },
        revisionRequestedAt: nullableTimestamp,
        revisions: {
          ...nullableRef('RevisionState'),
          description:
            'Entrega única: revisões usadas e limite. null por marcos; limit null no legado ilimitado. Ausente nas versões anteriores.',
        },
        package: {
          ...nullableRef('ServicePackage'),
          description:
            'RF-086: o pacote contratado, como estava publicado na proposta (editar o serviço depois não muda). null sem pacote; ausente nas versões anteriores.',
        },
        clientCompany: {
          ...nullableRef('CompanyRef'),
          description:
            'RF-018: quem contrata é conta de empresa (nome fantasia e ulid do perfil público); null quando é pessoa. Ausente nas versões anteriores.',
        },
        disputeOpensAt: {
          ...nullableTimestamp,
          description:
            'Instante da abertura manual (RN-062), incluindo o snapshot da primeira entrega. null fora dos estados disputáveis; a automática da RN-029 não espera esta janela.',
        },
        negotiation: {
          ...nullableRef('Negotiation'),
          description:
            'Em pending, fora da troca. Na lista, current é null; no detalhe, traz a oferta atual. Ausente em versões anteriores da API.',
        },
      }),
      ContractWithHistory: {
        allOf: [
          ref('Contract'),
          obj(
            {
              history: { type: 'array', items: { type: 'object' } },
              milestones: { type: 'array', items: ref('Milestone') },
              review: { type: 'object', nullable: true },
              cancellation: nullableRef('CancelTerms'),
              dropout: nullableRef('ContractDropout'),
              deliveries: {
                type: 'array',
                items: ref('ContractDelivery'),
                description:
                  'Entregas únicas, da primeira à reentrega mais recente. Vazio sem entrega ou por marcos (cada marco traz deliveryNote).',
              },
              offers: {
                type: 'array',
                items: ref('ContractOffer'),
                description: 'Ofertas em ordem de sequência; ausente em versões anteriores da API.',
              },
            },
            ['history', 'milestones', 'review', 'cancellation'],
          ),
        ],
      },
      Milestone: obj({
        id: { type: 'integer' },
        title: { type: 'string' },
        description: { type: 'string', nullable: true },
        amount: { type: 'number' },
        freelancerNet: { type: 'number' },
        sortOrder: nonnegativeInteger,
        status: {
          type: 'string',
          enum: ['pending', 'funded', 'delivered', 'approved', 'released', 'cancelled'],
        },
        dueAt: nullableTimestamp,
        deliveredAt: nullableTimestamp,
        deliveryNote: { type: 'string', nullable: true },
        revisionNote: { type: 'string', nullable: true },
        releasedAt: nullableTimestamp,
        approvalDueAt: nullableTimestamp,
        dueZone: { type: 'string', enum: brazilTimezones },
        revisionRequestedAt: nullableTimestamp,
        revisions: {
          ...ref('RevisionState'),
          description:
            'Uso/limite deste marco; limit null no legado. Ausente nas versões anteriores.',
        },
        attachments: {
          type: 'array',
          items: ref('DeliveryAttachment'),
          description:
            'Arquivos das entregas deste marco (RF-035), na ordem de envio. Ausente nas versões anteriores.',
        },
      }),
      ContractsPage: obj(
        {
          items: { type: 'array', items: ref('Contract') },
          page: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          total: {
            ...nonnegativeInteger,
            description:
              'Todas as contratações em que a pessoa é cliente ou freelancer, já com o filtro de status.',
          },
        },
        ['items', 'page', 'limit', 'total'],
      ),
      ContractDelivery: obj(
        {
          id: { type: 'integer', minimum: 1 },
          message: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          attachments: {
            type: 'array',
            items: ref('DeliveryAttachment'),
            description:
              'Arquivos enviados com a entrega (RF-035). Ausente nas versões anteriores da API.',
          },
          deliveredAt: timestamp,
        },
        ['id', 'message', 'files', 'deliveredAt'],
      ),
      DeliveryAttachment: obj(
        {
          messageId: {
            type: 'integer',
            minimum: 1,
            description: 'Mensagem do chat que guarda o arquivo (alvo de denúncia "message").',
          },
          name: { type: 'string', description: 'Vazio quando removido pela moderação.' },
          mime: { type: 'string' },
          size: nonnegativeInteger,
          url: {
            type: 'string',
            description:
              'GET /messaging/attachments/{messageId}: só as partes baixam; 410 se expurgado ou removido.',
          },
          purgedAt: nullableTimestamp,
          purgedReason: {
            type: 'string',
            enum: ['retention', 'lgpd', 'missing'],
            nullable: true,
          },
          removedAt: nullableTimestamp,
          sentAt: timestamp,
        },
        [
          'messageId',
          'name',
          'mime',
          'size',
          'url',
          'purgedAt',
          'purgedReason',
          'removedAt',
          'sentAt',
        ],
      ),
      Deliver: obj(
        {
          message: { type: 'string', minLength: 1 },
          files: {
            type: 'array',
            maxItems: 20,
            items: { type: 'string', format: 'uri' },
            description: 'Links da entrega.',
          },
        },
        ['message'],
      ),
      DeliverForm: obj(
        {
          message: { type: 'string', minLength: 1 },
          files: {
            type: 'array',
            maxItems: 20,
            items: { type: 'string', format: 'uri' },
            description: 'Links, com o campo repetido.',
          },
          attachments: {
            type: 'array',
            maxItems: 10,
            items: { type: 'string', format: 'binary' },
            description:
              'Até 10 arquivos (JPG, PNG, GIF, WebP, PDF ou ZIP, reconhecidos pelo conteúdo), cada um até UPLOAD_MAX_MB e 24 MB somados. Viram anexos do chat do par ligados à entrega.',
          },
        },
        ['message'],
      ),
      DeliverMilestone: obj({ message: { type: 'string', minLength: 1 } }, ['message']),
      DeliverMilestoneForm: obj(
        {
          message: { type: 'string', minLength: 1 },
          attachments: {
            type: 'array',
            maxItems: 10,
            items: { type: 'string', format: 'binary' },
            description: 'Os mesmos limites da entrega única. O marco não guarda links.',
          },
        },
        ['message'],
      ),
      ExtensionDecision: obj({
        seq: {
          type: 'integer',
          minimum: 0,
          maximum: 2,
          description:
            'Número do pedido que o cliente viu (extension.seq). Outro pedido no lugar: 409 extension_changed',
        },
      }),
      CreateBarter: obj(
        {
          receiverId: { type: 'integer' },
          offeredServiceId: { type: 'integer', nullable: true },
          offeredDescription: { type: 'string', nullable: true },
          requestedServiceId: { type: 'integer', nullable: true },
          requestedDescription: { type: 'string', nullable: true },
          estimatedValueOffered: {
            type: 'number',
            description:
              'RF-084: com serviço oferecido de preço fechado, vale o catálogo (pode faltar; diferente é 422 estimate_mismatch). A combinar, por hora ou oferta descrita: obrigatório (422 estimate_required).',
          },
          estimatedValueRequested: {
            type: 'number',
            description:
              'RF-084: com serviço pedido de preço fechado, vale o catálogo (pode faltar; diferente é 422 estimate_mismatch). A combinar, por hora ou pedido descrito: obrigatório (422 estimate_required).',
          },
        },
        ['receiverId'],
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
          pixKey: { type: 'string', nullable: true, description: 'Obrigatória com method pix.' },
          bankName: {
            type: 'string',
            maxLength: 100,
            nullable: true,
            description: 'Com method bank, banco, agência e conta são obrigatórios.',
          },
          bankAgency: { type: 'string', maxLength: 10, nullable: true },
          bankAccount: { type: 'string', maxLength: 20, nullable: true },
        },
        ['amount', 'method'],
      ),
      ChangePassword: obj(
        {
          currentPassword: { type: 'string', minLength: 1 },
          newPassword: { type: 'string', minLength: 8 },
        },
        ['currentPassword', 'newPassword'],
      ),
      RefreshResponse: obj({ accessToken: { type: 'string' }, refreshToken: { type: 'string' } }, [
        'accessToken',
        'refreshToken',
      ]),
      // Verificação em duas etapas (RF-090, RNF-042, ADR 66).
      MfaChallenge: {
        ...obj(
          {
            mfaRequired: { type: 'boolean', enum: [true] },
            mfaToken: {
              type: 'string',
              description:
                'Passe de 5 minutos, só para POST /auth/login/mfa: não serve como token de acesso.',
            },
            expiresInSeconds: { type: 'integer', minimum: 1 },
          },
          ['mfaRequired', 'mfaToken', 'expiresInSeconds'],
        ),
        additionalProperties: false,
      },
      LoginMfa: obj(
        {
          mfaToken: { type: 'string', minLength: 1, maxLength: 2048 },
          code: {
            type: 'string',
            minLength: 1,
            maxLength: 32,
            description:
              '6 dígitos do app autenticador (espaços valem) ou um código de recuperação XXXX-XXXX (sem diferença de maiúsculas; O vale 0, I e L valem 1)',
          },
        },
        ['mfaToken', 'code'],
      ),
      MfaStatus: obj(
        {
          enabled: { type: 'boolean' },
          confirmedAt: nullableTimestamp,
          recoveryCodesLeft: nonnegativeInteger,
          available: {
            type: 'boolean',
            description:
              'O servidor tem a FIELD_ENCRYPTION_KEY, que cifra o segredo: sem ela, não dá para ativar',
          },
          required: {
            type: 'boolean',
            description: 'Conta admin num servidor com ADMIN_MFA_REQUIRED: o painel exige a 2FA',
          },
        },
        ['enabled', 'confirmedAt', 'recoveryCodesLeft', 'available', 'required'],
      ),
      MfaPassword: obj({ password: { type: 'string', minLength: 1 } }, ['password']),
      MfaSetup: obj(
        {
          secret: {
            type: 'string',
            pattern: '^[A-Z2-7]{32}$',
            description: 'Base32 (RFC 4648, sem o "=" do fim), para digitar no app',
          },
          otpauthUrl: {
            type: 'string',
            description:
              'otpauth://totp/Escambo:<e-mail>?secret=<base32>&issuer=Escambo&algorithm=SHA1&digits=6&period=30 (o conteúdo do QR)',
          },
        },
        ['secret', 'otpauthUrl'],
      ),
      MfaCode: obj({ code: { type: 'string', minLength: 1, maxLength: 32 } }, ['code']),
      MfaConfirm: obj(
        {
          password: { type: 'string', minLength: 1 },
          code: { type: 'string', minLength: 1, maxLength: 32 },
        },
        ['password', 'code'],
      ),
      MfaRecoveryCodesResponse: obj(
        {
          recoveryCodes: {
            type: 'array',
            minItems: 10,
            maxItems: 10,
            items: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$' },
            description: 'Mostrados uma vez: o servidor guarda só o hash de cada um',
          },
        },
        ['recoveryCodes'],
      ),
      MfaEnabledResponse: {
        allOf: [ref('RefreshResponse'), ref('MfaRecoveryCodesResponse')],
      },
      AdminAccountLookup: obj(
        {
          ulid: { type: 'string' },
          email: { type: 'string', format: 'email' },
          role: { type: 'string', enum: ['client', 'freelancer', 'company', 'admin'] },
          status: ref('UserStatus'),
          mfaEnabled: { type: 'boolean' },
          createdAt: timestamp,
          cpf: {
            ...nullableRef('AdminCpfSummary'),
            description: 'RF-020: o CPF do perfil de freelancer, só mascarado; null sem o perfil',
          },
          company: {
            type: 'object',
            nullable: true,
            properties: { tradeName: { type: 'string' }, cnpj: { type: 'string' } },
            description: 'RF-018: na conta de empresa, o nome fantasia e o CNPJ (dado público)',
          },
        },
        ['ulid', 'email', 'role', 'status', 'mfaEnabled', 'createdAt', 'cpf', 'company'],
      ),
      ResetMfa: obj({ reason: { type: 'string', minLength: 10, maxLength: 500 } }, ['reason']),
      // Contato da conta (RF-017): só o titular vê; o perfil público não traz e-mail nem telefone.
      PendingEmailChange: obj(
        { email: { type: 'string', format: 'email' }, expiresAt: timestamp },
        ['email', 'expiresAt'],
      ),
      AccountContact: obj(
        {
          email: { type: 'string', format: 'email' },
          emailVerified: { type: 'boolean' },
          phone: {
            type: 'string',
            nullable: true,
            pattern: '^\\+55\\d{10,11}$',
            description: 'E.164 (+55, DDD e número); null quando não informado',
          },
          pendingEmail: nullableRef('PendingEmailChange'),
        },
        ['email', 'emailVerified', 'phone', 'pendingEmail'],
      ),
      ChangeEmail: obj(
        {
          currentPassword: { type: 'string', minLength: 1 },
          newEmail: { type: 'string', format: 'email', maxLength: 255 },
        },
        ['currentPassword', 'newEmail'],
      ),
      ConfirmEmailChange: obj({ token: { type: 'string', minLength: 16, maxLength: 255 } }, [
        'token',
      ]),
      ConfirmEmailChangeResponse: obj(
        { email: { type: 'string', format: 'email' }, session: nullableRef('RefreshResponse') },
        ['email', 'session'],
      ),
      UpdatePhone: obj(
        {
          phone: {
            type: 'string',
            nullable: true,
            maxLength: 30,
            description:
              'Número do Brasil com DDD em qualquer formato comum ("(47) 99999-1234", "+55 47 3333-1234"); null ou vazio apaga',
          },
        },
        ['phone'],
      ),
      Service: obj(
        {
          id: { type: 'integer', minimum: 1 },
          categoryId: { type: 'integer', minimum: 1 },
          ownerId: { type: 'integer', minimum: 1 },
          title: { type: 'string' },
          description: { type: 'string' },
          priceType: { type: 'string', enum: ['fixed', 'hourly', 'negotiable'] },
          price: { type: 'number', nullable: true },
          deliveryDays: { type: 'integer', nullable: true },
          isRemote: { type: 'boolean', description: 'Atende remoto: true em remote e em both.' },
          modality: ref('ServiceModality'),
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags do serviço (RF-024), em ordem alfabética.',
          },
          packages: {
            type: 'array',
            maxItems: 3,
            items: ref('ServicePackage'),
            description:
              'Pacotes (RF-086), do Básico ao Premium; [] sem pacotes. Com pacotes, price e deliveryDays são os do Básico ("a partir de").',
          },
          viewsCount: {
            type: 'integer',
            minimum: 0,
            description:
              'Visualizações do detalhe (RF-029). Só em GET /services/mine, para o dono; nunca na busca nem no detalhe público.',
          },
          isActive: { type: 'boolean' },
          createdAt: timestamp,
          boosted: { type: 'boolean', description: 'Impulsionamento ativo.' },
        },
        [
          'id',
          'categoryId',
          'ownerId',
          'title',
          'description',
          'priceType',
          'price',
          'deliveryDays',
          'isRemote',
          'isActive',
          'createdAt',
        ],
      ),
      UpdateService: {
        ...obj({
          categoryId: { type: 'integer', minimum: 1 },
          title: { type: 'string', minLength: 3, maxLength: 150 },
          description: { type: 'string', minLength: 10 },
          priceType: { type: 'string', enum: ['fixed', 'hourly', 'negotiable'] },
          price: { type: 'number', nullable: true },
          deliveryDays: { type: 'integer', minimum: 1, nullable: true },
          isRemote: { type: 'boolean' },
          modality: ref('ServiceModality'),
          tags: ref('ServiceTags'),
          packages: ref('ServicePackages'),
          isActive: { type: 'boolean', description: 'false pausa o serviço; true reativa.' },
        }),
        description:
          'Campos a mudar, todos opcionais: a edição manda o serviço inteiro; pausar e reativar mandam só isActive. Sem packages, os pacotes ficam como estão (e mudar o tipo de preço para outro que não o fixo é 422 packages_require_fixed_price).',
      },
      WalletTransaction: obj(
        {
          id: { type: 'integer', minimum: 1 },
          amount: { type: 'number', description: 'Variação do saldo disponível (+ entra, - sai).' },
          pendingDelta: { type: 'number', description: 'Variação do saldo retido.' },
          balanceAfter: { type: 'number' },
          pendingAfter: { type: 'number' },
          reason: {
            type: 'string',
            enum: [
              'deposit',
              'hold',
              'hold_release',
              'payment',
              'escrow_in',
              'escrow_release',
              'escrow_refund',
              'refund',
              'withdrawal',
              'withdrawal_refund',
              'barter_hold',
              'barter_payment',
              'barter_in',
            ],
          },
          contractId: { type: 'integer', nullable: true },
          paymentId: { type: 'integer', nullable: true },
          withdrawalId: { type: 'integer', nullable: true },
          createdAt: timestamp,
        },
        [
          'id',
          'amount',
          'pendingDelta',
          'balanceAfter',
          'pendingAfter',
          'reason',
          'contractId',
          'paymentId',
          'withdrawalId',
          'createdAt',
        ],
      ),
      WalletTransactionsPage: obj(
        {
          items: { type: 'array', items: ref('WalletTransaction') },
          page: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          hasMore: { type: 'boolean', description: 'Há lançamentos depois desta página.' },
        },
        ['items', 'page', 'limit', 'hasMore'],
      ),
      EarningsBucket: obj(
        {
          bucket: {
            type: 'string',
            description:
              'Início do período no fuso da conta: AAAA-MM-DD (dia; na semana, a segunda-feira) ou AAAA-MM (mês).',
          },
          amount: {
            type: 'number',
            description: 'R$ liberados do escrow mais tornas recebidas (já sem a taxa).',
          },
          contracts: { type: 'integer', minimum: 0 },
          barters: { type: 'integer', minimum: 0 },
        },
        ['bucket', 'amount', 'contracts', 'barters'],
      ),
      WalletEarnings: obj(
        {
          from: { type: 'string', format: 'date' },
          to: { type: 'string', format: 'date' },
          granularity: { type: 'string', enum: ['day', 'week', 'month'] },
          timezone: { type: 'string', enum: [...brazilTimezones] },
          hasEarnings: {
            type: 'boolean',
            description: 'Já recebeu alguma vez (R$ ou créditos), em qualquer data.',
          },
          totals: obj(
            {
              amount: { type: 'number' },
              contracts: {
                type: 'integer',
                minimum: 0,
                description: 'Contratações distintas com liberação no período.',
              },
              barters: {
                type: 'integer',
                minimum: 0,
                description: 'Trocas com torna recebida no período.',
              },
              averageTicket: {
                type: 'number',
                nullable: true,
                description: 'amount ÷ (contracts + barters); null sem nada pago no período.',
              },
            },
            ['amount', 'contracts', 'barters', 'averageTicket'],
          ),
          series: {
            type: 'array',
            items: ref('EarningsBucket'),
            description: 'Todos os períodos de from a to, os vazios com zero.',
          },
          credits: obj(
            {
              total: {
                type: 'integer',
                description:
                  'Créditos (time-bank) à parte: entram no aceite e as devoluções descontam no dia em que acontecem.',
              },
              contracts: { type: 'integer', minimum: 0 },
            },
            ['total', 'contracts'],
          ),
        },
        ['from', 'to', 'granularity', 'timezone', 'hasEarnings', 'totals', 'series', 'credits'],
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
      ...preparedContractSchemas,
      ...packageSchemas,
      ...supportSchemas,
      ...withdrawalSchemas,
      ...chatReadSchemas,
    },
  },
  paths: {
    '/support/tickets': {
      get: {
        ...op('Suporte', 'Lista os chamados do titular, inclusive durante suspensão', {
          auth: true,
          responses: jsonResponse('200', 'SupportTicketPage'),
        }),
        parameters: supportListParameters,
      },
      post: op('Suporte', 'Abre chamado privado; até três não encerrados e sem duplicação', {
        auth: true,
        body: ref('CreateSupportTicket'),
        responses: { ...jsonResponse('201', 'SupportTicketDetail'), ...supportErrors },
      }),
    },
    '/support/tickets/{id}': {
      parameters: supportDetailParameters,
      get: op('Suporte', 'Conversa pública do titular, sem notas internas', {
        auth: true,
        responses: { ...jsonResponse('200', 'SupportTicketDetail'), ...supportErrors },
      }),
    },
    '/support/tickets/{id}/messages': {
      parameters: offerPathParameters,
      post: op(
        'Suporte',
        'Responde e retoma atendimento resolvido há menos de cinco dias; encerrado é terminal',
        {
          auth: true,
          body: ref('ReplySupportTicket'),
          responses: { ...jsonResponse('201', 'SupportTicketDetail'), ...supportErrors },
        },
      ),
    },
    '/support/tickets/{id}/close': {
      parameters: offerPathParameters,
      post: op('Suporte', 'Titular encerra o chamado e libera uma vaga', {
        auth: true,
        responses: { ...jsonResponse('200', 'SupportTicketDetail'), ...supportErrors },
      }),
    },
    '/admin/support/tickets': {
      get: {
        ...op('Admin', 'Fila privada de suporte; exige administrador ativo atual', {
          auth: true,
          responses: { ...jsonResponse('200', 'SupportTicketPage'), ...supportErrors },
        }),
        parameters: supportListParameters,
      },
    },
    '/admin/support/tickets/{id}': {
      parameters: supportDetailParameters,
      get: op(
        'Admin',
        'Histórico de suporte com notas internas; titular removido é somente consulta',
        {
          auth: true,
          responses: { ...jsonResponse('200', 'SupportTicketDetail'), ...supportErrors },
        },
      ),
      patch: op(
        'Admin',
        'Altera prioridade ou estado; SLA de 72/24/8/2 horas desde a abertura, sem reinício',
        {
          auth: true,
          body: ref('UpdateSupportTicket'),
          responses: { ...jsonResponse('200', 'SupportTicketDetail'), ...supportErrors },
        },
      ),
    },
    '/admin/support/tickets/{id}/messages': {
      parameters: offerPathParameters,
      post: op(
        'Admin',
        'Responde, anota internamente ou resolve; resolução encerra após cinco dias corridos',
        {
          auth: true,
          body: ref('AdminReplySupportTicket'),
          responses: { ...jsonResponse('201', 'SupportTicketDetail'), ...supportErrors },
        },
      ),
    },
    '/health': { get: op('Health', 'Readiness — status da API + ping no banco') },
    '/health/live': { get: op('Health', 'Liveness — processo responde (sem tocar no banco)') },

    '/auth/register': {
      post: op(
        'Auth',
        'Cria conta. Conta de empresa (role company, RF-018) nasce com o perfil da empresa: razão social, nome fantasia e CNPJ únicos entre contas',
        {
          body: { $ref: '#/components/schemas/Register' },
          responses: {
            ...res201,
            '409': errorResponse('email_taken ou cnpj_taken'),
            '422': errorResponse('validation_error (CNPJ: dígitos verificadores, todos iguais)'),
          },
        },
      ),
    },
    '/auth/login': {
      post: op(
        'Auth',
        'Autentica (accessToken + refreshToken). Conta com a verificação em duas etapas ativa recebe o MfaChallenge, sem sessão, e conclui em POST /auth/login/mfa',
        {
          body: { $ref: '#/components/schemas/Login' },
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: { oneOf: [ref('AuthResponse'), ref('MfaChallenge')] },
                },
              },
            },
          },
        },
      ),
    },
    '/auth/login/mfa': {
      post: op(
        'Auth',
        'Segundo passo do login (ADR 66): o passe do MfaChallenge e o código do app ou um de recuperação (uso único). 5 códigos errados seguidos travam a 2FA da conta por 15 minutos',
        {
          body: ref('LoginMfa'),
          responses: {
            ...jsonResponse('200', 'AuthResponse'),
            '400': errorResponse('invalid_mfa_code (código errado, já usado ou de outro passo)'),
            '401': errorResponse(
              'invalid_mfa_token (passe vencido, inválido, ou a conta não tem mais a 2FA): volte à senha',
            ),
            '403': errorResponse('account_banned ou account_deleted (as mesmas do login)'),
            '422': errorResponse('validation_error: details.mfaToken ou details.code'),
            '429': errorResponse(
              'mfa_locked (5 erros seguidos: 15 minutos) ou too_many_requests (o limite do login, por IP)',
            ),
            '500': errorResponse(
              'mfa_unreadable: o segredo gravado não decifra com a chave do servidor (o código de recuperação ainda vale)',
            ),
          },
        },
      ),
    },
    '/auth/refresh': { post: op('Auth', 'Rotaciona o refresh token') },
    '/auth/logout': { post: op('Auth', 'Revoga a sessão') },
    '/auth/logout-all': {
      post: op('Auth', 'Encerra todas as sessões', { auth: true, responses: res200 }),
    },
    '/auth/me': {
      get: op('Auth', 'Dados atuais do usuário; suspensão conserva consulta', {
        auth: true,
        responses: {
          '200': {
            ...jsonResponse('200', 'PublicUser')['200'],
            headers: {
              'X-Account-Status': {
                description:
                  'Status atual também enviado pelas demais respostas autenticadas permitidas (exposto via CORS).',
                schema: ref('UserStatus'),
              },
            },
          },
        },
      }),
    },

    '/categories': { get: op('Categorias', 'Árvore de categorias') },

    '/profiles/me': { get: op('Perfis', 'Meus perfis', { auth: true }) },
    '/profiles/me/dropouts': {
      get: op(
        'Perfis',
        'Minhas desistências e contagem atual (RN-026); inclui contexto privado e decisão da equipe',
        {
          auth: true,
          responses: jsonResponse('200', 'MyDropouts'),
        },
      ),
    },
    '/profiles/me/dropouts/{id}/appeal': {
      post: {
        ...op(
          'Perfis',
          'Contesta uma desistência uma vez enquanto conta; a contestação mantém a contagem (404 dropout_not_found; 409 appeal_closed)',
          {
            auth: true,
            body: ref('DropoutAppeal'),
            responses: {
              ...jsonResponse('200', 'MyDropout'),
              '409': { description: 'appeal_closed' },
            },
          },
        ),
        parameters: offerPathParameters,
      },
    },
    '/profiles/freelancer': {
      put: op('Perfis', 'Cria/edita perfil de freelancer', { auth: true }),
    },
    '/profiles/client': { put: op('Perfis', 'Cria/edita perfil de cliente', { auth: true }) },
    '/profiles/company': {
      put: op(
        'Perfis',
        'Edita os dados da empresa (RF-018), só de conta de empresa: razão social, nome fantasia e CNPJ continuam obrigatórios; logo, site, descrição curta, cidade e UF. A troca do CNPJ vai para a auditoria',
        {
          auth: true,
          body: ref('UpsertCompanyProfile'),
          responses: {
            ...jsonResponse('200', 'CompanyProfile'),
            '403': errorResponse('not_company ou conta bloqueada'),
            '409': errorResponse('cnpj_taken'),
            '422': errorResponse('validation_error'),
          },
        },
      ),
    },
    '/profiles/company/{ulid}': {
      get: {
        ...op(
          'Perfis',
          'Página pública da empresa (RF-018): logo, nome fantasia, razão social, CNPJ (dado público), site, descrição curta e cidade',
          {
            responses: {
              ...jsonResponse('200', 'PublicCompanyProfile'),
              '404': errorResponse('company_not_found'),
            },
          },
        ),
        parameters: [{ name: 'ulid', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },
    '/profiles/me/cpf': {
      get: op(
        'Perfis',
        'CPF do freelancer (RF-020): se o servidor valida, se o saque pede, e o CPF só mascarado (nunca inteiro)',
        { auth: true, responses: jsonResponse('200', 'CpfStatus') },
      ),
      put: op(
        'Perfis',
        'Valida e grava o CPF e a data de nascimento (RF-020, RN-009, RN-075): dígitos verificadores, unicidade entre contas pelo índice cego e 18 anos no dia de hoje do fuso da conta; não é consulta à Receita. O CPF é gravado só cifrado e, validado, não se altera pela tela (a correção é pelo atendimento). Mesmo limite do login',
        {
          auth: true,
          body: ref('VerifyCpf'),
          responses: {
            ...jsonResponse('200', 'CpfStatus'),
            '409': errorResponse('no_freelancer_profile, cpf_locked ou cpf_taken'),
            '422': errorResponse('validation_error, underage ou invalid_birth_date'),
            '429': errorResponse('too_many_requests'),
            '503': errorResponse('cpf_unavailable (sem FIELD_ENCRYPTION_KEY)'),
          },
        },
      ),
    },
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
        ...op(
          'Perfis',
          'Perfil público do freelancer (nota, nível, XP, badges com até 3 em destaque e resumo de desistências sem datas ou textos privados). Latitude e longitude saem arredondadas para ~1 km para quem não é o dono; o token é opcional e só serve para reconhecer o dono, que vê o valor exato',
          { responses: jsonResponse('200', 'PublicFreelancerProfile') },
        ),
        parameters: [{ name: 'ulid', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },

    '/services': {
      get: {
        ...op(
          'Serviços',
          'Lista/busca serviços (categoryId, q, isRemote, minPrice/maxPrice, maxDeliveryDays, minRating, day=0..6 (atende no dia), period=morning|afternoon|evening (com day; dia e período valem no fuso de cada freelancer), now=true (atende agora, no fuso de cada freelancer — ADR 48), sort, page, limit; lat+lng+radiusKm = descoberta local por proximidade)',
        ),
        parameters: [
          {
            name: 'q',
            in: 'query',
            required: false,
            schema: { type: 'string', minLength: 1, maxLength: 255 },
            description:
              'Texto (RNF-004): título e descrição pelo FULLTEXT em BOOLEAN MODE, cada palavra obrigatória e como prefixo ("design" acha "designer"); palavras vazias ("de", "para", "the") são ignoradas; palavra com menos de 3 letras ("ux", "3d", "c++") vale como "contém". Também acha pelas tags: o nome que começa com o texto inteiro. A ordenação continua a do sort (relevância = destaque primeiro).',
          },
          {
            name: 'isRemote',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['true', 'false'] },
            description:
              'true = atende remoto, false = atende presencial; o serviço que atende dos dois jeitos (modality both) entra nos dois.',
          },
        ],
      },
      post: op('Serviços', 'Cria serviço', {
        auth: true,
        body: { $ref: '#/components/schemas/CreateService' },
        responses: {
          ...jsonResponse('201', 'Service'),
          '422': errorResponse(
            'validation_error, price_below_minimum, invalid_category; com pacotes (RF-086): packages_require_fixed_price, price_from_packages, package_price_order',
          ),
        },
      }),
    },
    '/services/mine': {
      get: op(
        'Serviços',
        'Meus serviços (pausados inclusive): sempre os de quem está logado (?ownerId é ignorado), sem os excluídos e sem paginação, do mais novo ao mais antigo, com boosted, tags e viewsCount (RF-029, só aqui) e sem os campos do prestador',
        {
          auth: true,
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': { schema: { type: 'array', items: ref('Service') } },
              },
            },
            '401': errorResponse('missing_token ou invalid_token'),
            '403': errorResponse('account_blocked'),
          },
        },
      ),
    },
    '/services/{id}': {
      get: {
        ...op(
          'Serviços',
          'Detalhe do serviço (público, pausado inclusive): o serviço com quem presta, destaque, modalidade e tags. Abrir conta uma visualização (RF-029) quando quem abre não é o dono — o token é opcional e só serve para reconhecer o dono — e o mesmo visitante (conta, ou IP sem login) conta uma vez a cada 30 min. O número não sai aqui: só em /services/mine.',
          {
            responses: {
              ...jsonResponse('200', 'Service'),
              '404': errorResponse('service_not_found'),
              '422': errorResponse('validation_error: id que não é inteiro positivo'),
            },
          },
        ),
      },
      patch: op('Serviços', 'Atualiza (dono): edita o serviço inteiro ou pausa/reativa', {
        auth: true,
        body: ref('UpdateService'),
        responses: {
          ...jsonResponse('200', 'Service'),
          '403': errorResponse('forbidden: o serviço não é seu'),
          '404': errorResponse('service_not_found'),
          '422': errorResponse(
            'validation_error, price_required, price_below_minimum, invalid_category; com pacotes (RF-086): packages_require_fixed_price, price_from_packages, package_price_order',
          ),
        },
      }),
      delete: op('Serviços', 'Remove (dono, soft delete)', { auth: true, responses: res204 }),
    },

    '/contracts': {
      get: {
        ...op(
          'Contratações',
          'Minhas contratações (como cliente ou freelancer), com a vez da negociação (current nulo na lista) e o total; ordem created_at DESC, id DESC',
          {
            auth: true,
            responses: {
              ...jsonResponse('200', 'ContractsPage'),
              '401': errorResponse('missing_token ou invalid_token'),
              '422': errorResponse(
                'validation_error: status desconhecido (details.status = ["Status de contratação desconhecido"]) ou page/limit fora da faixa',
              ),
            },
          },
        ),
        parameters: [
          ...pageParameters,
          {
            name: 'status',
            in: 'query',
            description:
              'Filtro (RF-040): separado por vírgula (?status=accepted,in_progress) ou com o parâmetro repetido (?status=completed&status=cancelled). Repetidos são ignorados; vazio vale como sem filtro.',
            style: 'form',
            explode: true,
            schema: {
              type: 'array',
              items: {
                type: 'string',
                enum: [
                  'pending',
                  'accepted',
                  'rejected',
                  'in_progress',
                  'delivered',
                  'revision_requested',
                  'completed',
                  'cancelled',
                  'disputed',
                ],
              },
            },
          },
        ],
      },
      post: op('Contratações', 'Cria proposta e reserva o valor', {
        auth: true,
        body: { $ref: '#/components/schemas/CreateContract' },
        responses: {
          ...jsonResponse('201', 'Contract'),
          '409': {
            description:
              'RN-020: active_contract_exists se há contratação direta aberta no mesmo par cliente→freelancer, independentemente do serviço ou pagamento. Trocas são independentes. Também pode ocorrer service_inactive e, com pacote (RF-086), package_changed: o preço do pacote mudou.',
            content: {
              'application/json': { schema: { anyOf: [ref('ActiveContractError'), ref('Error')] } },
            },
          },
          '422': errorResponse(
            'validation_error; com pacotes (RF-086): package_required, package_not_found, deadline_before_package, milestone_after_deadline',
          ),
        },
      }),
    },
    '/contracts/{id}': {
      get: op(
        'Contratações',
        'Detalhe + histórico e ofertas da negociação (RN-030), com o prazo (deadline: state, noticeAt, mediationAt, extensionRequestsLeft), approvalDueAt, proposalExpiresAt, extension.respondBy/seq, cancellation: o que cancelar (cliente) ou desistir (freelancer) faria agora (ADR 57), deadlineZone (o fuso em que o prazo é um dia), revisionRequestedAt e, nos marcos, dueZone e revisionRequestedAt (ADR 58)',
        { auth: true, responses: jsonResponse('200', 'ContractWithHistory') },
      ),
    },
    '/contracts/{id}/offers': {
      post: {
        ...op('Contratações', 'Envia contraproposta na vez de quem chama (RN-030)', {
          auth: true,
          body: ref('CounterOfferRequest'),
          responses: {
            ...jsonResponse('201', 'ContractWithHistory'),
            '400': {
              description:
                'deadline_too_soon: não cabe ao menos uma hora para responder antes da entrega',
            },
            '402': {
              description:
                'insufficient_balance: saldo insuficiente para aumentar a reserva do cliente',
            },
            '403': { description: 'forbidden: quem chama não participa da contratação' },
            '409': {
              description:
                'invalid_transition, not_your_turn, offer_changed, offer_limit, proposal_expired ou offer_fee_invalid',
            },
            '422': {
              description:
                'Validação, invalid_offer, offer_deadline_invalid, offer_unchanged, offer_shape ou milestones_mismatch',
            },
          },
        }),
        parameters: offerPathParameters,
      },
    },
    '/contracts/{id}/offers/{seq}/accept': {
      post: {
        ...op('Contratações', 'Cliente aceita a contraproposta par e financia o escrow (RN-030)', {
          auth: true,
          responses: {
            ...jsonResponse('200', 'ContractWithHistory'),
            '402': {
              description: 'insufficient_balance: saldo insuficiente para a diferença da oferta',
            },
            '403': { description: 'forbidden: ação exclusiva do cliente da contratação' },
            '409': {
              description:
                'invalid_transition, not_your_turn, offer_changed, proposal_expired, deadline_passed, freelancer_unavailable, offer_fee_invalid ou insufficient_credits',
            },
            '422': { description: 'Id ou sequência inválidos' },
          },
        }),
        parameters: [
          ...offerPathParameters,
          {
            name: 'seq',
            in: 'path',
            required: true,
            schema: { type: 'integer', minimum: 1, maximum: 5 },
          },
        ],
      },
    },
    '/contracts/{id}/accept': {
      post: op(
        'Contratações',
        'Freelancer aceita a oferta ímpar (financia escrow). 409 not_your_turn, offer_changed, deadline_passed ou proposal_expired',
        {
          auth: true,
          body: ref('OfferDecision'),
          bodyRequired: false,
          responses: jsonResponse('200', 'Contract'),
        },
      ),
    },
    '/contracts/{id}/reject': {
      post: op(
        'Contratações',
        'Freelancer recusa a oferta ou sai da negociação; 409 offer_changed',
        {
          auth: true,
          body: ref('OfferDecision'),
          bodyRequired: false,
          responses: jsonResponse('200', 'Contract'),
        },
      ),
    },
    '/contracts/{id}/deliver': {
      post: {
        ...op(
          'Contratações',
          'Registra entrega; o aviso ao cliente (contract_delivered) termina com " Mensagem: " e o começo da mensagem, numa linha só, até 120 caracteres com reticências. Com arquivos (RF-035), multipart: os arquivos viram anexos do chat do par ligados à entrega, na mesma transação',
          {
            auth: true,
            responses: {
              ...res200,
              '409': errorResponse('conflict, invalid_transition, use_milestones'),
              '413': errorResponse('file_too_large: um arquivo; files_too_large: a soma'),
              '422': errorResponse(
                'validation_error, empty_file, unsupported_file_type, too_many_files, invalid_upload',
              ),
            },
          },
        ),
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: ref('Deliver') },
            'multipart/form-data': { schema: ref('DeliverForm') },
          },
        },
      },
    },
    '/contracts/{id}/approve': {
      post: op('Contratações', 'Cliente aprova (libera escrow)', { auth: true }),
    },
    '/contracts/{id}/cancel': {
      post: op(
        'Contratações',
        'Cancela (cliente) ou desiste (freelancer), RN-025/RN-026 (ADR 57): a desistência devolve tudo ao cliente; prazo vencido sem entrega, a partir do aviso, também. 409 cancel_quote_changed, wait_notice, extension_pending_answer, milestone_open, use_reject, invalid_transition',
        { auth: true, body: { $ref: '#/components/schemas/CancelContract' } },
      ),
    },
    '/contracts/{id}/dropout/agreed': {
      post: {
        ...op(
          'Contratações',
          'Cliente confirma desistência combinada até 7 dias inclusive; o dinheiro não muda (404 dropout_not_found; 409 dropout_agree_closed)',
          {
            auth: true,
            body: ref('DropoutAgreement'),
            bodyRequired: false,
            responses: {
              ...jsonResponse('200', 'ContractDropout'),
              '409': { description: 'dropout_agree_closed' },
            },
          },
        ),
        parameters: offerPathParameters,
      },
    },
    '/notifications/push': {
      get: op(
        'Notificações',
        'Chave VAPID, quantos aparelhos recebem avisos, com ?endpoint= se este aparelho é desta conta (ADR 52), held: avisos retidos pelo silêncio que o resumo vai cobrir (ADR 54), e deliversWork: a conta entrega trabalho e vê a escolha do que sai no silêncio (ADR 56)',
        { auth: true },
      ),
      post: op(
        'Notificações',
        'Liga os avisos neste aparelho; o endpoint precisa ser https de um serviço de push conhecido',
        {
          auth: true,
          responses: { '201': { description: 'Criado' } },
          body: obj(
            {
              endpoint: { type: 'string', format: 'uri', maxLength: 512 },
              p256dh: { type: 'string' },
              auth: { type: 'string' },
            },
            ['endpoint', 'p256dh', 'auth'],
          ),
        },
      ),
      delete: op('Notificações', 'Desliga este aparelho', {
        auth: true,
        responses: { '204': { description: 'Sem conteúdo' } },
        body: obj({ endpoint: { type: 'string', format: 'uri', maxLength: 512 } }, ['endpoint']),
      }),
    },
    '/notifications/push/test': {
      post: op('Notificações', 'Aviso de teste para os aparelhos da conta', { auth: true }),
    },
    '/notifications/preferences': {
      get: op(
        'Notificações',
        'Preferências de aviso: e-mail (instant | daily | off), hora do resumo do dia (digestHour, 0 a 23; sem escolha, a hora padrão), fuso da conta (timezone, um dos fusos do Brasil; sem escolha, America/Sao_Paulo), a janela de silêncio do push (quietHours {start, end} em horas cheias no fuso da conta, ou null; ADR 54) e o que sai durante ela (quietPass: lista de categorias — hoje só "deadline", o prazo vencido num trabalho que a pessoa entrega; [] = nada; null = nunca escolheu, que vale como nada; ADR 56)',
        { auth: true },
      ),
      put: op(
        'Notificações',
        'Muda qualquer parte das preferências de aviso: frequência dos e-mails, hora do resumo do dia, fuso da conta (hora e fuso valem para o e-mail diário, para os alertas diários das buscas salvas e para as datas nos avisos; null volta ao padrão), janela de silêncio (quietHours inteiro, ou null para desligar) e o que sai durante ela (quietPass, o conjunto inteiro)',
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
            quietHours: {
              type: 'object',
              nullable: true,
              required: ['start', 'end'],
              properties: {
                start: { type: 'integer', minimum: 0, maximum: 23 },
                end: { type: 'integer', minimum: 0, maximum: 23 },
              },
            },
            quietPass: {
              type: 'array',
              uniqueItems: true,
              items: { type: 'string', enum: ['deadline'] },
            },
          }),
        },
      ),
    },
    '/admin/finance': {
      get: op(
        'Admin',
        'Relatório financeiro por período (receita do ledger, depósitos, saques, reembolsos, GMV), por dia, semana (segunda a domingo) ou mês de Brasília; ?from, ?to (AAAA-MM-DD, até 400 dias) e ?granularity=day|week|month (padrão month). 400 invalid_range, range_too_long',
        { auth: true },
      ),
    },
    '/admin/finance/export.csv': {
      get: op('Admin', 'Ledger de R$ do período em CSV', { auth: true }),
    },
    '/admin/usage': {
      get: {
        ...op(
          'Admin',
          'Uso por período (RF-081): cadastros, contratações criadas, concluídas e canceladas e usuários ativos, com todos os baldes do período. Balde inteiro e fechado vem do snapshot gravado pelo job report-snapshots (source=snapshot); o resto é calculado agora (source=live). 400 invalid_range, range_too_long',
          { auth: true, responses: jsonResponse('200', 'AdminUsageReport') },
        ),
        parameters: [
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
          {
            name: 'granularity',
            in: 'query',
            schema: { type: 'string', enum: ['day', 'week', 'month'], default: 'month' },
            description:
              'Sem from/to: últimos 30 dias (day), 12 semanas contando a atual (week) ou 6 meses contando o atual (month), até hoje em Brasília.',
          },
        ],
      },
    },
    '/contracts/{id}/extension': {
      post: op(
        'Contratações',
        'Freelancer pede extensão de prazo (RN-028, ADR 57): até 2 pedidos, 1 aceito, só enquanto há trabalho nunca entregue; o cliente responde até extension.respondBy. 409 extension_limit, extension_used, extension_pending, extension_after_delivery, grace_over; 400 invalid_deadline, extension_too_close',
        { auth: true },
      ),
    },
    '/contracts/{id}/extension/{decision}': {
      post: op(
        'Contratações',
        'Cliente aceita (accept) ou recusa (decline) o pedido que viu. 409 extension_changed, extension_expired, extension_stale, no_pending_extension',
        { auth: true, body: { $ref: '#/components/schemas/ExtensionDecision' } },
      ),
    },
    '/contracts/{id}/milestones/{milestoneId}/deliver': {
      post: {
        ...op(
          'Contratações',
          'Marco: freelancer entrega (RN-069), com arquivos em multipart (RF-035) como a entrega única',
          {
            auth: true,
            responses: {
              ...jsonResponse('200', 'ContractWithHistory'),
              '409': errorResponse('invalid_transition: o marco não está aguardando entrega'),
              '413': errorResponse('file_too_large: um arquivo; files_too_large: a soma'),
              '422': errorResponse(
                'validation_error (files: o marco não guarda links), empty_file, unsupported_file_type, too_many_files, invalid_upload',
              ),
            },
          },
        ),
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: ref('DeliverMilestone') },
            'multipart/form-data': { schema: ref('DeliverMilestoneForm') },
          },
        },
      },
    },
    '/contracts/{id}/milestones/{milestoneId}/approve': {
      post: op('Contratações', 'Marco: cliente aprova e libera só aquele valor; o último conclui', {
        auth: true,
      }),
    },
    '/contracts/{id}/milestones/{milestoneId}/request-revision': {
      post: op('Contratações', 'Marco: cliente pede revisão sem custo (RN-023)', {
        auth: true,
        responses: {
          ...jsonResponse('200', 'ContractWithHistory'),
          '409': {
            description:
              'revision_limit: revisões incluídas usadas; revision_counter_limit: teto técnico do contador',
          },
        },
      }),
    },
    '/contracts/{id}/request-revision': {
      post: op('Contratações', 'Entrega única: cliente pede revisão sem custo (RN-023)', {
        auth: true,
        responses: {
          ...jsonResponse('200', 'Contract'),
          '409': {
            description:
              'revision_limit: revisões incluídas usadas; revision_counter_limit: teto técnico do contador',
          },
        },
      }),
    },
    '/contracts/{id}/revisions/grant': {
      post: op('Contratações', 'Freelancer libera mais uma revisão sem custo na entrega única', {
        auth: true,
        body: ref('RevisionGrant'),
        bodyRequired: false,
        responses: {
          ...jsonResponse('200', 'Contract'),
          '409': {
            description:
              'revision_unlimited, revision_grant_not_needed, revision_grant_limit ou invalid_transition. A hora da aprovação automática não muda.',
          },
        },
      }),
    },
    '/contracts/{id}/milestones/{milestoneId}/revisions/grant': {
      post: op(
        'Contratações',
        'Freelancer libera mais uma revisão sem custo neste marco entregue',
        {
          auth: true,
          body: ref('RevisionGrant'),
          bodyRequired: false,
          responses: {
            ...jsonResponse('200', 'ContractWithHistory'),
            '409': {
              description:
                'revision_unlimited, revision_grant_not_needed, revision_grant_limit ou invalid_transition. A hora da aprovação automática do marco não muda.',
            },
          },
        },
      ),
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
    '/auth/change-password': {
      post: op(
        'Auth',
        'Troca a senha com login (RF-017): revoga todas as sessões anteriores, devolve o par novo desta sessão e avisa por e-mail. Aceita conta suspensa; o login é conferido antes do limite de tentativas',
        {
          auth: true,
          body: ref('ChangePassword'),
          responses: {
            ...jsonResponse('200', 'RefreshResponse'),
            '400': errorResponse(
              'wrong_password (senha atual incorreta, ou conta sem senha gravada) ou same_password (a nova é igual à atual)',
            ),
            '401': errorResponse('missing_token ou invalid_token'),
            '403': errorResponse('account_blocked (conta banida) ou account_deleted'),
            '404': errorResponse('user_not_found'),
            '422': errorResponse(
              'validation_error: details.currentPassword ("Informe a senha atual") ou details.newPassword ("A senha deve ter ao menos 8 caracteres")',
            ),
            '429': errorResponse('too_many_requests (o mesmo limite do login)'),
          },
        },
      ),
    },
    '/auth/mfa': {
      get: op(
        'Auth',
        'Situação da verificação em duas etapas da própria conta (RF-090): ativa, desde quando, códigos de recuperação restantes, se o servidor consegue ativar e se o painel a exige. Aceita conta suspensa',
        {
          auth: true,
          responses: {
            ...jsonResponse('200', 'MfaStatus'),
            '401': errorResponse('missing_token ou invalid_token'),
          },
        },
      ),
    },
    '/auth/mfa/setup': {
      post: op(
        'Auth',
        'Começa a ativação da 2FA com a senha atual: segredo novo (cifrado no banco, RNF-042) e o otpauth para o QR. Troca o pendente anterior. Aceita conta suspensa',
        {
          auth: true,
          body: ref('MfaPassword'),
          responses: {
            ...jsonResponse('200', 'MfaSetup'),
            '400': errorResponse('wrong_password'),
            '401': errorResponse('missing_token ou invalid_token'),
            '409': errorResponse('mfa_already_enabled'),
            '422': errorResponse('validation_error: details.password'),
            '429': errorResponse('mfa_locked ou too_many_requests'),
            '503': errorResponse('mfa_unavailable: o servidor não tem a FIELD_ENCRYPTION_KEY'),
          },
        },
      ),
    },
    '/auth/mfa/enable': {
      post: op(
        'Auth',
        'Ativa a 2FA com o primeiro código do app: devolve os 10 códigos de recuperação (uma vez) e o par novo desta sessão; todas as outras sessões caem e o titular é avisado por e-mail',
        {
          auth: true,
          body: ref('MfaCode'),
          responses: {
            ...jsonResponse('200', 'MfaEnabledResponse'),
            '400': errorResponse('invalid_mfa_code ou mfa_not_started (sem POST /auth/mfa/setup)'),
            '401': errorResponse('missing_token ou invalid_token'),
            '409': errorResponse('mfa_already_enabled'),
            '422': errorResponse('validation_error: details.code'),
            '429': errorResponse('mfa_locked ou too_many_requests'),
            '500': errorResponse('mfa_unreadable'),
          },
        },
      ),
    },
    '/auth/mfa/disable': {
      post: op(
        'Auth',
        'Desativa a 2FA com a senha e um código (do app ou de recuperação); o titular é avisado por e-mail',
        {
          auth: true,
          body: ref('MfaConfirm'),
          responses: {
            ...res204,
            '400': errorResponse('wrong_password ou invalid_mfa_code'),
            '401': errorResponse('missing_token ou invalid_token'),
            '409': errorResponse('mfa_not_enabled'),
            '422': errorResponse('validation_error: details.password ou details.code'),
            '429': errorResponse('mfa_locked ou too_many_requests'),
          },
        },
      ),
    },
    '/auth/mfa/recovery-codes': {
      post: op(
        'Auth',
        'Gera 10 códigos de recuperação novos (senha + código); os anteriores deixam de valer',
        {
          auth: true,
          body: ref('MfaConfirm'),
          responses: {
            ...jsonResponse('200', 'MfaRecoveryCodesResponse'),
            '400': errorResponse('wrong_password ou invalid_mfa_code'),
            '401': errorResponse('missing_token ou invalid_token'),
            '409': errorResponse('mfa_not_enabled'),
            '422': errorResponse('validation_error: details.password ou details.code'),
            '429': errorResponse('mfa_locked ou too_many_requests'),
          },
        },
      ),
    },
    '/auth/contact': {
      get: op(
        'Auth',
        'Contato da conta (RF-017): e-mail, troca pendente e telefone; só o titular',
        {
          auth: true,
          responses: {
            ...jsonResponse('200', 'AccountContact'),
            '401': errorResponse('missing_token ou invalid_token'),
          },
        },
      ),
    },
    '/auth/phone': {
      put: op(
        'Auth',
        'Grava ou apaga o telefone da conta (RF-017), guardado em E.164; não aparece no perfil público. Bloqueado na suspensão',
        {
          auth: true,
          body: ref('UpdatePhone'),
          responses: {
            ...jsonResponse('200', 'AccountContact'),
            '401': errorResponse('missing_token ou invalid_token'),
            '403': errorResponse('account_suspended, account_blocked ou account_deleted'),
            '422': errorResponse(
              'validation_error: details.phone (número que não é do Brasil, sem DDD válido ou com dígitos a mais ou a menos)',
            ),
          },
        },
      ),
    },
    '/auth/change-email': {
      post: op(
        'Auth',
        'Pede a troca de e-mail (RF-017) com a senha atual. O link vai ao endereço novo e o atual recebe o aviso. A resposta é a mesma se o endereço já for de outra conta ou reservado à administração (o link não sai). Substitui o pedido anterior; bloqueado na suspensão',
        {
          auth: true,
          body: ref('ChangeEmail'),
          responses: {
            '202': {
              description: 'Pedido registrado; falta confirmar pelo link',
              content: { 'application/json': { schema: ref('PendingEmailChange') } },
            },
            '400': errorResponse('wrong_password ou same_email'),
            '401': errorResponse('missing_token ou invalid_token'),
            '403': errorResponse(
              'admin_email_locked (conta de administração), account_suspended, account_blocked ou account_deleted',
            ),
            '404': errorResponse('user_not_found'),
            '422': errorResponse('validation_error: details.currentPassword ou details.newEmail'),
            '429': errorResponse(
              'too_many_requests (o limite do login, por IP) ou too_many_email_changes (5 pedidos por conta em 24 horas)',
            ),
          },
        },
      ),
      delete: op(
        'Auth',
        'Desiste da troca de e-mail pendente (o link deixa de valer). Aceita conta suspensa',
        {
          auth: true,
          responses: { ...res204, '401': errorResponse('missing_token ou invalid_token') },
        },
      ),
    },
    '/auth/confirm-email-change': {
      post: op(
        'Auth',
        'Confirma a troca de e-mail pelo token do link (uso único, com validade). O e-mail novo entra confirmado, todas as sessões caem e o endereço antigo é avisado. Pública; com o Bearer da mesma conta, devolve a sessão nova desta aba',
        {
          body: ref('ConfirmEmailChange'),
          responses: {
            ...jsonResponse('200', 'ConfirmEmailChangeResponse'),
            '400': errorResponse('invalid_token (link inválido, vencido, já usado ou cancelado)'),
            '403': errorResponse(
              'admin_email_locked, account_suspended, account_banned ou account_deleted',
            ),
            '409': errorResponse(
              'email_unavailable (o endereço passou a ser de outra conta ou é reservado à administração)',
            ),
            '422': errorResponse('validation_error: details.token'),
            '429': errorResponse('too_many_requests (o mesmo limite do login)'),
          },
        },
      ),
    },
    '/admin/emails': {
      get: op('Admin', 'Caixa de saída de e-mails (limit, userId)', { auth: true }),
    },

    '/wallet': {
      get: op('Carteira', 'Saldo R$ + créditos Escambo (disponível e em escrow)', { auth: true }),
    },
    '/wallet/transactions': {
      get: {
        ...op(
          'Carteira',
          'Extrato de R$ (depósitos, reservas, escrow, reembolsos, saques), do mais novo ao mais antigo. from/to (RF-047) filtram por dia no fuso da conta, os dois inclusivos; sem eles, o extrato inteiro',
          {
            auth: true,
            responses: {
              ...jsonResponse('200', 'WalletTransactionsPage'),
              '400': errorResponse(
                'invalid_range: "Período inválido: a data inicial precisa ser até a final" (from depois de to)',
              ),
              '401': errorResponse('missing_token ou invalid_token'),
              '403': errorResponse('account_blocked'),
              '422': errorResponse(
                'validation_error: details.from ou details.to = ["Informe um dia válido no formato AAAA-MM-DD"]; page/limit fora da faixa',
              ),
            },
          },
        ),
        parameters: [...pageParameters, ...ledgerPeriodParameters],
      },
    },
    '/wallet/earnings': {
      get: {
        ...op(
          'Carteira',
          'Ganhos por período (RF-082), lidos do ledger de R$: só escrow liberado ao freelancer (escrow_release) e torna recebida (barter_in), por dia, semana (segunda a domingo) ou mês no fuso da conta, com total, contratações pagas e ticket médio; créditos à parte. Sem from/to: últimos 30 dias, 12 semanas ou 12 meses até hoje',
          {
            auth: true,
            responses: {
              ...jsonResponse('200', 'WalletEarnings'),
              '400': errorResponse(
                'invalid_range: "Período inválido: a data inicial precisa ser até a final"; range_too_long: mais de 400 dias, semanas ou meses no agrupamento',
              ),
              '401': errorResponse('missing_token ou invalid_token'),
              '403': errorResponse('account_blocked'),
              '422': errorResponse(
                'validation_error: details.from ou details.to = ["Informe um dia válido no formato AAAA-MM-DD"]; granularity fora de day, week ou month',
              ),
            },
          },
        ),
        parameters: [
          ...ledgerPeriodParameters,
          {
            name: 'granularity',
            in: 'query',
            schema: { type: 'string', enum: ['day', 'week', 'month'], default: 'month' },
          },
        ],
      },
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
      post: op(
        'Carteira',
        'Webhook do gateway (header x-webhook-secret). Liquida uma vez (idempotente), mas todo corpo recebido com o segredo certo fica no histórico da cobrança (RF-050), sem dados pessoais: aplicado, repetido, de cobrança desconhecida ou fora do formato',
        {
          body: { $ref: '#/components/schemas/PaymentWebhook' },
        },
      ),
    },
    '/credits/transactions': {
      get: {
        ...op(
          'Carteira',
          'Extrato de créditos Escambo (time-bank), do mais novo ao mais antigo. from/to (RF-047) filtram por dia no fuso da conta, os dois inclusivos, como no extrato de R$; sem eles, o extrato inteiro',
          {
            auth: true,
            responses: {
              ...jsonResponse('200', 'CreditTransactionsPage'),
              '400': errorResponse(
                'invalid_range: "Período inválido: a data inicial precisa ser até a final" (from depois de to)',
              ),
              '401': errorResponse('missing_token ou invalid_token'),
              '403': errorResponse('account_blocked'),
              '422': errorResponse(
                'validation_error: details.from ou details.to = ["Informe um dia válido no formato AAAA-MM-DD"]; page/limit fora da faixa',
              ),
            },
          },
        ),
        parameters: [...pageParameters, ...ledgerPeriodParameters],
      },
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
      get: {
        ...op('Saques', 'Meus saques, do mais novo ao mais antigo, cada um com o prazo (dueAt)', {
          auth: true,
          responses: jsonResponse('200', 'WithdrawalsPage'),
        }),
        parameters: pageParameters,
      },
      post: op(
        'Saques',
        'Solicita saque (mín. min_withdrawal_amount, padrão R$20) por Pix ou conta bancária. A resposta traz o prazo de pagamento (dueAt, RN-035): withdrawal_pix_business_days (padrão 1) ou withdrawal_bank_business_days (padrão 2) dias úteis, gravado no saque',
        {
          auth: true,
          body: { $ref: '#/components/schemas/CreateWithdrawal' },
          responses: {
            ...jsonResponse('201', 'Withdrawal'),
            '400': errorResponse('insufficient_balance'),
            '403': errorResponse(
              'email_not_verified; cpf_required (RF-020: quem entrega trabalho saca com o CPF validado no Perfil); ou conta bloqueada',
            ),
            '422': errorResponse('below_minimum ou validation_error'),
            '503': errorResponse(
              'cpf_unavailable (quem entrega trabalho, num servidor sem FIELD_ENCRYPTION_KEY)',
            ),
          },
        },
      ),
    },
    '/withdrawals/{id}/cancel': {
      post: op('Saques', 'Cancela saque ainda não processado (valor volta)', {
        auth: true,
        responses: {
          ...jsonResponse('200', 'Withdrawal'),
          '403': errorResponse('forbidden (saque de outra pessoa)'),
          '404': errorResponse('withdrawal_not_found'),
          '409': errorResponse('invalid_transition (já em processamento ou encerrado)'),
        },
      }),
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
    '/gamification/me/missions': {
      get: op(
        'Gamificação',
        'Missões do período vigente com o progresso (RF-066, RN-054): o dia e a semana (segunda a domingo 23:59:59) são os do fuso da conta; virou, o progresso recomeça. O progresso é recontado na fonte (contratações concluídas, ofertas do cliente respondidas a tempo, trocas concluídas) e a meta credita o xp_reward do catálogo uma vez só, com aviso mission_completed. Abrir conta como o acesso do dia (daily_login). Conta sem perfil de freelancer, suspensa ou banida recebe a lista vazia.',
        {
          auth: true,
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': { schema: { type: 'array', items: ref('Mission') } },
              },
            },
          },
        },
      ),
    },
    '/gamification/leaderboard': {
      get: {
        ...op(
          'Gamificação',
          'Ranking (RF-067). Sem filtro: geral por XP. Com categoryId e/ou lat+lng: top 10 da RN-056, por nota média, depois contratações concluídas, depois XP; a categoria inclui as subcategorias, e o local usa o raio ranking_radius_km da plataforma. Sem contas excluídas, suspensas ou banidas.',
          {
            auth: true,
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: { type: 'array', maxItems: 10, items: ref('LeaderboardEntry') },
                  },
                },
              },
              '422': errorResponse(
                'validation_error (lat sem lng, fora da faixa ou categoria inválida)',
              ),
            },
          },
        ),
        parameters: [
          {
            name: 'categoryId',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1 },
            description: 'Quem tem serviço ativo na categoria ou numa subcategoria dela.',
          },
          {
            name: 'lat',
            in: 'query',
            required: false,
            schema: { type: 'number', minimum: -90, maximum: 90 },
            description: 'Ponto do "perto de mim", junto com lng.',
          },
          {
            name: 'lng',
            in: 'query',
            required: false,
            schema: { type: 'number', minimum: -180, maximum: 180 },
          },
        ],
      },
    },

    '/barters': {
      get: op('Troca (Escambo)', 'Minhas trocas', { auth: true }),
      post: op(
        'Troca (Escambo)',
        'Propõe troca (torna + taxa). O sistema estima cada lado pelo preço fechado do catálogo (RF-084); o valor informado só vale para serviço a combinar, por hora ou descrito',
        {
          auth: true,
          body: { $ref: '#/components/schemas/CreateBarter' },
          responses: {
            ...res201,
            '402': errorResponse('insufficient_balance: sem saldo para reservar a torna'),
            '422': errorResponse(
              'validation_error, estimate_mismatch (valor diferente do catálogo), estimate_required (lado sem preço fechado sem valor), invalid_offered_service, invalid_requested_service',
            ),
          },
        },
      ),
    },
    '/barters/{id}': { get: op('Troca (Escambo)', 'Detalhe da troca', { auth: true }) },
    '/barters/{id}/accept': {
      post: op(
        'Troca (Escambo)',
        'Aceita a troca (gera 2 contratos recíprocos; reserva a torna se o receptor paga — 402 sem saldo)',
        { auth: true },
      ),
    },
    '/barters/{id}/reject': {
      post: {
        ...op(
          'Troca (Escambo)',
          'Recusa a troca proposta (só quem recebeu); a torna reservada volta ao pagador',
          {
            auth: true,
            responses: {
              ...res204,
              '403': errorResponse('forbidden: só quem recebeu a proposta pode recusar'),
              '404': errorResponse('barter_not_found'),
              '409': errorResponse('invalid_status: a troca não está mais proposta'),
            },
          },
        ),
        parameters: offerPathParameters,
      },
    },
    '/barters/{id}/cancel': {
      post: {
        ...op('Troca (Escambo)', 'Cancela a troca ainda proposta (qualquer das partes)', {
          auth: true,
          responses: {
            ...res204,
            '403': errorResponse('forbidden: você não participa desta troca'),
            '404': errorResponse('barter_not_found'),
            '409': errorResponse('invalid_status: só é possível cancelar uma troca ainda proposta'),
          },
        }),
        parameters: offerPathParameters,
      },
    },

    '/notifications': {
      get: op('Notificações', 'Minhas notificações + não lidas', { auth: true }),
    },
    '/notifications/read-all': {
      post: op('Notificações', 'Marca todas como lidas', { auth: true }),
    },
    '/notifications/{id}/read': {
      post: {
        ...op('Notificações', 'Marca uma notificação como lida (só as próprias)', {
          auth: true,
          responses: {
            ...res204,
            '404': errorResponse('notification_not_found (não existe ou é de outra pessoa)'),
          },
        }),
        parameters: offerPathParameters,
      },
    },

    '/messaging/contracts/{id}': {
      get: op(
        'Chat',
        'Histórico do chat do contrato (partes). Cada mensagem traz readAt: quando o destinatário leu (RF-059), null enquanto não lida',
        { auth: true },
      ),
      post: op(
        'Chat',
        'Envia mensagem (persiste + broadcast Socket.IO). Texto com sinal de negociação por fora (chave Pix, CPF, telefone, e-mail, WhatsApp, "por fora") sai com signals para as duas partes e entra sozinho na fila de denúncias, sem ser barrado (ADR 45)',
        { auth: true, responses: res201 },
      ),
    },
    '/messaging/contracts/{id}/read': {
      post: op(
        'Chat',
        'Marca como lidas as mensagens recebidas até upTo (RF-059); as próprias nunca mudam. Idempotente; quando algo muda, emite message:read (ChatReadEvent) nas salas do par. Permitido à conta suspensa: registra a leitura, sem conteúdo novo',
        {
          auth: true,
          body: ref('MarkChatRead'),
          bodyRequired: false,
          responses: {
            ...jsonResponse('200', 'ChatReadReceipt'),
            '403': errorResponse('forbidden (não participa da contratação) ou conta bloqueada'),
            '404': errorResponse('contract_not_found'),
            '422': errorResponse('validation_error: id ou upTo inválido'),
          },
        },
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
      get: op(
        'Chat',
        'Baixa o anexo de uma mensagem, inclusive os arquivos das entregas (RF-035): só as partes do contrato',
        { auth: true },
      ),
    },

    '/favorites': {
      get: op('Trust & Safety', 'Meus favoritos', { auth: true }),
      post: op('Trust & Safety', 'Favoritar serviço/freelancer', { auth: true, responses: res201 }),
    },
    '/favorites/{targetType}/{targetId}': {
      delete: {
        ...op('Trust & Safety', 'Remove dos favoritos (sem erro se já não estava)', {
          auth: true,
          responses: {
            ...res204,
            '422': errorResponse('validation_error: targetType ou targetId inválido'),
          },
        }),
        parameters: [
          idPathParameter('targetType', { type: 'string', enum: ['service', 'freelancer'] }),
          idPathParameter('targetId', { type: 'integer', minimum: 1 }),
        ],
      },
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
      get: op('Trust & Safety', 'Minhas denúncias e a situação de cada uma', { auth: true }),
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
    '/admin/dropouts': {
      get: {
        ...op(
          'Admin',
          'Contestações de desistência aguardando decisão, das mais antigas; acesso exclusivo de admin',
          {
            auth: true,
            responses: jsonResponse('200', 'AdminDropouts'),
          },
        ),
        parameters: [
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string', enum: ['appealed'], default: 'appealed' },
          },
        ],
      },
    },
    '/admin/users/{ulid}/dropouts': {
      get: {
        ...op('Admin', 'Desistências da conta com confirmação, contestação e decisão privadas', {
          auth: true,
          responses: jsonResponse('200', 'AdminDropouts'),
        }),
        parameters: [
          {
            name: 'ulid',
            in: 'path',
            required: true,
            schema: { type: 'string', minLength: 26, maxLength: 26 },
          },
        ],
      },
    },
    '/admin/dropouts/{id}/{decision}': {
      post: {
        ...op(
          'Admin',
          'excuse deixa de contar; uphold mantém uma desistência contestada. Nota privada só para freelancer; ação auditada na transação (409 dropout_decided_already; 422 dropout_appeal_required)',
          {
            auth: true,
            body: ref('DropoutDecisionRequest'),
            responses: {
              ...jsonResponse('200', 'MyDropout'),
              '409': { description: 'dropout_decided_already' },
              '422': { description: 'dropout_appeal_required ou corpo inválido' },
            },
          },
        ),
        parameters: [
          ...offerPathParameters,
          {
            name: 'decision',
            in: 'path',
            required: true,
            schema: { type: 'string', enum: ['excuse', 'uphold'] },
          },
        ],
      },
    },

    '/disputes': {
      get: op('Disputas', 'Minhas disputas', { auth: true }),
      post: op('Disputas', 'Abre disputa manual quando a janela da RN-062 já abriu', {
        auth: true,
        responses: {
          ...res201,
          '409': {
            description:
              'dispute_too_early devolve opensAt em ISO UTC e a hora no fuso de quem pede; not_disputable quando o estado não admite disputa. A automática da RN-029 mantém sua própria guarda.',
            content: {
              'application/json': {
                schema: { anyOf: [ref('DisputeTooEarlyError'), ref('Error')] },
              },
            },
          },
        },
      }),
    },
    '/disputes/{id}': { get: op('Disputas', 'Detalhe da disputa', { auth: true }) },

    '/media': {
      post: op(
        'Perfis',
        'Envia imagem para avatar ou portfólio (multipart file + purpose avatar|portfolio, padrão portfolio; JPG, PNG, GIF ou WebP até 5 MB e 50 MP). A API reencoda em WebP orientado e sem metadados: avatar quadrado de até 512 px, portfólio de até 1600 px. Devolve URL, largura e altura. 422 image_blocked para imagem removida pela moderação e 403 uploads_restricted durante o bloqueio por reincidência',
        { auth: true, responses: res201 },
      ),
    },
    '/media/{year}/{month}/{file}': {
      get: op(
        'Perfis',
        'Imagem pública de perfil ou portfólio (cache imutável de um ano); ?w=128, ?w=480 ou ?w=960 devolve a miniatura em WebP, gerada na primeira leitura',
      ),
    },
    '/admin/metrics': {
      get: op(
        'Admin',
        'Métricas da plataforma, com os saques pendentes e quantos deles já passaram do prazo (overdueWithdrawals, RN-035) e os chamados de suporte em aberto, aguardando a equipe e com SLA vencido (RF-076). O painel consulta de novo a cada 30 s com a aba visível',
        { auth: true, responses: jsonResponse('200', 'AdminMetrics') },
      ),
    },
    '/admin/moderation/health': {
      get: op(
        'Admin',
        'Saúde da moderação (ADR 47): fila e contestações esperando agora (com quantas denúncias já passaram da meta, ADR 55) e, no período (?days=1..365, padrão 30), decisões com mediana e p90 do tempo até decidir, sinalizações automáticas por resultado e por sinal com o acerto, contestações mantidas e revertidas e remoções por tipo, mais a série por dia (Brasília), a meta de tempo (moderation_sla_hours, ADR 50) e o estado do relatório diário por e-mail',
        { auth: true },
      ),
    },
    '/admin/moderation/health/export.csv': {
      get: op(
        'Admin',
        'Série por dia da saúde da moderação em CSV (ADR 55): os últimos ?days=1..365 dias inteiros de Brasília mais hoje — denúncias recebidas, sinalizações automáticas, decididas com ação e dispensadas, mediana de horas, meta e se passou dela; ponto e vírgula, vírgula decimal, BOM',
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
        'Parâmetros públicos: comissão, aprovação tácita, validade da proposta, horas para responder a contraproposta e extensão, mínimos, prazo do saque em dias úteis por forma de recebimento (withdrawalBusinessDays: { pix, bank }, RN-035), trocas, manutenção com a hora prevista da volta (maintenanceReturnAt, RNF-010; nula sem previsão) e regras fixas das contratações (somente leitura)',
      ),
    },
    '/client-errors': {
      post: op(
        'Plataforma',
        'O app relata um erro do navegador (RNF-040): { kind: render | error | rejection, message, stack?, componentStack?, path }. Vira log em warn, a métrica escambo_client_errors_total e, com SENTRY_DSN, um evento marcado como do web. Sem login; até 30 por IP a cada 15 min; responde 204',
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
    '/admin/users/{ulid}/suspend': {
      post: {
        ...op(
          'Admin',
          'Suspende usuário (RN-007): mantém login e consulta; ações de negócio respondem 403 account_suspended',
          {
            auth: true,
            responses: {
              ...res204,
              '404': errorResponse('user_not_found'),
              '409': errorResponse('cannot_moderate_admin: administradores não são suspensos'),
            },
          },
        ),
        parameters: [idPathParameter('ulid', { type: 'string' })],
      },
    },
    '/admin/users/lookup': {
      get: {
        ...op(
          'Admin',
          'Atendimento (ADR 66): a conta pelo e-mail exato, com papel, situação e se a verificação em duas etapas está ativa',
          {
            auth: true,
            responses: {
              ...jsonResponse('200', 'AdminAccountLookup'),
              '403': errorResponse('admin_only ou mfa_required (ADMIN_MFA_REQUIRED)'),
              '404': errorResponse('user_not_found'),
              '422': errorResponse('validation_error: details.email'),
            },
          },
        ),
        parameters: [
          {
            name: 'email',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'email' },
          },
        ],
      },
    },
    '/admin/users/{ulid}/mfa/reset': {
      post: {
        ...op(
          'Admin',
          'Atendimento (ADR 66): desativa a verificação em duas etapas de quem perdeu o acesso, com o motivo; as sessões da conta caem, a ação fica em admin_actions e o titular é avisado por e-mail',
          {
            auth: true,
            body: ref('ResetMfa'),
            responses: {
              ...res204,
              '400': errorResponse('cannot_reset_self (a própria 2FA se desativa no perfil)'),
              '403': errorResponse('admin_only ou mfa_required (ADMIN_MFA_REQUIRED)'),
              '404': errorResponse('user_not_found'),
              '409': errorResponse('mfa_not_enabled'),
              '422': errorResponse('validation_error: details.reason (10 a 500 caracteres)'),
            },
          },
        ),
        parameters: [idPathParameter('ulid', { type: 'string' })],
      },
    },
    '/admin/users/{ulid}/cpf/reset': {
      post: {
        ...op(
          'Admin',
          'Atendimento (RF-020): apaga o CPF validado para o titular informar de novo, com o motivo; a ação fica em admin_actions (sem o CPF) e o titular é avisado por e-mail. Até ele informar, o saque de quem entrega trabalho fica travado',
          {
            auth: true,
            body: ref('ResetMfa'),
            responses: {
              ...res204,
              '403': errorResponse('admin_only ou mfa_required (ADMIN_MFA_REQUIRED)'),
              '404': errorResponse('user_not_found'),
              '409': errorResponse('cpf_not_set'),
              '422': errorResponse('validation_error: details.reason (10 a 500 caracteres)'),
            },
          },
        ),
        parameters: [idPathParameter('ulid', { type: 'string' })],
      },
    },
    '/admin/users/{ulid}/ban': {
      post: op('Admin', 'Bane usuário', { auth: true, responses: res204 }),
    },
    '/admin/users/{ulid}/reactivate': {
      post: {
        ...op('Admin', 'Reativa usuário suspenso ou banido (volta a active)', {
          auth: true,
          responses: { ...res204, '404': errorResponse('user_not_found') },
        }),
        parameters: [idPathParameter('ulid', { type: 'string' })],
      },
    },
    '/admin/withdrawals': {
      get: {
        ...op(
          'Admin',
          'Fila de saques (status=open|all|…, até 200), pelo prazo (dueAt, RN-035): o que vence antes vem primeiro, e overdue marca o que ainda não foi pago e passou do prazo',
          {
            auth: true,
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: { type: 'array', items: ref('AdminWithdrawal') },
                  },
                },
              },
            },
          },
        ),
        parameters: [
          {
            name: 'status',
            in: 'query',
            schema: {
              type: 'string',
              enum: ['open', 'all', ...withdrawalStatuses],
              default: 'open',
            },
          },
        ],
      },
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
      get: op('LGPD', 'Meus pedidos de exclusão de conta e a situação de cada um', { auth: true }),
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

/**
 * Arquivos do pacote swagger-ui-dist que a página usa. A API serve os dois em /api/docs/ (e não
 * por CDN): o CSP do helmet só aceita script da própria origem.
 */
export const SWAGGER_UI_FILES = ['swagger-ui.css', 'swagger-ui-bundle.js'] as const;

/**
 * Pasta do swagger-ui-dist instalado, ou null sem o pacote: aí a página avisa que o Swagger UI
 * não está disponível, e o documento continua em /api/openapi.json.
 */
export function swaggerUiDistDir(resolve: (id: string) => string = require.resolve): string | null {
  try {
    return dirname(resolve('swagger-ui-dist'));
  } catch {
    return null;
  }
}

/**
 * Inicialização do Swagger UI, servida como arquivo em /api/docs/swagger-init.js: script inline
 * é barrado pelo CSP (script-src 'self'). Sem validador externo (o selo viria de outro domínio).
 */
export const swaggerInitJs = `var root = document.getElementById('swagger-ui');
if (typeof window.SwaggerUIBundle === 'function') {
  window.ui = window.SwaggerUIBundle({ url: '/api/openapi.json', dom_id: '#swagger-ui', validatorUrl: null });
} else {
  root.textContent = 'Swagger UI indisponível neste servidor. O documento OpenAPI está em /api/openapi.json.';
}
`;

/** Página do Swagger UI: tudo servido pela própria API, sem script inline (CSP do helmet). */
export const swaggerHtml = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Escambo API — Docs</title>
    <link rel="stylesheet" href="/api/docs/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="/api/docs/swagger-ui-bundle.js"></script>
    <script src="/api/docs/swagger-init.js"></script>
  </body>
</html>`;
