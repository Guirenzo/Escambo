import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./profiles.repository', () => ({
  profilesRepository: {
    findCpf: vi.fn(),
    payoutState: vi.fn(),
    cpfIndexTaken: vi.fn(),
    saveVerifiedCpf: vi.fn(),
    clearCpf: vi.fn(),
    findCompanyByUserId: vi.fn(),
    findPublicCompanyByUlid: vi.fn(),
    cnpjTaken: vi.fn(),
    upsertCompany: vi.fn(),
  },
}));
vi.mock('../auth/auth.repository', () => ({ authRepository: { findById: vi.fn() } }));
vi.mock('../audit/audit.service', () => ({
  auditService: { log: vi.fn().mockResolvedValue(undefined) },
}));

import { setClockForTests } from '../../utils/clock';
import {
  blindIndex,
  blindIndexCandidates,
  openField,
  sealField,
  setFieldKeysForTests,
} from '../../utils/field-crypto';
import { auditService } from '../audit/audit.service';
import { authRepository, type UserRow } from '../auth/auth.repository';
import { CPF_INDEX_CONTEXT, cpfService } from './cpf.service';
import {
  profilesRepository,
  type CompanyRow,
  type CpfRow,
  type PublicCompanyRow,
} from './profiles.repository';
import { profilesService } from './profiles.service';

const repo = vi.mocked(profilesRepository);
const users = vi.mocked(authRepository);
const audit = vi.mocked(auditService.log);

const KEY = Buffer.alloc(32, 0x61).toString('base64');
const OLD_KEY = Buffer.alloc(32, 0x62).toString('base64');
const CPF = '52998224725';
const CTX = { ip: '127.0.0.1', userAgent: 'vitest' };
/** 26/10/2026, 01:00 em UTC: ainda 25/10 em Brasília e em Manaus. */
const NOW = new Date('2026-10-26T01:00:00.000Z');

const cpfRow = (o: Partial<Record<keyof CpfRow, unknown>> = {}): CpfRow =>
  ({
    cpf_verified: 0,
    cpf_encrypted: null,
    birth_date: null,
    cpf_verified_at: null,
    ...o,
  }) as CpfRow;

beforeEach(() => {
  vi.clearAllMocks();
  setFieldKeysForTests({ current: KEY });
  setClockForTests(NOW, { frozen: true });
  users.findById.mockResolvedValue({ id: 7, timezone: 'America/Sao_Paulo' } as UserRow);
  repo.findCpf.mockResolvedValue(cpfRow());
  repo.payoutState.mockResolvedValue({ delivers_work: 1, cpf_verified: 0 } as never);
  repo.cpfIndexTaken.mockResolvedValue(false);
  repo.saveVerifiedCpf.mockResolvedValue(true);
});
afterEach(() => {
  setFieldKeysForTests(null);
  setClockForTests(null);
});

/** CPF do freelancer (RF-020, RN-009, RN-075): formato, unicidade e idade; nunca consulta à Receita. */
describe('cpfService.status', () => {
  it('antes de validar: servidor pronto, saque pedindo o CPF, nada de CPF nem de data', async () => {
    expect(await cpfService.status(7)).toEqual({
      available: true,
      required: true,
      hasFreelancerProfile: true,
      verified: false,
      maskedCpf: null,
      birthDate: null,
      verifiedAt: null,
    });
  });

  it('validado: o CPF só mascarado, a data de nascimento e quando foi validado', async () => {
    repo.findCpf.mockResolvedValue(
      cpfRow({
        cpf_verified: 1,
        cpf_encrypted: sealField(CPF),
        birth_date: '1990-05-17',
        cpf_verified_at: new Date('2026-10-20T12:00:00.000Z'),
      }),
    );
    repo.payoutState.mockResolvedValue({ delivers_work: 0, cpf_verified: 1 } as never);

    const s = await cpfService.status(7);

    expect(s).toEqual({
      available: true,
      required: false,
      hasFreelancerProfile: true,
      verified: true,
      maskedCpf: '***.982.247-**',
      birthDate: '1990-05-17',
      verifiedAt: '2026-10-20T12:00:00.000Z',
    });
    expect(JSON.stringify(s)).not.toContain(CPF);
  });

  it('sem chave, o recurso não está disponível; sem perfil de freelancer, diz isso', async () => {
    setFieldKeysForTests({});
    repo.findCpf.mockResolvedValue(undefined);
    repo.payoutState.mockResolvedValue(undefined);

    expect(await cpfService.status(7)).toMatchObject({
      available: false,
      required: false,
      hasFreelancerProfile: false,
      verified: false,
    });
  });
});

describe('cpfService.verify', () => {
  const input = { cpf: CPF, birthDate: '1990-05-17' };

  it('grava o CPF só cifrado, o índice cego da chave atual e a data, e devolve o CPF mascarado', async () => {
    repo.findCpf
      .mockResolvedValueOnce(cpfRow())
      .mockResolvedValueOnce(
        cpfRow({ cpf_verified: 1, cpf_encrypted: 'x', birth_date: '1990-05-17' }),
      );

    await cpfService.verify(7, input, CTX);

    expect(repo.cpfIndexTaken).toHaveBeenCalledWith(
      blindIndexCandidates(CPF_INDEX_CONTEXT, CPF),
      7,
    );
    const [userId, saved] = repo.saveVerifiedCpf.mock.calls[0]!;
    expect(userId).toBe(7);
    expect(saved.sealedCpf).not.toContain(CPF);
    expect(openField(saved.sealedCpf)).toEqual({ ok: true, value: CPF });
    expect(saved.index).toBe(blindIndex(CPF_INDEX_CONTEXT, CPF));
    expect(saved).toMatchObject({ birthDate: '1990-05-17', verifiedAt: NOW });
  });

  it('a auditoria registra o fato, sem o CPF nem a data de nascimento', async () => {
    await cpfService.verify(7, input, CTX);

    expect(audit).toHaveBeenCalledWith({
      userId: 7,
      action: 'cpf_verified',
      entityType: 'user',
      entityId: 7,
      ip: CTX.ip,
      userAgent: CTX.userAgent,
    });
    expect(JSON.stringify(audit.mock.calls)).not.toContain(CPF);
    expect(JSON.stringify(audit.mock.calls)).not.toContain('1990-05-17');
  });

  it('a unicidade confere também o índice das chaves antigas (rotação da FIELD_ENCRYPTION_KEY)', async () => {
    setFieldKeysForTests({ current: KEY, old: [OLD_KEY] });

    await cpfService.verify(7, input, CTX);

    const [indexes] = repo.cpfIndexTaken.mock.calls[0]!;
    expect(indexes).toHaveLength(2);
    expect(indexes[0]).toBe(blindIndex(CPF_INDEX_CONTEXT, CPF));
  });

  it('sem a FIELD_ENCRYPTION_KEY: 503 cpf_unavailable, sem ler nem gravar nada', async () => {
    setFieldKeysForTests({});

    await expect(cpfService.verify(7, input, CTX)).rejects.toMatchObject({
      statusCode: 503,
      code: 'cpf_unavailable',
    });
    expect(repo.findCpf).not.toHaveBeenCalled();
    expect(repo.saveVerifiedCpf).not.toHaveBeenCalled();
  });

  it('sem perfil de freelancer: 409 no_freelancer_profile', async () => {
    repo.findCpf.mockResolvedValue(undefined);

    await expect(cpfService.verify(7, input, CTX)).rejects.toMatchObject({
      statusCode: 409,
      code: 'no_freelancer_profile',
    });
  });

  it('já validado: 409 cpf_locked, e a correção é pelo suporte', async () => {
    repo.findCpf.mockResolvedValue(cpfRow({ cpf_verified: 1 }));

    const err = await cpfService.verify(7, input, CTX).catch((e) => e);

    expect(err).toMatchObject({ statusCode: 409, code: 'cpf_locked' });
    expect(err.message).toContain('fale com o suporte');
    expect(repo.saveVerifiedCpf).not.toHaveBeenCalled();
  });

  it('a maioridade é no dia de hoje do fuso da conta (RN-009): o aniversário de 18 conta no próprio dia', async () => {
    // 01:00 UTC de 26/10 ainda é 25/10 em Brasília: quem faz 18 em 26/10 ainda tem 17.
    await expect(
      cpfService.verify(7, { cpf: CPF, birthDate: '2008-10-26' }, CTX),
    ).rejects.toMatchObject({ statusCode: 422, code: 'underage' });

    // Ao meio-dia de 26/10 em Brasília, a pessoa já tem 18.
    setClockForTests(new Date('2026-10-26T15:00:00.000Z'), { frozen: true });
    await expect(
      cpfService.verify(7, { cpf: CPF, birthDate: '2008-10-26' }, CTX),
    ).resolves.toBeDefined();
  });

  it('o fuso é o da conta: em Manaus, às 23h do dia 25, quem faz 18 no dia 26 ainda é menor', async () => {
    users.findById.mockResolvedValue({ id: 7, timezone: 'America/Manaus' } as UserRow);
    // 03:30 UTC de 26/10: em Brasília já é 26 (00:30), em Manaus ainda é 25 (23:30).
    setClockForTests(new Date('2026-10-26T03:30:00.000Z'), { frozen: true });

    await expect(
      cpfService.verify(7, { cpf: CPF, birthDate: '2008-10-26' }, CTX),
    ).rejects.toMatchObject({ code: 'underage' });

    users.findById.mockResolvedValue({ id: 7, timezone: 'America/Sao_Paulo' } as UserRow);
    await expect(
      cpfService.verify(7, { cpf: CPF, birthDate: '2008-10-26' }, CTX),
    ).resolves.toBeDefined();
  });

  it('data de nascimento no futuro: 422 invalid_birth_date', async () => {
    await expect(
      cpfService.verify(7, { cpf: CPF, birthDate: '2026-12-01' }, CTX),
    ).rejects.toMatchObject({ statusCode: 422, code: 'invalid_birth_date' });
  });

  it('CPF de outra conta: 409 cpf_taken, sem gravar', async () => {
    repo.cpfIndexTaken.mockResolvedValue(true);

    const err = await cpfService.verify(7, input, CTX).catch((e) => e);

    expect(err).toMatchObject({ statusCode: 409, code: 'cpf_taken' });
    expect(err.message).not.toContain(CPF);
    expect(repo.saveVerifiedCpf).not.toHaveBeenCalled();
  });

  it('o mesmo CPF gravado em outra conta no meio do caminho: a chave única vira 409 cpf_taken', async () => {
    repo.saveVerifiedCpf.mockRejectedValue(
      Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' }),
    );

    await expect(cpfService.verify(7, input, CTX)).rejects.toMatchObject({ code: 'cpf_taken' });
    expect(audit).not.toHaveBeenCalled();
  });

  it('outra aba validou no meio: 409 cpf_locked; outro erro do banco sobe como veio', async () => {
    repo.saveVerifiedCpf.mockResolvedValueOnce(false);
    await expect(cpfService.verify(7, input, CTX)).rejects.toMatchObject({ code: 'cpf_locked' });

    const boom = new Error('conexão perdida');
    repo.saveVerifiedCpf.mockRejectedValueOnce(boom);
    await expect(cpfService.verify(7, input, CTX)).rejects.toBe(boom);
  });
});

describe('cpfService: atendimento', () => {
  it('adminSummary: null sem perfil de freelancer', async () => {
    repo.findCpf.mockResolvedValue(undefined);
    expect(await cpfService.adminSummary(7)).toBeNull();
  });

  it('clear repassa ao repositório e diz se havia CPF', async () => {
    repo.clearCpf.mockResolvedValue(true);
    expect(await cpfService.clear(7)).toBe(true);
    expect(repo.clearCpf).toHaveBeenCalledWith(7);
  });
});

/** Conta de empresa (RF-018). */
describe('profilesService: empresa', () => {
  const company = (o: Partial<Record<keyof CompanyRow, unknown>> = {}): CompanyRow =>
    ({
      company_name: 'Padaria Pão Bom Ltda',
      trade_name: 'Pão Bom',
      cnpj: '12ABC34501DE35',
      logo_url: null,
      bio: null,
      website: null,
      city: 'Joinville',
      state: 'SC',
      ...o,
    }) as CompanyRow;
  const input = {
    legalName: 'Padaria Pão Bom Ltda',
    tradeName: 'Pão Bom',
    cnpj: '12ABC34501DE35',
    logoUrl: '/api/media/2026/10/01J8ZQ4K7M3VX5R2T9W6Y1B0CD.webp',
    bio: 'Pães de fermentação natural.',
    website: 'https://paobom.com.br/',
    city: 'Joinville',
    state: 'sc',
  };

  beforeEach(() => {
    repo.findCompanyByUserId.mockResolvedValue(company());
    repo.cnpjTaken.mockResolvedValue(false);
    repo.upsertCompany.mockResolvedValue(undefined);
  });

  it('só a conta de empresa grava dados de empresa: 403 not_company para as outras', async () => {
    for (const role of ['client', 'freelancer', 'admin']) {
      await expect(profilesService.upsertCompany(7, role, input, CTX)).rejects.toMatchObject({
        statusCode: 403,
        code: 'not_company',
      });
    }
    expect(repo.upsertCompany).not.toHaveBeenCalled();
  });

  it('grava os dados (a UF em maiúsculas) e devolve o perfil no formato da API', async () => {
    const out = await profilesService.upsertCompany(7, 'company', input, CTX);

    expect(repo.cnpjTaken).toHaveBeenCalledWith('12ABC34501DE35', 7);
    expect(repo.upsertCompany).toHaveBeenCalledWith(7, { ...input, state: 'SC' });
    expect(out).toEqual({
      legalName: 'Padaria Pão Bom Ltda',
      tradeName: 'Pão Bom',
      cnpj: '12ABC34501DE35',
      logoUrl: null,
      bio: null,
      website: null,
      city: 'Joinville',
      state: 'SC',
    });
    // O CNPJ não mudou: nada na auditoria.
    expect(audit).not.toHaveBeenCalled();
  });

  it('o que não veio grava null', async () => {
    await profilesService.upsertCompany(
      7,
      'company',
      { legalName: 'A Ltda', tradeName: 'A', cnpj: '11222333000181', website: null },
      CTX,
    );
    expect(repo.upsertCompany).toHaveBeenCalledWith(7, {
      legalName: 'A Ltda',
      tradeName: 'A',
      cnpj: '11222333000181',
      logoUrl: null,
      bio: null,
      website: null,
      city: null,
      state: null,
    });
  });

  it('a troca do CNPJ fica na auditoria, de qual para qual (dado público)', async () => {
    await profilesService.upsertCompany(7, 'company', { ...input, cnpj: '11222333000181' }, CTX);

    expect(audit).toHaveBeenCalledWith({
      userId: 7,
      action: 'company_cnpj_changed',
      entityType: 'user',
      entityId: 7,
      oldValue: { cnpj: '12ABC34501DE35' },
      newValue: { cnpj: '11222333000181' },
      ip: CTX.ip,
      userAgent: CTX.userAgent,
    });
  });

  it('CNPJ de outra conta: 409 cnpj_taken, conferido antes e também pela chave única', async () => {
    repo.cnpjTaken.mockResolvedValueOnce(true);
    await expect(profilesService.upsertCompany(7, 'company', input, CTX)).rejects.toMatchObject({
      statusCode: 409,
      code: 'cnpj_taken',
    });
    expect(repo.upsertCompany).not.toHaveBeenCalled();

    repo.upsertCompany.mockRejectedValueOnce(
      Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' }),
    );
    await expect(profilesService.upsertCompany(7, 'company', input, CTX)).rejects.toMatchObject({
      code: 'cnpj_taken',
    });

    const boom = new Error('conexão perdida');
    repo.upsertCompany.mockRejectedValueOnce(boom);
    await expect(profilesService.upsertCompany(7, 'company', input, CTX)).rejects.toBe(boom);
  });

  it('linha anterior à 1.53.0, sem nome fantasia nem CNPJ: o nome fantasia cai na razão social', async () => {
    repo.findCompanyByUserId.mockResolvedValue(company({ trade_name: null, cnpj: null }));

    const mine = await profilesService.companySummary(7);

    expect(mine).toEqual({ tradeName: 'Padaria Pão Bom Ltda', cnpj: '' });
  });

  it('companySummary: null para quem não é empresa', async () => {
    repo.findCompanyByUserId.mockResolvedValue(undefined);
    expect(await profilesService.companySummary(7)).toBeNull();
  });

  it('a página pública traz o perfil, o ulid e desde quando a conta existe; empresa que não existe é 404', async () => {
    repo.findPublicCompanyByUlid.mockResolvedValueOnce({
      ...company(),
      ulid: '01COMPANY',
      created_at: new Date('2026-09-01T10:00:00.000Z'),
    } as PublicCompanyRow);

    expect(await profilesService.getPublicCompany('01COMPANY')).toMatchObject({
      tradeName: 'Pão Bom',
      cnpj: '12ABC34501DE35',
      userUlid: '01COMPANY',
      memberSince: '2026-09-01T10:00:00.000Z',
    });

    repo.findPublicCompanyByUlid.mockResolvedValueOnce(undefined);
    await expect(profilesService.getPublicCompany('01NADA')).rejects.toMatchObject({
      statusCode: 404,
      code: 'company_not_found',
    });
  });
});
