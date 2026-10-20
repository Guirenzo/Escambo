import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * O que os docker-compose precisam para o RNF-036 e o RNF-037 valerem fora dos testes (a integração
 * roda como root e não enxergaria a falta): o MySQL aceitar trigger criado pelo usuário da
 * aplicação, e o log de cada contêiner de produção ter rotação, em vez de crescer até encher o disco.
 */

const REPO_DIR = join(__dirname, '..', '..', '..', '..');
/** Com as quebras de linha normalizadas: no checkout do Windows os arquivos vêm com CRLF. */
const read = (file: string): string =>
  readFileSync(join(REPO_DIR, file), 'utf8').replace(/\r\n/g, '\n');

/** Os serviços de `services:` (indentação de 2 espaços), cada um com o próprio bloco de texto. */
function services(compose: string): Map<string, string> {
  const body = compose.slice(compose.indexOf('\nservices:\n'), compose.indexOf('\nvolumes:\n'));
  const out = new Map<string, string>();
  const parts = body.split(/^ {2}([\w-]+):\n/m);
  for (let i = 1; i < parts.length; i += 2) out.set(parts[i]!, parts[i + 1]!);
  return out;
}

describe.each(['docker-compose.yml', 'docker-compose.prod.yml'])('%s', (file) => {
  it('o MySQL sobe com log-bin-trust-function-creators: o migrate, sem SUPER, cria os triggers da 0046', () => {
    const db = services(read(file)).get('db');
    expect(db).toBeDefined();
    expect(db).toMatch(/^ {6}--log-bin-trust-function-creators=1$/m);
  });
});

describe('docker-compose.prod.yml: rotação do log dos contêineres (RNF-037)', () => {
  const compose = read('docker-compose.prod.yml');

  it('as duas âncoras usam json-file com teto de tamanho, de arquivos e compressão', () => {
    for (const [anchor, size, files] of [
      ['logging', '100m', '40'],
      ['logging-small', '20m', '5'],
    ] as const) {
      const block = compose.slice(compose.indexOf(`x-${anchor}: &${anchor}\n`)).split('\n\n')[0]!;
      expect(block.split('\n').slice(0, 6)).toEqual([
        `x-${anchor}: &${anchor}`,
        '  driver: json-file',
        '  options:',
        `    max-size: '${size}'`,
        `    max-file: '${files}'`,
        "    compress: 'true'",
      ]);
    }
  });

  it('todo serviço tem rotação; API e web (uma linha por requisição) com o teto maior', () => {
    const all = services(compose);
    expect([...all.keys()]).toEqual(
      expect.arrayContaining(['db', 'migrate', 'api', 'web', 'caddy', 'prometheus', 'grafana']),
    );
    for (const [name, block] of all) {
      const big = name === 'api' || name === 'web';
      expect(block, name).toMatch(
        new RegExp(`^ {4}logging: \\*logging${big ? '' : '-small'}$`, 'm'),
      );
    }
  });
});
