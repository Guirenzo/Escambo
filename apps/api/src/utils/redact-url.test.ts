import { Writable } from 'node:stream';
import express from 'express';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  httpLogSerializers,
  redactOAuthHeaders,
  redactOAuthQuery,
  redactOAuthUrl,
} from './redact-url';

/** Os valores do fluxo do Google (RF-002) não vão para o log da requisição. */
describe('redactOAuthUrl / redactOAuthQuery', () => {
  it('censura code e state nas rotas do Google, e deixa o resto do endereço', () => {
    expect(
      redactOAuthUrl('/api/auth/google/callback?state=abc&code=4%2F0Ad-xyz&scope=email+openid'),
    ).toBe('/api/auth/google/callback?state=[REDACTED]&code=[REDACTED]&scope=email+openid');
    expect(redactOAuthUrl('/api/auth/google/callback?error=access_denied&state=s')).toBe(
      '/api/auth/google/callback?error=access_denied&state=[REDACTED]',
    );
  });

  it('fora das rotas do Google, ou sem endereço, nada muda', () => {
    expect(redactOAuthUrl('/api/services?code=1&state=SC')).toBe('/api/services?code=1&state=SC');
    expect(redactOAuthUrl(undefined)).toBeUndefined();
  });

  it('a query lida pelo Express sai numa cópia censurada; a original não muda', () => {
    const query = { code: 'x', state: 'y', scope: 'email' };
    expect(redactOAuthQuery('/api/auth/google/callback?code=x', query)).toEqual({
      code: '[REDACTED]',
      state: '[REDACTED]',
      scope: 'email',
    });
    expect(query.code).toBe('x');
    expect(redactOAuthQuery('/api/auth/google/start', {})).toEqual({});
    expect(redactOAuthQuery('/api/services', query)).toBe(query);
    expect(redactOAuthQuery('/api/auth/google/callback', undefined)).toBeUndefined();
    expect(redactOAuthQuery(undefined, query)).toBe(query);
  });
});

describe('redactOAuthHeaders', () => {
  it('o Location sai sem o código do web e sem o state, o nonce e o desafio da ida', () => {
    expect(
      redactOAuthHeaders({ location: 'https://app.example/entrar/google#codigo=abc123' }),
    ).toEqual({ location: 'https://app.example/entrar/google#codigo=[REDACTED]' });
    expect(
      redactOAuthHeaders({
        location:
          'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=s1&nonce=n1&code_challenge=c1&code_challenge_method=S256',
        'content-length': '0',
      }),
    ).toEqual({
      location:
        'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=[REDACTED]&nonce=[REDACTED]&code_challenge=[REDACTED]&code_challenge_method=S256',
      'content-length': '0',
    });
  });

  it('o Set-Cookie sai sem o estado cifrado da ida (um ou vários cookies)', () => {
    expect(
      redactOAuthHeaders({ 'set-cookie': 'escambo_google=valor.cifrado; Path=/api/auth/google' }),
    ).toEqual({ 'set-cookie': ['escambo_google=[REDACTED]; Path=/api/auth/google'] });
    expect(redactOAuthHeaders({ 'set-cookie': ['outro=1', 'escambo_google=v; HttpOnly'] })).toEqual(
      { 'set-cookie': ['outro=1', 'escambo_google=[REDACTED]; HttpOnly'] },
    );
  });

  it('sem Location nem Set-Cookie, o mesmo objeto; sem cabeçalhos, nada', () => {
    const headers = { 'content-type': 'application/json' };
    expect(redactOAuthHeaders(headers)).toBe(headers);
    expect(redactOAuthHeaders(undefined)).toBeUndefined();
    expect(redactOAuthHeaders('x')).toBe('x');
  });
});

describe('o log de requisição de verdade (pino-http com os serializadores)', () => {
  it('a volta do Google não deixa o código, o state, o código do web nem o cookie no log', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const app = express();
    app.use(pinoHttp({ logger: pino({ level: 'info' }, stream), serializers: httpLogSerializers }));
    app.get('/api/auth/google/callback', (_req, res) => {
      res.cookie('escambo_google', 'estado-cifrado-secreto', { path: '/api/auth/google' });
      res.redirect(302, 'http://app.example/entrar/google#codigo=codigo-do-web-secreto');
    });

    await request(app).get('/api/auth/google/callback?state=state-secreto&code=codigo-do-google');

    const log = lines.join('\n');
    expect(log).toContain('/api/auth/google/callback?state=[REDACTED]&code=[REDACTED]');
    expect(log).toContain('#codigo=[REDACTED]');
    expect(log).toContain('escambo_google=[REDACTED]');
    for (const secret of [
      'state-secreto',
      'codigo-do-google',
      'codigo-do-web-secreto',
      'estado-cifrado-secreto',
    ]) {
      expect(log).not.toContain(secret);
    }
  });
});
