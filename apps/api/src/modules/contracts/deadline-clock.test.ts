import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLOSE_PENDING_EXTENSION } from './deadline-sql';

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
  'modules/contracts/dispute-window.ts',
  'modules/contracts/delivery-snapshots.ts',
  'modules/dropouts/dropouts.ts',
  'modules/dropouts/dropouts.repository.ts',
  'modules/dropouts/dropouts.service.ts',
  'jobs/reconcile-dropout-reviews.ts',
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
    const start = src.indexOf('async function openInTx(');
    const end = src.indexOf('export const disputesRepository');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const open = src.slice(start, end);
    expect(open).not.toMatch(/\bNOW\(\)|Date\.now\(\)|new Date\(\)/);
    expect(open).toContain('now: Date');
    expect(open).toContain('oldStatus, now');
    expect(open).toContain('c.status = :oldStatus');
    expect(open).toContain("VALUES (:contractId, :openedBy, :oldStatus, 'disputed'");
    expect(open).toContain("CLOSE_PENDING_EXTENSION('c')");
    expect(CLOSE_PENDING_EXTENSION('c')).toContain(':now');

    const automatic = src.slice(src.indexOf('async create('), src.indexOf('async createManual('));
    // A origem (status-history.ts) vem de quem chama: a disputa por prazo é da plataforma.
    expect(automatic.replace(/\s+/g, ' ')).toContain(
      'openInTx( conn, d, oldStatus, opts.now ?? clock.now(), opts.source, opts.guard, )',
    );
    expect(automatic).not.toMatch(/\bNOW\(\)/);
    expect(automatic).not.toContain('disputeOpensAt');
  });

  it('a disputa manual consulta o relógio depois da trava e da recuperação/releitura histórica', () => {
    const src = readFileSync(join(ROOT, 'modules/disputes/disputes.repository.ts'), 'utf8');
    const manual = src.slice(src.indexOf('async createManual('), src.indexOf('async findById('));
    const lock = manual.indexOf('FOR UPDATE');
    const recovery = manual.indexOf('await recoverDeliveryRules');
    const reread = manual.indexOf('await contractsRepository.findById');
    const now = manual.indexOf('clock.now()');
    const write = manual.indexOf('await openInTx');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(recovery).toBeGreaterThan(lock);
    expect(reread).toBeGreaterThan(recovery);
    expect(now).toBeGreaterThan(reread);
    expect(write).toBeGreaterThan(now);
    expect(manual.match(/clock\.now\(\)/g)).toHaveLength(1);
    expect(manual).toContain('openInTx(conn, d, oldStatus, now, source)');
    expect(manual).not.toMatch(/\bNOW\(\)|Date\.now\(\)|new Date\(\)/);
  });
});
