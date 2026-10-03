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
  // ADR 58: lembretes, fuso do prazo, avisos da aprovação tácita e a janela da avaliação.
  'jobs/deadline-reminders.ts',
  'modules/contracts/reminders.repository.ts',
  'modules/contracts/reminders-sql.ts',
  'modules/contracts/deadline-reminders.service.ts',
  'modules/contracts/contract-zones.ts',
  'modules/contracts/approval-notices.ts',
  'modules/contracts/reminder-notices.ts',
  'modules/reviews/reviews.service.ts',
];

/**
 * O fuso do prazo não é gravado (ADR 58, corte da crítica): é calculado na leitura por
 * inferDeadlineZone (contract-zones.ts). Uma coluna deadline_zone voltando ao fluxo seria uma
 * segunda verdade para o mesmo dia.
 */
const ADR58_MIGRATIONS = ['0029_lembretes_prazos.sql', '0030_lembretes_marcos.sql'];

describe('o fluxo de prazos usa um relógio só', () => {
  it.each(FLOW)('%s não usa NOW(), Date.now() nem new Date() sem argumento', (file) => {
    const src = readFileSync(join(ROOT, file), 'utf8');
    expect(src).not.toMatch(/\bNOW\(\)/);
    expect(src).not.toMatch(/Date\.now\(\)/);
    expect(src).not.toMatch(/new Date\(\)/);
  });

  it.each(FLOW)('%s não lê nem grava uma coluna deadline_zone', (file) => {
    const src = readFileSync(join(ROOT, file), 'utf8');
    expect(src).not.toContain('deadline_zone');
  });

  it.each(ADR58_MIGRATIONS)('a migração %s não cria a coluna deadline_zone', (file) => {
    const sql = readFileSync(join(ROOT, '..', 'db', 'migrations', file), 'utf8');
    expect(sql).not.toContain('deadline_zone');
  });

  it('a abertura da disputa (que a RN-029 também usa) grava o status anterior e recebe :now', () => {
    const src = readFileSync(join(ROOT, 'modules/disputes/disputes.repository.ts'), 'utf8');
    const create = src.slice(src.indexOf('async create('), src.indexOf('async findById('));
    expect(create).not.toMatch(/\bNOW\(\)/);
    expect(create).toContain(':oldStatus');
  });
});
