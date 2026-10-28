#!/usr/bin/env node
/**
 * Google FALSO para os testes ponta a ponta do login com Google (RF-002). Só para testes: nunca
 * faz parte do app nem da imagem de produção. Um servidor HTTP mínimo, só em 127.0.0.1, com o que
 * a API usa do Google:
 *
 *   GET  /authorize  a "tela do Google": escolher a conta (e-mail e nome) ou cancelar
 *   POST /authorize  volta ao endereço de volta com ?code=&state= (ou ?error=access_denied)
 *   POST /token      troca o código pelo ID token: confere o cliente, o segredo, o endereço de volta
 *                    e o PKCE (S256), e o código vale uma vez, como no Google
 *
 * O ID token sai sem assinatura de verdade (a API não a confere: ele vem direto do token endpoint,
 * OIDC Core 3.1.3.7), com iss do Google, aud = client id, o nonce da ida e email_verified. O `sub`
 * é derivado do e-mail: o mesmo e-mail é sempre a mesma conta Google.
 *
 * Uso (o mesmo GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET da API):
 *   node apps/web/e2e/google-falso.mjs [--port 0]
 * Imprime GOOGLE_TEST_IDP_URL=http://127.0.0.1:PORTA, que vai para a API (só endereço local).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? '';
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('google-falso: defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET (os mesmos da API)');
  process.exit(1);
}
const portArg = process.argv.indexOf('--port');
const PORT = portArg > 0 ? Number(process.argv[portArg + 1]) : 0;

/** Códigos emitidos: o que cada um leva até o token endpoint (uso único). */
const codes = new Map();

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const subOf = (email) =>
  createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 21);
const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

async function readForm(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return new URLSearchParams(body);
}

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
const json = (res, status, body) => send(res, status, 'application/json', JSON.stringify(body));

/** Os parâmetros da ida, conferidos como o Google confere antes de mostrar a tela. */
function authorizeParams(params) {
  const keep = [
    'client_id',
    'redirect_uri',
    'response_type',
    'scope',
    'state',
    'nonce',
    'code_challenge',
    'code_challenge_method',
  ];
  const out = Object.fromEntries(keep.map((k) => [k, params.get(k) ?? '']));
  const ok =
    out.client_id === CLIENT_ID &&
    out.response_type === 'code' &&
    out.code_challenge_method === 'S256' &&
    out.code_challenge !== '' &&
    out.nonce !== '' &&
    out.scope.split(' ').includes('openid') &&
    /^https?:\/\//.test(out.redirect_uri);
  return ok ? out : null;
}

function consentPage(params) {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
    .join('');
  return `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Google falso dos testes</title>
<style>body{font-family:system-ui,sans-serif;max-width:26rem;margin:2rem auto;padding:0 1rem}
label{display:block;margin:.75rem 0 .25rem}input[type=email],input[type=text]{width:100%;padding:.5rem;box-sizing:border-box}
button{margin:1rem .5rem 0 0;padding:.6rem 1rem}</style></head>
<body><main>
<h1>Google falso (testes)</h1>
<p>Escolha a conta Google para entrar no Escambo.</p>
<form method="post" action="/authorize">${hidden}
<label for="email">E-mail</label><input id="email" name="email" type="email" required>
<label for="name">Nome</label><input id="name" name="name" type="text">
<label><input name="email_verified" type="checkbox" value="true" checked> E-mail confirmado pelo Google</label>
<button type="submit" name="action" value="continuar">Continuar</button>
<button type="submit" name="action" value="cancelar" formnovalidate>Cancelar</button>
</form></main></body></html>`;
}

function back(res, redirectUri, query) {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  send(res, 302, 'text/plain', '', { Location: url.toString() });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const params = authorizeParams(url.searchParams);
      if (!params) return send(res, 400, 'text/plain; charset=utf-8', 'pedido inválido');
      return send(res, 200, 'text/html; charset=utf-8', consentPage(params));
    }
    if (req.method === 'POST' && url.pathname === '/authorize') {
      const form = await readForm(req);
      const params = authorizeParams(form);
      if (!params) return send(res, 400, 'text/plain; charset=utf-8', 'pedido inválido');
      if (form.get('action') === 'cancelar') {
        return back(res, params.redirect_uri, { error: 'access_denied', state: params.state });
      }
      const email = (form.get('email') ?? '').trim();
      const code = `4/0-falso-${randomBytes(24).toString('base64url')}`;
      codes.set(code, {
        ...params,
        email,
        name: (form.get('name') ?? '').trim(),
        emailVerified: form.get('email_verified') === 'true',
      });
      return back(res, params.redirect_uri, { code, state: params.state });
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const form = await readForm(req);
      const entry = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) {
        return json(res, 401, { error: 'invalid_client' });
      }
      const verifier = form.get('code_verifier') ?? '';
      if (
        !entry ||
        form.get('grant_type') !== 'authorization_code' ||
        form.get('redirect_uri') !== entry.redirect_uri ||
        createHash('sha256').update(verifier).digest('base64url') !== entry.code_challenge
      ) {
        return json(res, 400, { error: 'invalid_grant' });
      }
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: 'https://accounts.google.com',
        aud: CLIENT_ID,
        azp: CLIENT_ID,
        sub: subOf(entry.email),
        email: entry.email,
        email_verified: entry.emailVerified,
        nonce: entry.nonce,
        iat: now,
        exp: now + 3600,
        ...(entry.name ? { name: entry.name } : {}),
      };
      return json(res, 200, {
        access_token: `ya29.falso-${randomBytes(12).toString('hex')}`,
        id_token: `${b64url({ alg: 'RS256', kid: 'falso' })}.${b64url(claims)}.assinatura-falsa`,
        expires_in: 3599,
        token_type: 'Bearer',
        scope: 'openid email profile',
      });
    }
    send(res, 404, 'text/plain; charset=utf-8', 'não encontrado');
  } catch (err) {
    console.error('google-falso:', err);
    send(res, 500, 'text/plain; charset=utf-8', 'erro');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const { port } = server.address();
  console.log(`GOOGLE_TEST_IDP_URL=http://127.0.0.1:${port}`);
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close(() => process.exit(0)));
