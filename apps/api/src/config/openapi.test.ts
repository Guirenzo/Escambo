import { describe, expect, it } from 'vitest';
import { openapiDocument, swaggerHtml } from './openapi';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

interface Operation {
  tags: string[];
  summary: string;
  responses: Record<string, { description: string }>;
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
      summary: 'Cria proposta (taxa 15%)',
      responses: { '201': { description: 'Criado' } },
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
});

describe('página do Swagger UI', () => {
  it('é HTML em português, com o lugar do Swagger e apontando para o documento da própria API', () => {
    expect(swaggerHtml.startsWith('<!doctype html>')).toBe(true);
    expect(swaggerHtml).toContain('<html lang="pt-BR">');
    expect(swaggerHtml).toContain('<div id="swagger-ui"></div>');
    expect(swaggerHtml).toContain(
      "SwaggerUIBundle({ url: '/api/openapi.json', dom_id: '#swagger-ui' })",
    );
  });

  it('carrega o Swagger UI (folha de estilo e script) da mesma versão principal', () => {
    expect(swaggerHtml).toContain('https://unpkg.com/swagger-ui-dist@5/swagger-ui.css');
    expect(swaggerHtml).toContain('https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js');
  });
});
