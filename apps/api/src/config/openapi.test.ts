import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  Contract,
  ContractOffer,
  ContractWithHistory,
  CounterOfferRequest,
  Negotiation,
  NegotiationTurn,
  Milestone,
  OfferMilestone,
  RevisionState,
} from '@escambo/types';
import type {
  CounterOfferRequest as ReexportedCounterOfferRequest,
  NegotiationTurn as ReexportedNegotiationTurn,
  OfferMilestoneTerms,
  OfferWalletEffect,
} from '../modules/contracts/offers';
import type { WalletEffect } from '../modules/wallet/wallet.ledger';
import {
  openapiDocument,
  SWAGGER_UI_FILES,
  swaggerHtml,
  swaggerInitJs,
  swaggerUiDistDir,
} from './openapi';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

interface Operation {
  tags: string[];
  summary: string;
  responses: Record<
    string,
    {
      description: string;
      content?: { 'application/json': { schema: Record<string, unknown> } };
    }
  >;
  security?: unknown;
  requestBody?: {
    required: boolean;
    content: { 'application/json': { schema: Record<string, unknown> } };
  };
}

/** Todas as operações do documento, com o caminho e o método. */
function operations(): Array<{ id: string; op: Operation }> {
  const out: Array<{ id: string; op: Operation }> = [];
  for (const [path, item] of Object.entries(openapiDocument.paths as Record<string, unknown>)) {
    for (const method of METHODS) {
      const op = (item as Record<string, Operation | undefined>)[method];
      if (op) out.push({ id: `${method.toUpperCase()} ${path}`, op });
    }
  }
  return out;
}

/** Todo `$ref` do documento, em qualquer profundidade. */
function refs(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) refs(item, found);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') found.push(value);
      else refs(value, found);
    }
  }
  return found;
}

const operation = (path: string, method: (typeof METHODS)[number]): Operation =>
  openapiDocument.paths[path][method] as Operation;

describe('contrato público do suporte', () => {
  it('documenta todos os caminhos autenticados, mantendo notas apenas no fluxo administrativo', () => {
    for (const [path, method] of [
      ['/support/tickets', 'get'],
      ['/support/tickets', 'post'],
      ['/support/tickets/{id}', 'get'],
      ['/support/tickets/{id}/messages', 'post'],
      ['/support/tickets/{id}/close', 'post'],
      ['/admin/support/tickets', 'get'],
      ['/admin/support/tickets/{id}', 'get'],
      ['/admin/support/tickets/{id}', 'patch'],
      ['/admin/support/tickets/{id}/messages', 'post'],
    ] as const) {
      expect(operation(path, method).security, `${method} ${path}`).toEqual([{ bearerAuth: [] }]);
    }
    const schemas = openapiDocument.components.schemas;
    expect(schemas.ReplySupportTicket.additionalProperties).toBe(false);
    expect(schemas.ReplySupportTicket.properties.internal).toBeUndefined();
    expect(schemas.AdminReplySupportTicket.properties.internal.default).toBe(false);
    expect(schemas.SupportTicket.properties.ownerDeleted.type).toBe('boolean');
    expect(schemas.SupportTicketDetail.allOf[1].properties.messages.maxItems).toBe(50);
  });
  it('descreve os limites e erros sem ampliar suspensão para ações financeiras', () => {
    expect(operation('/support/tickets', 'post').responses['409']?.description).toContain(
      'ticket_limit',
    );
    expect(operation('/admin/support/tickets/{id}', 'patch').summary).toContain('72/24/8/2');
    expect(openapiDocument.info.description).toContain(
      'suporte próprio (abrir, responder e encerrar)',
    );
    expect(openapiDocument.info.description).toContain(
      'disputa financeira mantém suas próprias regras',
    );
    expect(openapiDocument.info.description).not.toContain('suporte geral ainda está pendente');
  });
});

/** Documento OpenAPI (RNF-010): o que /api/openapi.json entrega e o Swagger UI desenha. */
describe('documento OpenAPI', () => {
  it('é OpenAPI 3.0, com as rotas relativas a /api', () => {
    expect(openapiDocument.openapi).toBe('3.0.3');
    expect(openapiDocument.info.title).toBe('Escambo API');
    expect(openapiDocument.servers).toEqual([{ url: '/api', description: 'API' }]);
    // O servidor já é /api: um caminho com /api na frente viraria /api/api/... no Swagger.
    const paths = Object.keys(openapiDocument.paths);
    expect(paths.length).toBeGreaterThan(50);
    for (const path of paths) {
      expect(path.startsWith('/')).toBe(true);
      expect(path.startsWith('/api')).toBe(false);
    }
  });

  it('declara a autenticação Bearer JWT que as rotas protegidas citam', () => {
    expect(openapiDocument.components.securitySchemes).toEqual({
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    });
  });

  it('toda operação tem uma tag, um resumo e pelo menos uma resposta descrita', () => {
    const all = operations();
    expect(all.length).toBeGreaterThan(100);
    for (const { id, op } of all) {
      expect(op.tags, id).toHaveLength(1);
      expect(op.tags[0], id).toMatch(/\S/);
      expect(op.summary, id).toMatch(/\S/);
      const responses = Object.entries(op.responses);
      expect(responses.length, id).toBeGreaterThan(0);
      for (const [status, response] of responses) {
        expect(status, id).toMatch(/^[1-5]\d\d$/);
        expect(response.description, id).toMatch(/\S/);
      }
    }
  });

  it('cada operação sai com a tag e o resumo no lugar certo, e só com as chaves que tem', () => {
    // Pública e sem corpo: nada de security nem requestBody.
    expect(operation('/health', 'get')).toEqual({
      tags: ['Health'],
      summary: 'Readiness — status da API + ping no banco',
      responses: { '200': { description: 'OK' } },
    });
    // Protegida, com corpo e resposta própria.
    expect(operation('/contracts', 'post')).toEqual({
      tags: ['Contratações'],
      summary: 'Cria proposta e reserva o valor',
      responses: {
        '201': {
          description: 'Criado',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/Contract' } },
          },
        },
        '409': {
          description:
            'RN-020: active_contract_exists se há contratação direta aberta no mesmo par cliente→freelancer, independentemente do serviço ou pagamento. Trocas são independentes. Também pode ocorrer service_inactive.',
          content: {
            'application/json': {
              schema: {
                anyOf: [
                  { $ref: '#/components/schemas/ActiveContractError' },
                  { $ref: '#/components/schemas/Error' },
                ],
              },
            },
          },
        },
      },
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/CreateContract' } },
        },
      },
    });
  });

  it('as tags declaradas não se repetem, e toda tag declarada é usada por alguma operação', () => {
    const declared = (openapiDocument.tags as Array<{ name: string }>).map((t) => t.name);
    expect(declared.length).toBeGreaterThan(10);
    expect(new Set(declared).size).toBe(declared.length);

    const used = new Set(operations().map(({ op }) => op.tags[0]));
    expect(declared.filter((name) => !used.has(name))).toEqual([]);
  });

  it('toda tag usada por uma operação está declarada (senão o Swagger a mostra sem ordem nem grupo)', () => {
    const declared = new Set((openapiDocument.tags as Array<{ name: string }>).map((t) => t.name));
    const undeclared = operations()
      .flatMap(({ op }) => op.tags)
      .filter((tag) => !declared.has(tag));
    expect([...new Set(undeclared)]).toEqual([]);
    // As imagens de perfil e portfólio ficam no grupo dos perfis, e não num "Perfil" à parte.
    expect(operation('/media', 'post').tags).toEqual(['Perfis']);
    expect(operation('/media/{year}/{month}/{file}', 'get').tags).toEqual(['Perfis']);
    expect(operation('/settings/public', 'get').tags).toEqual(['Plataforma']);
  });

  it('rota protegida pede o Bearer; rota pública não leva a marca', () => {
    expect(operation('/auth/me', 'get').security).toEqual([{ bearerAuth: [] }]);
    expect(operation('/contracts', 'post').security).toEqual([{ bearerAuth: [] }]);
    expect(operation('/admin/metrics', 'get').security).toEqual([{ bearerAuth: [] }]);

    for (const [path, method] of [
      ['/health', 'get'],
      ['/health/live', 'get'],
      ['/auth/login', 'post'],
      ['/auth/register', 'post'],
      ['/categories', 'get'],
      ['/services', 'get'],
      ['/reviews', 'get'],
      ['/settings/public', 'get'],
      ['/payments/webhook', 'post'],
    ] as const) {
      expect(operation(path, method), `${method} ${path}`).not.toHaveProperty('security');
    }
    // Toda marca de segurança usada é a que está declarada: outro nome não abriria o cadeado.
    for (const { id, op } of operations()) {
      if (op.security !== undefined) expect(op.security, id).toEqual([{ bearerAuth: [] }]);
    }
  });

  it('sem resposta declarada, a operação responde 200; quem cria responde 201 e quem apaga, 204', () => {
    expect(operation('/health', 'get').responses).toEqual({ '200': { description: 'OK' } });
    expect(operation('/auth/register', 'post').responses).toEqual({
      '201': { description: 'Criado' },
    });
    expect(operation('/services/{id}', 'delete').responses).toEqual({
      '204': { description: 'Sem conteúdo' },
    });
  });

  it('operação com corpo o declara obrigatório, em JSON, com o schema; sem corpo, não há requestBody', () => {
    expect(operation('/auth/register', 'post').requestBody).toEqual({
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Register' } } },
    });
    expect(operation('/moderation/removals/{id}/appeal', 'post').requestBody).toEqual({
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['text'],
            properties: { text: { type: 'string', minLength: 20, maxLength: 1000 } },
          },
        },
      },
    });
    expect(operation('/auth/me', 'get')).not.toHaveProperty('requestBody');
  });

  it('todo $ref aponta para um schema que existe', () => {
    const schemas = Object.keys(openapiDocument.components.schemas);
    const all = refs(openapiDocument);
    expect(all.length).toBeGreaterThan(5);
    for (const ref of all) {
      expect(ref).toMatch(/^#\/components\/schemas\/\w+$/);
      expect(schemas, ref).toContain(ref.replace('#/components/schemas/', ''));
    }
  });

  it('os schemas espelham as regras de entrada: campos obrigatórios e mínimos', () => {
    const { schemas } = openapiDocument.components;
    expect(schemas.Register.type).toBe('object');
    expect(schemas.Register.required).toEqual(['email', 'password']);
    expect(schemas.Register.properties.password).toEqual({ type: 'string', minLength: 8 });
    expect(schemas.Register.properties.role.enum).toEqual(['client', 'freelancer', 'company']);
    // Schema sem campo obrigatório não leva a chave (um `required: undefined` invalida o documento).
    expect(schemas.Error).toEqual({
      type: 'object',
      properties: { error: { type: 'string' }, message: { type: 'string' } },
    });
    expect(schemas.CreateContract.required).toEqual([
      'freelancerId',
      'title',
      'description',
      'price',
    ]);
    expect(schemas.CreateContract.properties.price).toEqual({ type: 'number', minimum: 10 });
    expect(schemas.CreateWithdrawal.properties.amount).toEqual({ type: 'number', minimum: 20 });
    expect(schemas.ResolveDispute.properties.resolution.enum).toEqual([
      'refund_client',
      'release_freelancer',
      'partial_split',
    ]);
  });

  it('todo parâmetro de caminho é escrito como {nome}, e nunca no formato do Express (:nome)', () => {
    for (const path of Object.keys(openapiDocument.paths)) {
      expect(path).not.toMatch(/:/);
      for (const segment of path.split('/').filter((s) => s.includes('{') || s.includes('}'))) {
        expect(segment, path).toMatch(/^\{\w+\}$/);
      }
    }
  });

  it('liga desistências ativas às rotas e projeções públicas ou privadas da RN-026', () => {
    const { schemas } = openapiDocument.components;
    const names = [
      'ContractDropout',
      'DropoutSummary',
      'DropoutPreview',
      'DropoutDecision',
      'DropoutStatus',
      'MyDropout',
      'MyDropouts',
      'AdminDropout',
    ];
    for (const name of names) {
      expect(schemas[name], name).toHaveProperty('x-implementation-status', 'active');
    }
    const newRoute = /\/dropouts?(?:\/|$)/;
    expect(Object.keys(openapiDocument.paths).filter((path) => newRoute.test(path))).toEqual([
      '/profiles/me/dropouts',
      '/profiles/me/dropouts/{id}/appeal',
      '/contracts/{id}/dropout/agreed',
      '/admin/dropouts',
      '/admin/users/{ulid}/dropouts',
      '/admin/dropouts/{id}/{decision}',
    ]);
    const connected = refs(openapiDocument.paths);
    expect(connected).toContain('#/components/schemas/MyDropouts');
    expect(connected).toContain('#/components/schemas/ContractDropout');
    expect(connected).toContain('#/components/schemas/MyDropout');
    expect(schemas.PublicFreelancerProfile.properties.dropouts).toEqual({
      $ref: '#/components/schemas/DropoutSummary',
    });
    expect(schemas.CancelTerms.properties.dropout.oneOf).toContainEqual({
      $ref: '#/components/schemas/DropoutPreview',
    });
    expect(schemas.CancelContract.additionalProperties).toBe(false);
    expect(schemas.CancelContract.properties.expectedDropoutCount).toMatchObject({
      type: 'integer',
      minimum: 1,
    });
    expect(schemas.DropoutDecisionRequest.properties.note).toEqual({
      type: 'string',
      minLength: 10,
      maxLength: 500,
    });
    expect(schemas.DropoutAppeal.properties.text).toEqual({
      type: 'string',
      minLength: 20,
      maxLength: 1000,
    });
  });

  it('liga a negociação ativa às rotas canônicas, decisões com seq e payloads reais', () => {
    const { schemas } = openapiDocument.components;
    for (const name of [
      'NegotiationTurn',
      'OfferOutcome',
      'OfferMilestone',
      'ContractOffer',
      'Negotiation',
      'CounterOfferMilestone',
      'CounterOfferRequest',
    ]) {
      expect(schemas[name], name).toHaveProperty('x-implementation-status', 'active');
      expect(schemas[name].description ?? '', name).not.toContain('ainda não exposto');
    }
    const counter = operation('/contracts/{id}/offers', 'post');
    expect(counter.security).toEqual([{ bearerAuth: [] }]);
    expect(counter.requestBody).toEqual({
      required: true,
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/CounterOfferRequest' } },
      },
    });
    expect(counter.responses['201']?.content).toEqual({
      'application/json': { schema: { $ref: '#/components/schemas/ContractWithHistory' } },
    });
    expect(Object.keys(counter.responses)).toEqual(
      expect.arrayContaining(['400', '402', '403', '409', '422']),
    );
    expect(operation('/contracts/{id}/offers/{seq}/accept', 'post')).not.toHaveProperty(
      'requestBody',
    );
    const acceptPath = openapiDocument.paths['/contracts/{id}/offers/{seq}/accept'].post;
    expect(acceptPath.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
      {
        name: 'seq',
        in: 'path',
        required: true,
        schema: { type: 'integer', minimum: 1, maximum: 5 },
      },
    ]);
    for (const action of ['accept', 'reject']) {
      expect(operation(`/contracts/{id}/${action}`, 'post').requestBody).toEqual({
        required: false,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/OfferDecision' } } },
      });
    }
    expect(schemas.OfferDecision.properties.seq).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 5,
    });
    expect(schemas.CancelContract.properties.seq).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 5,
    });
    expect(schemas.CounterOfferRequest.additionalProperties).toBe(false);
    expect(schemas.CounterOfferMilestone.additionalProperties).toBe(false);
    expect(schemas.CounterOfferRequest.properties.message).toEqual({
      type: 'string',
      minLength: 5,
      maxLength: 500,
    });
    expect(schemas.CounterOfferRequest.required).toEqual(['seq', 'price', 'deadlineAt', 'message']);
    expect(schemas.Contract.properties.negotiation.oneOf).toContainEqual({
      $ref: '#/components/schemas/Negotiation',
    });
    expect(schemas.ContractWithHistory.allOf[1].properties.offers.items).toEqual({
      $ref: '#/components/schemas/ContractOffer',
    });
    expect(schemas.ContractsPage.properties.items).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/Contract' },
    });
    expect(schemas.Contract.properties).not.toHaveProperty('dropout');
    expect(schemas.ContractWithHistory.allOf[1].properties.dropout.oneOf).toContainEqual({
      $ref: '#/components/schemas/ContractDropout',
    });
    expect(schemas.Negotiation.properties.feePercentage).toEqual({
      type: 'number',
      minimum: 0,
      maximum: 50,
      multipleOf: 0.01,
    });
    expect(schemas.Negotiation.required).not.toContain('feePercentage');
    expect(schemas.Negotiation.properties.deadlineZone).toMatchObject({
      type: 'string',
      enum: [
        'America/Noronha',
        'America/Sao_Paulo',
        'America/Cuiaba',
        'America/Manaus',
        'America/Rio_Branco',
      ],
    });
    expect(schemas.Negotiation.required).not.toContain('deadlineZone');
    expectTypeOf<Negotiation['deadlineZone']>().toEqualTypeOf<
      Contract['deadlineZone'] | undefined
    >();
    expect(openapiDocument.paths).not.toHaveProperty('/contracts/{id}/counter-offer');
    expect(openapiDocument.paths).not.toHaveProperty('/contracts/{id}/decline');
    expectTypeOf<Pick<Contract, 'negotiation'>>().toEqualTypeOf<{
      negotiation?: Negotiation | null;
    }>();
    expectTypeOf<Pick<ContractWithHistory, 'offers'>>().toEqualTypeOf<{
      offers?: ContractOffer[];
    }>();
  });

  it('expõe revisões por unidade e a abertura manual, preservando payloads anteriores', () => {
    const { schemas } = openapiDocument.components;
    expect(schemas.RevisionState).toMatchObject({
      'x-implementation-status': 'active',
      required: ['used', 'limit'],
      properties: {
        used: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 0, nullable: true },
      },
    });
    expect(schemas.Contract.properties.revisions.oneOf).toContainEqual({
      $ref: '#/components/schemas/RevisionState',
    });
    expect(schemas.Contract.properties.revisions.oneOf).toContainEqual({
      type: 'object',
      nullable: true,
      enum: [null],
    });
    expect(schemas.Milestone.properties.revisions.$ref).toBe('#/components/schemas/RevisionState');
    expect(schemas.ContractWithHistory.allOf[1].properties.milestones.items).toEqual({
      $ref: '#/components/schemas/Milestone',
    });
    expect(schemas.Contract.properties.disputeOpensAt).toMatchObject({
      type: 'string',
      format: 'date-time',
      nullable: true,
    });
    expectTypeOf<Contract['revisions']>().toEqualTypeOf<RevisionState | null | undefined>();
    expectTypeOf<Milestone['revisions']>().toEqualTypeOf<RevisionState | undefined>();
    expectTypeOf<Contract['disputeOpensAt']>().toEqualTypeOf<string | null | undefined>();
    expect(schemas.Contract.required ?? []).not.toContain('revisions');
    expect(schemas.Milestone.required ?? []).not.toContain('revisions');
  });

  it('documenta as duas liberações sem corpo financeiro e o erro público da janela', () => {
    for (const [path, response] of [
      ['/contracts/{id}/revisions/grant', 'Contract'],
      ['/contracts/{id}/milestones/{milestoneId}/revisions/grant', 'ContractWithHistory'],
    ]) {
      const grant = operation(path!, 'post');
      expect(grant.security).toEqual([{ bearerAuth: [] }]);
      expect(grant.requestBody?.required).toBe(false);
      expect(grant.requestBody?.content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/RevisionGrant',
      });
      expect(grant.responses['200']?.content?.['application/json'].schema).toEqual({
        $ref: `#/components/schemas/${response}`,
      });
      expect(grant.responses['409']?.description).toContain('revision_grant_not_needed');
      expect(grant.responses['409']?.description).toContain('aprovação automática');
    }
    expect(openapiDocument.components.schemas.RevisionGrant.additionalProperties).toBe(false);
    expect(openapiDocument.components.schemas.RevisionGrant.properties).toEqual({});
    const manual = operation('/disputes', 'post').responses['409'];
    expect(manual?.description).toContain('dispute_too_early');
    expect(manual?.content?.['application/json'].schema).toEqual({
      anyOf: [
        { $ref: '#/components/schemas/DisputeTooEarlyError' },
        { $ref: '#/components/schemas/Error' },
      ],
    });
    expect(openapiDocument.components.schemas.DisputeTooEarlyError).toMatchObject({
      required: ['error', 'message', 'opensAt'],
      properties: { error: { enum: ['dispute_too_early'] }, opensAt: { nullable: true } },
    });
  });

  it('exige título no marco público, preserva ids na contraproposta e permite o cálculo interno sem título', () => {
    const { schemas } = openapiDocument.components;
    expect(schemas.OfferMilestone.required).toContain('title');
    expect(schemas.OfferMilestone.properties.title).toEqual({ type: 'string' });
    expect(schemas.CounterOfferMilestone.required).toEqual(['id', 'amount', 'dueAt']);
    expect(schemas.CounterOfferMilestone.properties).not.toHaveProperty('title');
    expect(schemas.CounterOfferRequest.required).not.toContain('milestones');
    expect(schemas.CounterOfferRequest.properties.milestones).toMatchObject({
      minItems: 2,
      maxItems: 10,
    });
    expectTypeOf<Pick<OfferMilestone, 'title'>>().toEqualTypeOf<{ title: string }>();
    expectTypeOf<Pick<OfferMilestoneTerms, 'title'>>().toEqualTypeOf<{ title?: string }>();
    expectTypeOf<ReexportedCounterOfferRequest>().toEqualTypeOf<CounterOfferRequest>();
    expectTypeOf<ReexportedNegotiationTurn>().toEqualTypeOf<NegotiationTurn>();
    expectTypeOf<OfferWalletEffect>().toExtend<WalletEffect>();
  });

  it('conserva null para o legado ilimitado e para ofertas sem prazo ou sem marcos', () => {
    const { schemas } = openapiDocument.components;
    expect(schemas.RevisionState.required).toEqual(['used', 'limit']);
    expect(schemas.RevisionState.properties.limit).toMatchObject({
      type: 'integer',
      minimum: 0,
      nullable: true,
    });
    expect(schemas.ContractOffer.properties.deadlineAt).toMatchObject({
      format: 'date-time',
      nullable: true,
    });
    expect(schemas.ContractOffer.properties.milestones).toMatchObject({
      type: 'array',
      nullable: true,
    });
    expect(schemas.Negotiation.properties.current.oneOf).toEqual([
      { $ref: '#/components/schemas/ContractOffer' },
      { type: 'object', nullable: true, enum: [null] },
    ]);
  });

  it('o resumo público de desistências não expõe fatos privados ou datas, e a prévia é informativa', () => {
    const { schemas } = openapiDocument.components;
    expect(Object.keys(schemas.DropoutSummary.properties).sort()).toEqual([
      'alert',
      'count',
      'windowDays',
    ]);
    expect(schemas.DropoutSummary.properties.windowDays.enum).toEqual([60]);
    expect(schemas.DropoutPreview.properties.alertAt.enum).toEqual([3]);
    expect(schemas.DropoutPreview.description).toContain('contagem pode mudar');
    expect(schemas.ContractDropout.properties).not.toHaveProperty('appealText');
    expect(schemas.ContractDropout.properties).not.toHaveProperty('decisionNote');
    expect(schemas.MyDropout.required).toEqual(
      expect.arrayContaining(['appealText', 'decisionNote', 'countsUntil']),
    );
    expect(schemas.MyDropouts.properties).toHaveProperty('acceptedInWindow');
    expect(schemas.AdminDropout.allOf[0]).toEqual({ $ref: '#/components/schemas/MyDropout' });
  });
});

describe('página do Swagger UI', () => {
  it('é HTML em português, com o lugar do Swagger', () => {
    expect(swaggerHtml.startsWith('<!doctype html>')).toBe(true);
    expect(swaggerHtml).toContain('<html lang="pt-BR">');
    expect(swaggerHtml).toContain('<div id="swagger-ui"></div>');
  });

  it('carrega tudo da própria API e não tem script inline: o CSP (script-src self) deixa rodar', () => {
    expect(swaggerHtml).toContain('<link rel="stylesheet" href="/api/docs/swagger-ui.css" />');
    // Toda tag <script> é de arquivo da própria API, e vazia por dentro.
    expect(swaggerHtml.match(/<script[^>]*>[\s\S]*?<\/script>/g)).toEqual([
      '<script src="/api/docs/swagger-ui-bundle.js"></script>',
      '<script src="/api/docs/swagger-init.js"></script>',
    ]);
    expect(swaggerHtml).not.toMatch(/https?:\/\//);
    expect(swaggerHtml).not.toMatch(/\son\w+=/); // nem manipulador inline (script-src-attr 'none')
  });

  it('os arquivos que a página pede são os que a API serve do swagger-ui-dist', () => {
    expect(SWAGGER_UI_FILES).toEqual(['swagger-ui.css', 'swagger-ui-bundle.js']);
    for (const file of SWAGGER_UI_FILES) expect(swaggerHtml).toContain(`/api/docs/${file}`);
  });

  it('a inicialização aponta para o documento da própria API, sem validador externo', () => {
    expect(swaggerInitJs).toContain(
      "window.SwaggerUIBundle({ url: '/api/openapi.json', dom_id: '#swagger-ui', validatorUrl: null })",
    );
  });

  it('sem o Swagger UI carregado (pacote ausente), a página diz onde está o documento em vez de ficar em branco', () => {
    const root = { textContent: '' };
    const win: { SwaggerUIBundle?: unknown; ui?: unknown } = {};
    new Function('window', 'document', swaggerInitJs)(win, { getElementById: () => root });

    expect(win.ui).toBeUndefined();
    expect(root.textContent).toBe(
      'Swagger UI indisponível neste servidor. O documento OpenAPI está em /api/openapi.json.',
    );

    // Com o pacote, quem desenha é o Swagger UI, com as opções da inicialização.
    const bundle = (opts: unknown) => ({ opts });
    const ok: { SwaggerUIBundle?: unknown; ui?: unknown } = { SwaggerUIBundle: bundle };
    new Function('window', 'document', swaggerInitJs)(ok, { getElementById: () => root });
    expect(ok.ui).toEqual({
      opts: { url: '/api/openapi.json', dom_id: '#swagger-ui', validatorUrl: null },
    });
  });

  it('acha a pasta do swagger-ui-dist pelo módulo principal dele; sem o pacote, null', () => {
    const found = swaggerUiDistDir((id) => {
      expect(id).toBe('swagger-ui-dist');
      return join('/repo', 'node_modules', 'swagger-ui-dist', 'index.js');
    });
    expect(found).toBe(join('/repo', 'node_modules', 'swagger-ui-dist'));

    const missing = swaggerUiDistDir(() => {
      throw Object.assign(new Error("Cannot find module 'swagger-ui-dist'"), {
        code: 'MODULE_NOT_FOUND',
      });
    });
    expect(missing).toBeNull();

    // Com o resolvedor do Node (o padrão), não lança: devolve a pasta ou null.
    const real = swaggerUiDistDir();
    expect(real === null || real.endsWith('swagger-ui-dist')).toBe(true);
  });
});
