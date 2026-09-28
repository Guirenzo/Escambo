import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * O fluxo de prazos lê a hora de um relógio só (ADR 57, utils/clock.ts): o SQL recebe :now do
 * Node e nada chama o relógio real. Um NOW() do MySQL ou um Date.now() num destes arquivos faria
 * a hora gravada divergir da hora humana calculada, e os testes de integração, que põem o relógio
 * num horário diurno, deixariam de valer à noite.
 */
const ROOT = join(__dirname, '..', '..');
const FLOW = [
  'modules/contracts/contracts.repository.ts',
  'modules/contracts/milestones.repository.ts',
  'modules/contracts/contracts.service.ts',
  'modules/contracts/cancel-policy.ts',
  'modules/contracts/deadline-grace.ts',
  'modules/contracts/deadline-sql.ts',
  'jobs/overdue-contracts.ts',
  'jobs/tacit-approval.ts',
  'jobs/expire-proposals.ts',
  'jobs/repair-deadlines.ts',
];

describe('o fluxo de prazos usa um relógio só', () => {
  it.each(FLOW)('%s não usa NOW(), Date.now() nem new Date() sem argumento', (file) => {
    const src = readFileSync(join(ROOT, file), 'utf8');
    expect(src).not.toMatch(/\bNOW\(\)/);
    expect(src).not.toMatch(/Date\.now\(\)/);
    expect(src).not.toMatch(/new Date\(\)/);
  });

  it('a abertura da disputa (que a RN-029 também usa) grava o status anterior e recebe :now', () => {
    const src = readFileSync(join(ROOT, 'modules/disputes/disputes.repository.ts'), 'utf8');
    const create = src.slice(src.indexOf('async create('), src.indexOf('async findById('));
    expect(create).not.toMatch(/\bNOW\(\)/);
    expect(create).toContain(':oldStatus');
  });
});
