import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app';
import { registry } from './config/metrics';
import { openapiDocument, swaggerHtml, swaggerInitJs } from './config/openapi';
import { settingsService } from './modules/settings/settings.service';
import { router } from './routes';
import { fakeDb } from './test-support/fake-db';
import { bearer } from './test-support/http';

// O app de base não pode depender do .env de quem roda: fixa o que estes testes observam antes de
// qualquer módulo ler o ambiente (o hoisted roda antes dos imports).
vi.hoisted(() => {
  process.env.CORS_ORIGINS = '*';
  process.env.TRUST_PROXY = 'loopback';
  process.env.BODY_LIMIT = '1mb';
  process.env.PAYMENT_WEBHOOK_SECRET = '';
});
vi.mock('./config/db', async () => (await import('./test-support/fake-db')).dbModule);

// Os testes que trocam o ambiente recarregam a aplicação inteira: folga para máquinas lentas (CI).
vi.setConfig({ testTimeout: 20_000 });

const app = createApp();

const NOT_FOUND = { error: 'not_found', message: 'Rota não encontrada' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Um app novo, montado com outro ambiente (o env é lido na carga dos módulos). */
async function appWith(vars: Record<string, string>): Promise<Express> {
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
  vi.resetModules();
  return (await import('./app')).createApp();
}

/** Liga o modo de manutenção: é a primeira leitura de configuração da próxima requisição. */
const maintenanceOn = (): void => fakeDb.reply([{ value: 'true' }]);

/** A linha de uma série no /metrics, ou undefined. */
async function sample(series: string): Promise<string | undefined> {
  const body = await registry.metrics();
  return body.split('\n').find((line) => line.startsWith(series));
}

interface Layer {
  name: string;
  regexp: RegExp;
  route?: { methods: Record<string, boolean> };
  handle: { stack?: Layer[] };
}

/** A pilha de rotas (interna do Express 4) responde a esse método e caminho? */
function declares(stack: Layer[], method: string, url: string): boolean {
  for (const layer of stack) {
    if (layer.route) {
      if (layer.route.methods[method] && layer.regexp.test(url)) return true;
    } else if (layer.handle.stack) {
      const mount = layer.regexp.exec(url);
      if (mount && declares(layer.handle.stack, method, url.slice(mount[0].length) || '/')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * A aplicação montada (createApp) sem banco: a ordem dos middlewares globais, o que fica fora do
 * rate limit e da manutenção, o 404 e o CORS, e onde cada módulo está pendurado em /api.
 */
describe('aplicação Express', () => {
  beforeEach(() => {
    fakeDb.reset();
    settingsService.clearCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('404 padronizado', () => {
    it('rota que não existe, dentro ou fora de /api, responde 404 em JSON', async () => {
      for (const path of ['/', '/nada', '/api', '/api/nada', '/api/health/nada']) {
        const res = await request(app).get(path).expect(404);
        expect(res.type, path).toBe('application/json');
        expect(res.body, path).toEqual(NOT_FOUND);
      }
    });

    it('método que a rota não aceita também é 404', async () => {
      const res = await request(app).post('/api/health/live').send({}).expect(404);
      expect(res.body).toEqual(NOT_FOUND);
    });
  });

  describe('documentação (RNF-010)', () => {
    it('GET /api/openapi.json entrega o documento inteiro, sem login', async () => {
      const res = await request(app).get('/api/openapi.json').expect(200);

      expect(res.type).toBe('application/json');
      expect(res.body).toEqual(JSON.parse(JSON.stringify(openapiDocument)));
      expect(res.body.openapi).toBe('3.0.3');
    });

    it('GET /api/docs entrega a página do Swagger UI como HTML, sem login', async () => {
      const res = await request(app).get('/api/docs').expect(200);

      expect(res.type).toBe('text/html');
      expect(res.text).toBe(swaggerHtml);
    });

    it('o CSP da página é o mesmo do resto da API (script só da própria origem), e a inicialização sai como arquivo JS', async () => {
      const page = await request(app).get('/api/docs').expect(200);
      const api = await request(app).get('/api/health/live').expect(200);
      const csp = page.headers['content-security-policy'];
      expect(csp).toContain("script-src 'self';");
      expect(csp).toContain("script-src-attr 'none'");
      expect(csp).toBe(api.headers['content-security-policy']);

      const init = await request(app).get('/api/docs/swagger-init.js').expect(200);
      expect(init.headers['content-type']).toBe('application/javascript; charset=utf-8');
      expect(init.text).toBe(swaggerInitJs);
    });

    it('o CSP não manda subir os pedidos para https: aberta por http fora do loopback, a página carrega os próprios scripts', async () => {
      const page = await request(app).get('/api/docs').expect(200);
      const csp = page.headers['content-security-policy'] as string;

      // Com upgrade-insecure-requests, o navegador pediria swagger-ui-bundle.js e swagger-init.js
      // por https num endereço só http, e a página ficaria em branco.
      expect(csp).not.toContain('upgrade-insecure-requests');
      // O resto do CSP padrão do helmet continua.
      expect(csp).toContain("default-src 'self';");
      expect(csp).toContain("object-src 'none';");
      expect(csp).toContain("frame-ancestors 'self';");
    });

    it('com o swagger-ui-dist instalado, a folha de estilo e o script do Swagger UI saem da pasta do pacote', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'escambo-swagger-'));
      try {
        await writeFile(join(dir, 'swagger-ui.css'), '.swagger-ui { color: #333; }');
        await writeFile(
          join(dir, 'swagger-ui-bundle.js'),
          'window.SwaggerUIBundle = function () {};',
        );
        await writeFile(join(dir, 'index.html'), '<p>petstore</p>');
        vi.doMock('./config/openapi', async (importOriginal) => ({
          ...(await importOriginal<typeof import('./config/openapi')>()),
          swaggerUiDistDir: () => dir,
        }));
        vi.resetModules();
        const docs = (await import('./app')).createApp();

        const css = await request(docs).get('/api/docs/swagger-ui.css').expect(200);
        expect(css.type).toBe('text/css');
        expect(css.text).toBe('.swagger-ui { color: #333; }');
        const js = await request(docs).get('/api/docs/swagger-ui-bundle.js').expect(200);
        expect(js.type).toBe('application/javascript');
        expect(js.text).toBe('window.SwaggerUIBundle = function () {};');
        // Só os dois arquivos que a página usa: o resto do pacote (a página de exemplo) não sai.
        await request(docs).get('/api/docs/index.html').expect(404);
      } finally {
        vi.doUnmock('./config/openapi');
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('sem o swagger-ui-dist, os arquivos do Swagger UI são 404 (a página avisa e aponta o documento)', async () => {
      vi.doMock('./config/openapi', async (importOriginal) => ({
        ...(await importOriginal<typeof import('./config/openapi')>()),
        swaggerUiDistDir: () => null,
      }));
      try {
        vi.resetModules();
        const docs = (await import('./app')).createApp();
        for (const file of ['swagger-ui.css', 'swagger-ui-bundle.js']) {
          const res = await request(docs).get(`/api/docs/${file}`).expect(404);
          expect(res.body).toEqual(NOT_FOUND);
        }
        await request(docs).get('/api/docs/swagger-init.js').expect(200);
      } finally {
        vi.doUnmock('./config/openapi');
      }
    });

    it('toda rota documentada existe na API, com o mesmo método', () => {
      const stack = (app as unknown as { _router: { stack: Layer[] } })._router.stack;
      // A checagem enxerga o que existe (e o que não existe) antes de valer para o documento.
      expect(declares(stack, 'get', '/api/health/live')).toBe(true);
      expect(declares(stack, 'post', '/api/contracts/1/accept')).toBe(true);
      expect(declares(stack, 'delete', '/api/health/live')).toBe(false);
      expect(declares(stack, 'get', '/api/rota-que-nao-existe')).toBe(false);

      const missing: string[] = [];
      for (const [path, item] of Object.entries(openapiDocument.paths as Record<string, object>)) {
        // {id} vira 1: serve para número, ULID, chave ou nome de ação.
        const url = `/api${path.replace(/\{\w+\}/g, '1')}`;
        for (const method of Object.keys(item)) {
          if (!declares(stack, method, url)) missing.push(`${method.toUpperCase()} ${path}`);
        }
      }
      expect(missing).toEqual([]);
    });
  });

  describe('id da requisição', () => {
    it('devolve em X-Request-Id o id que o cliente (ou o proxy) mandou', async () => {
      const res = await request(app).get('/api/health/live').set('X-Request-Id', 'req-abc-123');
      expect(res.headers['x-request-id']).toBe('req-abc-123');
    });

    it('sem id na chegada, gera um UUID por requisição, inclusive nas respostas de erro', async () => {
      const first = await request(app).get('/api/health/live').expect(200);
      const second = await request(app).get('/api/nada').expect(404);

      expect(first.headers['x-request-id']).toMatch(UUID);
      expect(second.headers['x-request-id']).toMatch(UUID);
      expect(second.headers['x-request-id']).not.toBe(first.headers['x-request-id']);
    });
  });

  describe('cabeçalhos e corpo', () => {
    it('não anuncia o Express e manda os cabeçalhos de segurança do helmet', async () => {
      const res = await request(app).get('/api/health/live').expect(200);

      expect(res.headers).not.toHaveProperty('x-powered-by');
      // Desligado no próprio Express, e não só escondido pelo helmet.
      expect(app.enabled('x-powered-by')).toBe(false);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    });

    it('comprime a resposta grande para quem aceita gzip', async () => {
      const res = await request(app)
        .get('/api/openapi.json')
        .set('Accept-Encoding', 'gzip')
        .expect(200);
      expect(res.headers['content-encoding']).toBe('gzip');
      // O supertest descomprime: o conteúdo continua sendo o documento.
      expect(res.body.info.title).toBe('Escambo API');
    });

    it('corpo que não é JSON válido vira 400 invalid_json', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send('{"email": ')
        .expect(400);
      expect(res.body).toEqual({
        error: 'invalid_json',
        message: 'Corpo da requisição não é um JSON válido',
      });
    });

    it('corpo acima de BODY_LIMIT é recusado com 413, antes de chegar ao módulo', async () => {
      const small = await appWith({ BODY_LIMIT: '100b' });

      const res = await request(small)
        .post('/api/auth/login')
        .send({ email: 'a@escambo.test', password: 'x'.repeat(200) })
        .expect(413);

      expect(res.body).toEqual({
        error: 'payload_too_large',
        message: 'Corpo da requisição excede o limite',
      });
    });
  });

  describe('CORS', () => {
    it("com CORS_ORIGINS '*', reflete a origem de quem chama e aceita credenciais", async () => {
      const res = await request(app)
        .get('/api/health/live')
        .set('Origin', 'https://qualquer.test')
        .expect(200);

      expect(res.headers['access-control-allow-origin']).toBe('https://qualquer.test');
      expect(res.headers['access-control-allow-credentials']).toBe('true');

      // O preflight é respondido pelo CORS, antes de qualquer rota (e do login dela).
      const preflight = await request(app)
        .options('/api/contracts')
        .set('Origin', 'https://qualquer.test')
        .set('Access-Control-Request-Method', 'POST')
        .expect(204);
      expect(preflight.headers['access-control-allow-origin']).toBe('https://qualquer.test');
      expect(preflight.headers['access-control-allow-methods']).toContain('POST');
    });

    it("o '*' vale mesmo com espaços em volta (não vira uma lista com a origem '*')", async () => {
      const open = await appWith({ CORS_ORIGINS: ' * ' });

      const res = await request(open)
        .get('/api/health/live')
        .set('Origin', 'https://qualquer.test')
        .expect(200);

      expect(res.headers['access-control-allow-origin']).toBe('https://qualquer.test');
    });

    it('com uma lista, só as origens dela passam; outra origem é 403 cors_origin', async () => {
      const strict = await appWith({
        CORS_ORIGINS: 'https://app.escambo.test , https://admin.escambo.test',
      });

      for (const origin of ['https://app.escambo.test', 'https://admin.escambo.test']) {
        const ok = await request(strict).get('/api/health/live').set('Origin', origin).expect(200);
        expect(ok.headers['access-control-allow-origin']).toBe(origin);
        expect(ok.headers['access-control-allow-credentials']).toBe('true');
      }

      const denied = await request(strict)
        .get('/api/health/live')
        .set('Origin', 'https://golpe.test')
        .expect(403);
      expect(denied.body).toEqual({
        error: 'cors_origin',
        message: 'Origem não permitida pelo CORS',
      });
      expect(denied.headers).not.toHaveProperty('access-control-allow-origin');

      // O preflight da origem recusada também não passa.
      await request(strict)
        .options('/api/contracts')
        .set('Origin', 'https://golpe.test')
        .set('Access-Control-Request-Method', 'POST')
        .expect(403);
      // Prefixo parecido não vale: a origem tem de ser exatamente uma da lista.
      await request(strict)
        .get('/api/health/live')
        .set('Origin', 'https://app.escambo.test.golpe.test')
        .expect(403);
    });

    it('com uma lista, chamada sem Origin (health check, servidor a servidor) continua passando', async () => {
      const strict = await appWith({ CORS_ORIGINS: 'https://app.escambo.test' });

      const res = await request(strict).get('/api/health/live').expect(200);

      expect(res.body.status).toBe('ok');
      expect(res.headers).not.toHaveProperty('access-control-allow-origin');
    });
  });

  describe('proxy reverso (TRUST_PROXY)', () => {
    it('o padrão confia só no loopback', () => {
      expect(app.get('trust proxy')).toBe('loopback');
    });

    it.each([
      ['true', true],
      ['false', false],
      ['2', 2],
      ['10.0.0.0/8', '10.0.0.0/8'],
    ])('TRUST_PROXY=%s vira %j no Express', async (value, expected) => {
      const proxied = await appWith({ TRUST_PROXY: value });
      expect(proxied.get('trust proxy')).toBe(expected);
    });
  });

  describe('manutenção (ADR 33)', () => {
    it('desligada, as rotas dos módulos respondem normalmente', async () => {
      await request(app).get('/api/categories').expect(200);
    });

    it('ligada, as rotas dos módulos respondem 503 com Retry-After', async () => {
      maintenanceOn();

      const res = await request(app).get('/api/categories').expect(503);

      expect(res.body.error).toBe('maintenance');
      expect(res.headers['retry-after']).toBe('120');
      await request(app).get('/api/contracts').set(bearer(7)).expect(503);
    });

    it('a documentação e as imagens públicas ficam fora da manutenção, e o health continua de pé', async () => {
      maintenanceOn();
      await request(app).get('/api/categories').expect(503);

      await request(app).get('/api/openapi.json').expect(200);
      await request(app).get('/api/docs').expect(200);
      await request(app).get('/api/health/live').expect(200);
      // A imagem não existe, mas quem responde é a rota de mídia (404 dela), e não a manutenção.
      const media = await request(app).get('/api/media/2026/10/nao-existe.webp').expect(404);
      expect(media.body.error).toBe('media_not_found');
    });
  });

  describe('rate limit geral (por IP)', () => {
    it('vale para as rotas de /api, mas não para a documentação nem para as imagens públicas', async () => {
      const limited = await appWith({
        NODE_ENV: 'production',
        RATE_LIMIT_MAX: '2',
        RATE_LIMIT_WINDOW_MS: '60000',
        SENTRY_DSN: '',
      });

      await request(limited).get('/api/health/live').expect(200);
      await request(limited).get('/api/health/live').expect(200);
      await request(limited).get('/api/health/live').expect(429);
      // Rota que não existe também gasta e esbarra no limite: ele vem antes do roteador.
      await request(limited).get('/api/nada').expect(429);

      await request(limited).get('/api/openapi.json').expect(200);
      await request(limited).get('/api/docs').expect(200);
      const media = await request(limited).get('/api/media/2026/10/nao-existe.webp').expect(404);
      expect(media.body.error).toBe('media_not_found');
    });

    it('vem antes da manutenção: o limite protege até a resposta 503', async () => {
      const limited = await appWith({
        NODE_ENV: 'production',
        RATE_LIMIT_MAX: '2',
        RATE_LIMIT_WINDOW_MS: '60000',
        SENTRY_DSN: '',
      });
      // O app novo tem o seu próprio service de configurações: é nele que a manutenção liga.
      const fresh = await import('./modules/settings/settings.service');
      vi.spyOn(fresh.settingsService, 'maintenanceMode').mockResolvedValue(true);

      await request(limited).get('/api/categories').expect(503);
      await request(limited).get('/api/categories').expect(503);
      await request(limited).get('/api/categories').expect(429);
    });
  });

  describe('métricas (ADR 59)', () => {
    it('mede cada requisição pela rota declarada, e o que não casa com rota nenhuma vira unmatched', async () => {
      await request(app).get('/api/health/live').expect(200);
      await request(app).get('/api/rota-inexistente-123').expect(404);

      const prefix = 'escambo_http_request_duration_seconds_count';
      expect(await sample(`${prefix}{method="GET",route="/api/health/live",status="200"}`)).toMatch(
        / [1-9]\d*$/,
      );
      expect(await sample(`${prefix}{method="GET",route="unmatched",status="404"}`)).toMatch(
        / [1-9]\d*$/,
      );
      // A URL crua nunca vira rótulo (um id por URL explodiria as séries).
      expect(await registry.metrics()).not.toContain('rota-inexistente-123');
    });
  });
});

/** routes.ts: cada módulo pendurado no seu prefixo de /api. */
describe('rotas dos módulos em /api', () => {
  beforeEach(() => {
    fakeDb.reset();
    settingsService.clearCache();
  });

  it('monta os 25 módulos, e nada além deles', () => {
    expect((router as unknown as { stack: Layer[] }).stack).toHaveLength(25);
  });

  it.each([
    ['get', '/api/auth/me'],
    ['get', '/api/profiles/me'],
    ['post', '/api/services'],
    ['get', '/api/contracts'],
    ['get', '/api/wallet'],
    ['get', '/api/credits/transactions'],
    ['get', '/api/boosts'],
    ['post', '/api/reviews'],
    ['get', '/api/gamification/me'],
    ['get', '/api/barters'],
    ['get', '/api/withdrawals'],
    ['get', '/api/notifications'],
    ['get', '/api/messaging/contracts/1'],
    ['get', '/api/lgpd/consents'],
    ['get', '/api/favorites'],
    ['get', '/api/saved-searches'],
    ['get', '/api/reports'],
    ['get', '/api/moderation/removals'],
    ['get', '/api/disputes'],
    ['get', '/api/admin/metrics'],
    ['post', '/api/media'],
  ] as const)('%s %s existe e exige login', async (method, path) => {
    // A rota está declarada com esse método: em módulo que pede o token no router inteiro, só o
    // 401 não diria se ela existe (qualquer caminho debaixo do prefixo responderia 401).
    const stack = (app as unknown as { _router: { stack: Layer[] } })._router.stack;
    expect(declares(stack, method, path)).toBe(true);

    const res = await request(app)[method](path);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing_token');
    // Chegou a pedir o token sem consultar o banco: a recusa é da rota, não de um service.
    expect(fakeDb.calls.filter((c) => !c.sql.includes('platform_settings'))).toEqual([]);
  });

  it('o painel admin recusa quem está logado mas não é admin', async () => {
    const res = await request(app).get('/api/admin/metrics').set(bearer(7, 'client')).expect(403);
    expect(res.body.error).toBe('admin_only');
  });

  it('health responde sem login em /api/health (com o banco) e /api/health/live (sem ele)', async () => {
    const ready = await request(app).get('/api/health').expect(200);
    expect(ready.body).toMatchObject({ status: 'ok', db: 'up' });

    const live = await request(app).get('/api/health/live').expect(200);
    expect(live.body.status).toBe('ok');
    expect(live.body).not.toHaveProperty('db');
  });

  it('categorias e parâmetros públicos respondem sem login', async () => {
    const categories = await request(app).get('/api/categories').expect(200);
    expect(categories.body).toEqual([]);

    const settings = await request(app).get('/api/settings/public').expect(200);
    // Sem nada gravado em platform_settings valem os padrões, e a manutenção está desligada.
    expect(settings.body).toMatchObject({ maintenanceMode: false, barterEnabled: true });
    expect(typeof settings.body.platformFeePercentage).toBe('number');
  });

  it('o webhook de pagamento está em /api/payments/webhook e fica desligado sem o segredo configurado', async () => {
    const res = await request(app).post('/api/payments/webhook').send({}).expect(503);

    expect(res.body.error).toBe('webhook_disabled');
  });
});
