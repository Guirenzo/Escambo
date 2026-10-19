import { describe, expect, it } from 'vitest';
import type { ContractDropout, MyDropout } from '@escambo/types';
import {
  canAgreeDropout,
  canAppealDropout,
  dropoutCounts,
  validDropoutAppeal,
  validDropoutDecision,
} from './dropouts';

const end = Date.parse('2026-10-16T15:00:00Z');
const contract: ContractDropout = {
  at: '2026-10-09T15:00:00Z',
  agreedAt: null,
  agreeUntil: new Date(end).toISOString(),
  counts: true,
};
const item: MyDropout = {
  id: 1,
  contractId: 7,
  contractTitle: 'Site',
  droppedAt: contract.at,
  countsUntil: new Date(end).toISOString(),
  status: 'counting',
  appealText: null,
  appealedAt: null,
  canAppeal: true,
  decision: null,
  decisionNote: null,
};

describe('limites das desistências no navegador', () => {
  it('a confirmação aceita o instante dos sete dias e fecha no próximo milissegundo', () => {
    expect(canAgreeDropout(contract, end)).toBe(true);
    expect(canAgreeDropout(contract, end + 1)).toBe(false);
    expect(canAgreeDropout({ ...contract, agreedAt: contract.at }, end)).toBe(false);
    expect(canAgreeDropout({ ...contract, counts: false }, end)).toBe(false);
  });
  it('a desistência sai da janela no instante dos 60 dias e não aceita nova contestação', () => {
    expect(dropoutCounts(item, end - 1)).toBe(true);
    expect(dropoutCounts(item, end)).toBe(false);
    expect(canAppealDropout(item, end)).toBe(false);
    expect(canAppealDropout({ ...item, appealedAt: contract.at }, end - 1)).toBe(false);
    expect(canAppealDropout({ ...item, decision: 'upheld' }, end - 1)).toBe(false);
    expect(canAppealDropout({ ...item, status: 'agreed' }, end - 1)).toBe(false);
  });
  it('o limite conta só os caracteres reais da contestação e da decisão', () => {
    expect(validDropoutAppeal(' '.repeat(20))).toBe(false);
    expect(validDropoutAppeal(' a'.repeat(10))).toBe(false);
    expect(validDropoutAppeal('x'.repeat(20))).toBe(true);
    expect(validDropoutAppeal('x'.repeat(1000))).toBe(true);
    expect(validDropoutAppeal('x'.repeat(1001))).toBe(false);
    expect(validDropoutDecision('x'.repeat(9))).toBe(false);
    expect(validDropoutDecision('x'.repeat(10))).toBe(true);
    expect(validDropoutDecision('x'.repeat(500))).toBe(true);
    expect(validDropoutDecision('x'.repeat(501))).toBe(false);
  });
});
