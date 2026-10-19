import { Writable } from 'node:stream';
import { pino, type Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import { loggerOptions } from './logger';

/** O logger com as opções da API, escrevendo numa lista em vez do stdout. */
function capture(): { log: Logger<never>; lines: () => Record<string, unknown>[] } {
  const out: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      out.push(chunk.toString());
      cb();
    },
  });
  const log = pino({ ...loggerOptions, level: 'info' }, stream);
  return { log, lines: () => out.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

/**
 * O redact do log (RNF de segurança, LGPD, RNF-017): credenciais e o destino dos saques nunca saem,
 * nem dentro do erro do banco, que traz a instrução já com os valores.
 */
describe('logger: o que nunca vai para o log', () => {
  it('a instrução SQL do erro do mysql2 sai censurada; o código e a mensagem ficam', () => {
    const { log, lines } = capture();
    const err = Object.assign(new Error('Lock wait timeout exceeded'), {
      code: 'ER_LOCK_WAIT_TIMEOUT',
      sqlMessage: 'Lock wait timeout exceeded',
      sql: "INSERT INTO withdrawals (pix_key) VALUES ('chave-secreta@escambo.test')",
    });

    log.error({ err }, 'erro não tratado');

    const [line] = lines();
    expect(line!.err).toMatchObject({
      code: 'ER_LOCK_WAIT_TIMEOUT',
      message: 'Lock wait timeout exceeded',
      sql: '[REDACTED]',
    });
    expect(JSON.stringify(lines())).not.toContain('chave-secreta');
  });

  it('chave PIX e dados bancários, soltos ou um nível abaixo, em camelCase ou como coluna', () => {
    const { log, lines } = capture();
    const destination = {
      pixKey: 'chave-secreta@escambo.test',
      bankName: 'Banco Secreto',
      bankAgency: '9876',
      bankAccount: '55555-5',
    };
    const row = {
      pix_key: 'chave-secreta@escambo.test',
      bank_name: 'Banco Secreto',
      bank_agency: '9876',
      bank_account: '55555-5',
    };

    log.info({ ...destination, input: destination, row }, 'saque');
    log.info(row, 'linha');

    const text = JSON.stringify(lines());
    for (const secret of ['chave-secreta', 'Banco Secreto', '9876', '55555-5']) {
      expect(text).not.toContain(secret);
    }
    expect(lines()[0]).toMatchObject({
      pixKey: '[REDACTED]',
      input: { bankAccount: '[REDACTED]' },
    });
  });

  it('as credenciais de antes continuam censuradas', () => {
    const { log, lines } = capture();

    log.info({ password: 'p', token: 't', user: { refreshToken: 'r' } }, 'login');

    expect(lines()[0]).toMatchObject({
      password: '[REDACTED]',
      token: '[REDACTED]',
      user: { refreshToken: '[REDACTED]' },
    });
  });
});
