import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
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
import { router } from '../routes';
import {
  openapiDocument,
  SWAGGER_UI_FILES,
  swaggerHtml,
  swaggerInitJs,
  swaggerUiDistDir,
} from './openapi';

// O router da API carrega os módulos inteiros: sem banco, como nos outros testes de unidade.
vi.mock('./db', async () => (await import('../test-support/fake-db')).dbModule);

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
            'RN-020: active_contract_exists se há contratação direta aberta no mesmo par cliente→freelancer, independentemente do serviço ou pagamento. Trocas são independentes. Também pode ocorrer service_inactive e, com pacote (RF-086), package_changed: o preço do pacote mudou.',
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
        '422': {
          description:
            'validation_error; com pacotes (RF-086): package_required, package_not_found, deadline_before_package, milestone_after_deadline',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
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
    expect(operation('/auth/register', 'post').responses['201']).toEqual({
      description: 'Criado',
    });
    expect(operation('/services/{id}', 'delete').responses).toEqual({
      '204': { description: 'Sem conteúdo' },
    });
  });

  it('documentos (RF-018, RF-020): cadastro de empresa, perfil da empresa, CPF e o atendimento', () => {
    const { schemas } = openapiDocument.components;
    expect(schemas.Register.properties.company.$ref).toBe('#/components/schemas/RegisterCompany');
    expect(schemas.RegisterCompany.required).toEqual(['legalName', 'tradeName', 'cnpj']);
    expect(operation('/auth/register', 'post').responses['409']?.description).toContain(
      'cnpj_taken',
    );
    expect(schemas.Contract.properties.clientCompany.oneOf[0].$ref).toBe(
      '#/components/schemas/CompanyRef',
    );
    expect(schemas.AdminAccountLookup.required).toEqual(expect.arrayContaining(['cpf', 'company']));
    expect(operation('/profiles/company', 'put').security).toEqual([{ bearerAuth: [] }]);
    expect(operation('/profiles/company/{ulid}', 'get').security).toBeUndefined();
    const verify = operation('/profiles/me/cpf', 'put');
    expect(verify.requestBody?.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/VerifyCpf',
    );
    expect(Object.keys(verify.responses)).toEqual(['200', '409', '422', '429', '503']);
    expect(verify.summary).toContain('não é consulta à Receita');
    expect(operation('/admin/users/{ulid}/cpf/reset', 'post').responses['409']?.description).toBe(
      'cpf_not_set',
    );
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

interface RouterLayer {
  regexp: RegExp & { fast_slash?: boolean };
  keys: Array<{ name: string | number }>;
  route?: { path: unknown; methods: Record<string, boolean> };
  handle: { stack?: RouterLayer[] };
}

/** Prefixo em que o Express 4 montou um sub-router: ele guarda só a expressão regular do caminho. */
function mountPath(layer: RouterLayer): string {
  if (layer.regexp.fast_slash) return '';
  let key = 0;
  const path = layer.regexp.source
    .replace(/^\^/, '')
    .replace('\\/?(?=\\/|$)', '')
    .replaceAll('(?:\\/([^/]+?))', () => `/:${String(layer.keys[key++]?.name)}`)
    .replace(/\\\//g, '/');
  if (!/^(\/[\w:-]+)+$/.test(path)) throw new Error(`Montagem que o teste não lê: ${layer.regexp}`);
  return path;
}

/** `:id` do Express vira `{id}` do OpenAPI (sem a restrição entre parênteses nem o `?`). */
const asOpenApi = (path: string): string => path.replace(/:(\w+)(\([^)]*\))?\??/g, '{$1}');

/** Toda rota declarada no router da API, como "MÉTODO /caminho/{param}" (relativo a /api). */
function declaredRoutes(stack: RouterLayer[], prefix = ''): string[] {
  const out: string[] = [];
  for (const layer of stack) {
    if (layer.route) {
      const { path, methods } = layer.route;
      if (typeof path !== 'string') throw new Error(`Rota sem caminho em texto: ${String(path)}`);
      const full = asOpenApi(`${prefix}${path === '/' ? '' : path}` || '/');
      for (const method of Object.keys(methods)) out.push(`${method.toUpperCase()} ${full}`);
    } else if (layer.handle.stack) {
      out.push(...declaredRoutes(layer.handle.stack, prefix + mountPath(layer)));
    }
  }
  return out;
}

/** O nome do parâmetro pode mudar entre a rota e o documento (`:ulid` e `{id}`): compara a forma. */
const shape = (id: string): string => id.replace(/\{\w+\}/g, '{}');

/** RNF-031: o documento acompanha a API. Rota nova sem documentação quebra o teste. */
describe('documento OpenAPI e as rotas da API', () => {
  const routes = declaredRoutes((router as unknown as { stack: RouterLayer[] }).stack);

  it('lê o router de verdade: prefixos, parâmetros e métodos', () => {
    expect(routes.length).toBeGreaterThan(150);
    expect(routes).toContain('GET /health/live');
    expect(routes).toContain('POST /contracts/{id}/accept');
    expect(routes).toContain('GET /support/tickets/{id}');
    expect(routes).toContain('PATCH /admin/support/tickets/{id}');
    expect(routes.every((id) => /^(GET|POST|PUT|PATCH|DELETE) \//.test(id))).toBe(true);
  });

  it('toda rota da API está no documento, com o mesmo método', () => {
    const documented = new Set(operations().map(({ id }) => shape(id)));
    const missing = [...new Set(routes)].filter((id) => !documented.has(shape(id)));
    expect(missing).toEqual([]);
  });

  it('a versão do documento é a do app (package.json), e não um número parado no tempo', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(openapiDocument.info.version).toBe(pkg.version);
  });
});

/** Rotas novas ou mudadas na rodada de lacunas de 19/10 e as 6 operações que o documento não tinha. */
describe('documento OpenAPI: lacunas de 19/10', () => {
  const { schemas } = openapiDocument.components;
  const json = (path: string, method: (typeof METHODS)[number], status: string) =>
    operation(path, method).responses[status]?.content?.['application/json'].schema;
  interface Parameter {
    name: string;
    in: string;
    schema: { type?: string; format?: string; items?: { enum?: string[] } };
  }
  const parameters = (path: string, method: (typeof METHODS)[number]) =>
    (openapiDocument.paths[path][method] as { parameters: Parameter[] }).parameters;

  it('as 6 operações que faltavam: protegidas, 204 e os erros de cada uma', () => {
    for (const [path, errors] of [
      ['/barters/{id}/reject', ['403', '404', '409']],
      ['/barters/{id}/cancel', ['403', '404', '409']],
      ['/notifications/{id}/read', ['404']],
      ['/admin/users/{ulid}/suspend', ['404', '409']],
      ['/admin/users/{ulid}/reactivate', ['404']],
    ] as const) {
      const op = operation(path, 'post');
      expect(op.security, path).toEqual([{ bearerAuth: [] }]);
      expect(Object.keys(op.responses).sort(), path).toEqual(['204', ...errors]);
    }
    const unfavorite = operation('/favorites/{targetType}/{targetId}', 'delete');
    expect(unfavorite.security).toEqual([{ bearerAuth: [] }]);
    expect(unfavorite.responses['204']?.description).toBe('Sem conteúdo');
    expect(parameters('/favorites/{targetType}/{targetId}', 'delete')).toEqual([
      {
        name: 'targetType',
        in: 'path',
        required: true,
        schema: { type: 'string', enum: ['service', 'freelancer'] },
      },
      { name: 'targetId', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
    ]);
    expect(
      operation('/admin/users/{ulid}/suspend', 'post').responses['409']?.description,
    ).toContain('cannot_moderate_admin');
    expect(operation('/reports', 'get').security).toEqual([{ bearerAuth: [] }]);
    expect(operation('/lgpd/deletion-requests', 'get').security).toEqual([{ bearerAuth: [] }]);
  });

  it('GET /services/mine: lista de Service do dono, pausados inclusive, com login', () => {
    const op = operation('/services/mine', 'get');
    expect(op.tags).toEqual(['Serviços']);
    expect(op.summary).toContain('Meus serviços (pausados inclusive)');
    expect(op.security).toEqual([{ bearerAuth: [] }]);
    expect(json('/services/mine', 'get', '200')).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/Service' },
    });
    expect(schemas.Service.properties.isActive).toEqual({ type: 'boolean' });
    expect(schemas.Service.properties.boosted.type).toBe('boolean');
    expect(schemas.Service.properties).not.toHaveProperty('ownerName');
    expect(
      operation('/services/{id}', 'patch').requestBody?.content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/UpdateService' });
    expect(schemas.UpdateService.properties.isActive.type).toBe('boolean');
    expect(schemas.UpdateService).not.toHaveProperty('required');
  });

  it('POST /auth/change-password: corpo, o par novo de tokens e os erros', () => {
    const op = operation('/auth/change-password', 'post');
    expect(op.tags).toEqual(['Auth']);
    expect(op.security).toEqual([{ bearerAuth: [] }]);
    expect(op.requestBody?.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/ChangePassword',
    });
    expect(schemas.ChangePassword).toEqual({
      type: 'object',
      required: ['currentPassword', 'newPassword'],
      properties: {
        currentPassword: { type: 'string', minLength: 1 },
        newPassword: { type: 'string', minLength: 8 },
      },
    });
    expect(json('/auth/change-password', 'post', '200')).toEqual({
      $ref: '#/components/schemas/RefreshResponse',
    });
    expect(schemas.RefreshResponse.required).toEqual(['accessToken', 'refreshToken']);
    expect(Object.keys(op.responses)).toEqual(['200', '400', '401', '403', '404', '422', '429']);
    expect(op.responses['400']?.description).toContain('wrong_password');
    expect(op.responses['400']?.description).toContain('same_password');
  });

  it('contato da conta (RF-017): troca de e-mail confirmada pelo link e telefone', () => {
    for (const [path, method] of [
      ['/auth/contact', 'get'],
      ['/auth/phone', 'put'],
      ['/auth/change-email', 'post'],
      ['/auth/change-email', 'delete'],
    ] as const) {
      expect(operation(path, method).security, `${method} ${path}`).toEqual([{ bearerAuth: [] }]);
    }
    // A confirmação é pública: o link pode abrir em outro aparelho.
    const confirm = operation('/auth/confirm-email-change', 'post');
    expect(confirm.security).toBeUndefined();
    expect(json('/auth/confirm-email-change', 'post', '200')).toEqual({
      $ref: '#/components/schemas/ConfirmEmailChangeResponse',
    });
    expect(Object.keys(confirm.responses)).toEqual(['200', '400', '403', '409', '422', '429']);

    const request = operation('/auth/change-email', 'post');
    expect(request.requestBody?.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/ChangeEmail',
    });
    expect(request.responses['202']?.content?.['application/json'].schema).toEqual({
      $ref: '#/components/schemas/PendingEmailChange',
    });
    expect(request.responses['403']?.description).toContain('admin_email_locked');
    expect(request.responses['429']?.description).toContain('too_many_email_changes');
    expect(operation('/auth/change-email', 'delete').responses['204']).toBeDefined();
    expect(json('/auth/contact', 'get', '200')).toEqual({
      $ref: '#/components/schemas/AccountContact',
    });
    expect(json('/auth/phone', 'put', '200')).toEqual({
      $ref: '#/components/schemas/AccountContact',
    });
    expect(schemas.AccountContact.required).toEqual([
      'email',
      'emailVerified',
      'phone',
      'pendingEmail',
    ]);
    expect(schemas.AccountContact.properties.phone.pattern).toBe('^\\+55\\d{10,11}$');
    expect(schemas.UpdatePhone.properties.phone.nullable).toBe(true);
    expect(schemas.ChangeEmail.required).toEqual(['currentPassword', 'newEmail']);
    // O perfil público não ganhou contato nenhum.
    expect(JSON.stringify(schemas.PublicFreelancerProfile ?? {})).not.toMatch(/phone|email/i);
  });

  it('GET /contracts: filtro de status, paginação e o total', () => {
    const [page, limit, status] = parameters('/contracts', 'get');
    expect(page).toMatchObject({ name: 'page', in: 'query', schema: { maximum: 10_000 } });
    expect(limit).toMatchObject({ name: 'limit', in: 'query', schema: { maximum: 100 } });
    expect(status).toMatchObject({ name: 'status', in: 'query', style: 'form', explode: true });
    expect(status?.schema.items?.enum).toEqual(schemas.Contract.properties.status.enum);
    expect(schemas.ContractsPage.required).toEqual(['items', 'page', 'limit', 'total']);
    expect(operation('/contracts', 'get').responses['422']?.description).toContain(
      'Status de contratação desconhecido',
    );
  });

  it('GET /contracts/{id}: as entregas únicas; a entrega cita o trecho no aviso', () => {
    expect(schemas.ContractWithHistory.allOf[1].properties.deliveries.items).toEqual({
      $ref: '#/components/schemas/ContractDelivery',
    });
    expect(schemas.ContractDelivery.required).toEqual(['id', 'message', 'files', 'deliveredAt']);
    expect(schemas.ContractDelivery.properties.files).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
    expect(operation('/contracts/{id}/deliver', 'post').summary).toContain('120 caracteres');
  });

  it('GET /wallet/transactions: período em dias, página com hasMore e os erros novos', () => {
    const params = parameters('/wallet/transactions', 'get');
    expect(params.map((p) => p.name)).toEqual(['page', 'limit', 'from', 'to']);
    expect(params[2]?.schema).toEqual({ type: 'string', format: 'date' });
    expect(json('/wallet/transactions', 'get', '200')).toEqual({
      $ref: '#/components/schemas/WalletTransactionsPage',
    });
    expect(schemas.WalletTransactionsPage.required).toEqual(['items', 'page', 'limit', 'hasMore']);
    expect(schemas.WalletTransactionsPage.properties.items.items).toEqual({
      $ref: '#/components/schemas/WalletTransaction',
    });
    const op = operation('/wallet/transactions', 'get');
    expect(op.responses['400']?.description).toContain('invalid_range');
    expect(op.responses['422']?.description).toContain(
      'Informe um dia válido no formato AAAA-MM-DD',
    );
    expect(Object.keys(schemas.CreateWithdrawal.properties)).toEqual(
      expect.arrayContaining(['bankName', 'bankAgency', 'bankAccount']),
    );
  });

  it('perfil público: XP, badges e até 3 em destaque', () => {
    const profile = schemas.PublicFreelancerProfile.properties;
    expect(profile.totalXp).toMatchObject({ type: 'integer', minimum: 0 });
    expect(profile.badges.items).toEqual({ $ref: '#/components/schemas/Badge' });
    expect(profile.featuredBadges).toMatchObject({ type: 'array', maxItems: 3 });
    expect(schemas.Badge.required).toEqual(['slug', 'name', 'awardedAt']);
  });

  it('perfil público: localização a ~1 km para quem não é o dono (privacidade)', () => {
    const profile = schemas.PublicFreelancerProfile.properties;
    for (const field of ['latitude', 'longitude']) {
      expect(profile[field]).toMatchObject({ type: 'number', nullable: true });
      expect(profile[field].description).toMatch(/2 casas.*~1 km.*dono/);
    }
  });
});

/** Leitura no chat (RF-059): a rota, o recibo e o evento Socket.IO message:read. */
describe('documento OpenAPI: leitura no chat', () => {
  const { schemas } = openapiDocument.components;

  it('POST /messaging/contracts/{id}/read: protegido, corpo opcional e o recibo na resposta', () => {
    const read = operation('/messaging/contracts/{id}/read', 'post');
    expect(read.tags).toEqual(['Chat']);
    expect(read.security).toEqual([{ bearerAuth: [] }]);
    expect(read.requestBody).toEqual({
      required: false,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/MarkChatRead' } } },
    });
    expect(read.responses['200']?.content?.['application/json'].schema).toEqual({
      $ref: '#/components/schemas/ChatReadReceipt',
    });
    expect(Object.keys(read.responses)).toEqual(['200', '403', '404', '422']);
    expect(read.summary).toContain('message:read');
    expect(read.summary).toContain('conta suspensa');
    expect(operation('/messaging/contracts/{id}', 'get').summary).toContain('readAt');
    expect(openapiDocument.info.description).toContain('registro de leitura do chat');
  });

  it('os schemas espelham os tipos: upTo positivo, recibo com nulos e evento completo', () => {
    expect(schemas.MarkChatRead.properties.upTo).toMatchObject({ type: 'integer', minimum: 1 });
    expect(schemas.MarkChatRead).not.toHaveProperty('required');
    expect(schemas.ChatReadReceipt.required).toEqual([
      'conversationId',
      'marked',
      'upToId',
      'readAt',
    ]);
    expect(schemas.ChatReadReceipt.properties.readAt).toEqual({
      type: 'string',
      format: 'date-time',
      nullable: true,
    });
    expect(schemas.ChatReadEvent.required).toEqual([
      'contractId',
      'conversationId',
      'readerId',
      'upToId',
      'readAt',
    ]);
    expect(schemas.ChatReadEvent.description).toContain('contract:<id>');
  });
});

/** Verificação em duas etapas (RF-090, ADR 66): o login em dois passos e as rotas da conta e do admin. */
describe('documento OpenAPI: verificação em duas etapas', () => {
  const { schemas } = openapiDocument.components;

  it('o login documenta as duas respostas: a sessão ou o MfaChallenge', () => {
    expect(operation('/auth/login', 'post').responses['200']?.content).toEqual({
      'application/json': {
        schema: {
          oneOf: [
            { $ref: '#/components/schemas/AuthResponse' },
            { $ref: '#/components/schemas/MfaChallenge' },
          ],
        },
      },
    });
    expect(schemas.MfaChallenge.required).toEqual(['mfaRequired', 'mfaToken', 'expiresInSeconds']);
    expect(schemas.MfaChallenge.additionalProperties).toBe(false);
  });

  it('o segundo passo é público e lista as recusas próprias', () => {
    const op = operation('/auth/login/mfa', 'post');
    expect(op).not.toHaveProperty('security');
    expect(op.requestBody?.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/LoginMfa',
    });
    expect(op.responses['401']?.description).toContain('invalid_mfa_token');
    expect(op.responses['400']?.description).toContain('invalid_mfa_code');
    expect(op.responses['429']?.description).toContain('mfa_locked');
  });

  it('as rotas da conta pedem o Bearer e documentam a indisponibilidade sem a chave', () => {
    for (const [path, method] of [
      ['/auth/mfa', 'get'],
      ['/auth/mfa/setup', 'post'],
      ['/auth/mfa/enable', 'post'],
      ['/auth/mfa/disable', 'post'],
      ['/auth/mfa/recovery-codes', 'post'],
      ['/admin/users/lookup', 'get'],
      ['/admin/users/{ulid}/mfa/reset', 'post'],
    ] as const) {
      expect(operation(path, method).security, `${method} ${path}`).toEqual([{ bearerAuth: [] }]);
    }
    expect(operation('/auth/mfa/setup', 'post').responses['503']?.description).toContain(
      'mfa_unavailable',
    );
    expect(operation('/auth/mfa/disable', 'post').responses['204']).toBeDefined();
    expect(
      operation('/admin/users/{ulid}/mfa/reset', 'post').responses['400']?.description,
    ).toContain('cannot_reset_self');
    expect(schemas.MfaStatus.required).toEqual([
      'enabled',
      'confirmedAt',
      'recoveryCodesLeft',
      'available',
      'required',
    ]);
    expect(schemas.AdminAccountLookup.properties.mfaEnabled).toEqual({ type: 'boolean' });
    expect(schemas.ResetMfa.properties.reason).toEqual({
      type: 'string',
      minLength: 10,
      maxLength: 500,
    });
  });
});

/** Pacotes Básico, Padrão e Premium (RF-086, RN-068, ADR 69). */
describe('documento OpenAPI: pacotes por serviço', () => {
  const { schemas } = openapiDocument.components;
  const body = (path: string, method: (typeof METHODS)[number]) =>
    operation(path, method).requestBody?.content['application/json'].schema;

  it('o pacote tem os limites do schema da API, sem chave a mais, e a lista vai até 3', () => {
    expect(schemas.PackageTier.enum).toEqual(['basic', 'standard', 'premium']);
    expect(schemas.ServicePackage.additionalProperties).toBe(false);
    expect(schemas.ServicePackage.required).toEqual(['tier', 'name', 'price', 'deliveryDays']);
    expect(schemas.ServicePackage.properties.revisions).toMatchObject({
      minimum: 1,
      maximum: 10,
      default: 2,
    });
    expect(schemas.ServicePackage.properties.deliveryDays).toMatchObject({
      minimum: 1,
      maximum: 365,
    });
    expect(schemas.ServicePackage.properties.features.maxItems).toBe(10);
    expect(schemas.ServicePackages.maxItems).toBe(3);
    expect(schemas.ServicePackages.description).toContain('package_price_order');
  });

  it('cadastro, edição e leitura do serviço levam os pacotes; a contratação escolhe o nível e devolve a cópia', () => {
    expect(schemas.CreateService.properties.packages).toEqual({
      $ref: '#/components/schemas/ServicePackages',
    });
    expect(schemas.UpdateService.properties.packages).toEqual({
      $ref: '#/components/schemas/ServicePackages',
    });
    expect(schemas.Service.properties.packages.items).toEqual({
      $ref: '#/components/schemas/ServicePackage',
    });
    expect(schemas.CreateContract.properties.packageTier.$ref).toBe(
      '#/components/schemas/PackageTier',
    );
    expect(schemas.CreateContract.properties.packageTier.description).toContain('package_required');
    expect(schemas.Contract.properties.package.oneOf[0]).toEqual({
      $ref: '#/components/schemas/ServicePackage',
    });
    expect(body('/services', 'post')).toEqual({ $ref: '#/components/schemas/CreateService' });
  });

  it('os erros novos estão nas respostas de quem os devolve', () => {
    const described = (path: string, method: (typeof METHODS)[number], status: string) =>
      String(operation(path, method).responses[status]?.description ?? '');
    for (const code of [
      'packages_require_fixed_price',
      'price_from_packages',
      'package_price_order',
    ]) {
      expect(described('/services', 'post', '422')).toContain(code);
      expect(described('/services/{id}', 'patch', '422')).toContain(code);
    }
    for (const code of ['package_required', 'package_not_found', 'deadline_before_package'])
      expect(described('/contracts', 'post', '422')).toContain(code);
    expect(described('/contracts', 'post', '409')).toContain('package_changed');
  });
});
