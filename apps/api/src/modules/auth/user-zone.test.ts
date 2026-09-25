import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth.repository', () => ({ authRepository: { findById: vi.fn() } }));

import { authRepository } from './auth.repository';
import { userZone } from './user-zone';

const findById = vi.mocked(authRepository.findById);

beforeEach(() => vi.clearAllMocks());

/** O fuso de quem lê o aviso (ADR 46 e 56): nunca lança, e na dúvida é Brasília. */
describe('userZone', () => {
  it('devolve o fuso gravado na conta', async () => {
    findById.mockResolvedValue({ timezone: 'America/Manaus' } as never);
    expect(await userZone(7)).toBe('America/Manaus');
  });

  it('conta sem fuso ou inexistente fica em Brasília', async () => {
    findById.mockResolvedValue({ timezone: null } as never);
    expect(await userZone(7)).toBe('America/Sao_Paulo');
    findById.mockResolvedValue(undefined);
    expect(await userZone(7)).toBe('America/Sao_Paulo');
  });

  it('banco fora não derruba o aviso: Brasília', async () => {
    findById.mockRejectedValue(new Error('db fora'));
    await expect(userZone(7)).resolves.toBe('America/Sao_Paulo');
  });
});
