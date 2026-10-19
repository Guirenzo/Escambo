import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory()
      ? sources(path)
      : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
        ? [path]
        : [];
  });
}

describe('I29: criação de carteira centralizada em autocommit', () => {
  it('só wallet.repository cria carteiras: nenhuma transação de dinheiro repete o INSERT', () => {
    const creators = sources(SRC).filter((path) =>
      /INSERT\s+IGNORE\s+INTO\s+wallets\b/i.test(readFileSync(path, 'utf8')),
    );
    expect(creators.map((path) => relative(SRC, path).replace(/\\/g, '/'))).toEqual([
      'modules/wallet/wallet.repository.ts',
    ]);
    expect(readFileSync(creators[0]!, 'utf8')).not.toMatch(/beginTransaction|inTransaction/);
  });
});
