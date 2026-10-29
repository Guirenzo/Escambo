import { beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';

// Endereço do app com a barra no fim, validade fixa do link e bcrypt de custo baixo; a lista de
// admins é a dos testes de unidade (root@escambo.test e o domínio @admin.escambo.test).
vi.mock('../../config/env', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../config/env')>();
  return {
    env: {
      ...original.env,
      APP_URL: 'https://app.escambo.test/',
      EMAIL_VERIFY_TTL_HOURS: 24,
      BCRYPT_SALT_ROUNDS: 4,
    },
  };
});
vi.mock('./auth.repository', () => ({
  authRepository: {
    findById: vi.fn(),
    findByEmail: vi.fn(),
    findContact: vi.fn(),
    updatePhone: vi.fn(),
  },
}));
vi.mock('./email-change.repository', () => ({
  emailChangeRepository: {
    create: vi.fn(),
    findPending: vi.fn(),
    cancelOpen: vi.fn(),
    confirm: vi.fn(),
  },
}));
vi.mock('./session.repository', () => ({
  sessionRepository: { create: vi.fn() },
}));
vi.mock('../audit/audit.service', () => ({
  auditService: { log: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../mail/mail.service', () => ({
  mailService: { send: vi.fn().mockResolvedValue(1), enabled: vi.fn().mockReturnValue(true) },
}));

import { contactService, EMAIL_CHANGE_MAX_PER_DAY, maskEmail } from './contact.service';
import { authRepository, type UserRow } from './auth.repository';
import { emailChangeRepository, type EmailChangeAccount } from './email-change.repository';
import { sessionRepository } from './session.repository';
import { auditService } from '../audit/audit.service';
import { mailService } from '../mail/mail.service';
import { hashToken } from '../../utils/tokens';
import { HttpError } from '../../utils/http-error';

/**
 * Troca de e-mail e telefone (RF-017): a senha confirma o titular, o endereço novo só vale pelo
 * link, a resposta não revela se o endereço tem conta, admin não troca nem vira admin pela troca,
 * o endereço antigo é avisado e a confirmação derruba as sessões.
 */

const CTX = { ip: '10.0.0.9', userAgent: 'vitest-navegador' };
const PASSWORD = 'senha-atual-123';
const HASH = bcrypt.hashSync(PASSWORD, 4);

const repo = vi.mocked(authRepository);
const changes = vi.mocked(emailChangeRepository);
const sessions = vi.mocked(sessionRepository);
const audit = vi.mocked(auditService);
const mail = vi.mocked(mailService);

const user = (o: Partial<{ role: string; email: string; password_hash: string | null }> = {}) =>
  ({
    id: 7,
    ulid: '01USERULID00000000000000000',
    email: 'ana@escambo.test',
    password_hash: HASH,
    role: 'freelancer',
    status: 'active',
    ...o,
  }) as unknown as UserRow;

const ACCOUNT: EmailChangeAccount = {
  id: 7,
  email: 'ana@escambo.test',
  role: 'freelancer',
  status: 'active',
  deleted_at: null,
};

/** Código do erro que a promessa rejeitou. */
async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return (err as HttpError).code;
  }
  throw new Error('era para recusar');
}

beforeEach(() => {
  vi.clearAllMocks();
  changes.create.mockResolvedValue(31);
  changes.cancelOpen.mockResolvedValue(0);
  repo.findByEmail.mockResolvedValue(undefined);
});

describe('maskEmail', () => {
  it('mostra o começo e o domínio, nunca o endereço inteiro', () => {
    expect(maskEmail('ana.souza@gmail.com')).toBe('an***@gmail.com');
    expect(maskEmail('jo@x.com')).toBe('j***@x.com');
    expect(maskEmail('a@x.com')).toBe('a***@x.com');
    expect(maskEmail('sem-arroba')).toBe('***');
    expect(maskEmail('@x.com')).toBe('***');
  });
});

describe('contactService.get', () => {
  it('e-mail, se está confirmado, telefone, a troca pendente e como a conta entra', async () => {
    repo.findContact.mockResolvedValue({
      email: 'ana@escambo.test',
      email_verified_at: new Date(),
      phone: '+5547999991234',
      has_password: 1,
      google_linked: 0,
    } as never);
    changes.findPending.mockResolvedValue({
      id: 3,
      new_email: 'nova@escambo.test',
      expires_at: new Date('2026-10-20T12:00:00Z'),
    } as never);

    expect(await contactService.get(7)).toEqual({
      email: 'ana@escambo.test',
      emailVerified: true,
      phone: '+5547999991234',
      pendingEmail: { email: 'nova@escambo.test', expiresAt: '2026-10-20T12:00:00.000Z' },
      hasPassword: true,
      googleLinked: false,
    });
  });

  it('sem telefone, sem confirmação e sem pedido; conta sumida é 404', async () => {
    repo.findContact.mockResolvedValue({
      email: 'ana@escambo.test',
      email_verified_at: null,
      phone: null,
      has_password: 1,
      google_linked: 0,
    } as never);
    changes.findPending.mockResolvedValue(undefined);
    expect(await contactService.get(7)).toEqual({
      email: 'ana@escambo.test',
      emailVerified: false,
      phone: null,
      pendingEmail: null,
      hasPassword: true,
      googleLinked: false,
    });

    repo.findContact.mockResolvedValue(undefined);
    expect(await codeOf(contactService.get(7))).toBe('user_not_found');
  });
});

describe('contactService.get: como a conta entra (RF-002)', () => {
  it('conta do Google sem senha: hasPassword false e googleLinked true (o MySQL devolve 0 e 1)', async () => {
    repo.findContact.mockResolvedValue({
      email: 'ana@gmail.com',
      email_verified_at: new Date(),
      phone: null,
      has_password: 0,
      google_linked: 1,
    } as never);
    changes.findPending.mockResolvedValue(undefined);
    expect(await contactService.get(7)).toMatchObject({ hasPassword: false, googleLinked: true });
  });
});

describe('contactService.requestEmailChange', () => {
  const input = { currentPassword: PASSWORD, newEmail: 'nova@escambo.test' };

  it('registra o pedido com o hash do token, manda o link ao endereço novo e o aviso ao atual', async () => {
    repo.findById.mockResolvedValue(user());
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-19T10:00:00.750Z') });
    let out;
    try {
      out = await contactService.requestEmailChange(7, input, CTX);
    } finally {
      vi.useRealTimers();
    }

    // Vencimento em 24 horas, sem os milissegundos que a coluna não guarda.
    expect(out).toEqual({ email: 'nova@escambo.test', expiresAt: '2026-10-20T10:00:00.000Z' });
    expect(changes.create).toHaveBeenCalledTimes(1);
    const saved = changes.create.mock.calls[0]![0];
    expect(saved).toMatchObject({
      userId: 7,
      newEmail: 'nova@escambo.test',
      maxPerDay: EMAIL_CHANGE_MAX_PER_DAY,
    });
    expect(saved.expiresAt.toISOString()).toBe('2026-10-20T10:00:00.000Z');

    expect(mail.send).toHaveBeenCalledTimes(2);
    const [link, notice] = mail.send.mock.calls.map((c) => c[0]);
    expect(link).toMatchObject({ userId: 7, to: 'nova@escambo.test', template: 'email_change' });
    expect(link!.vars.validity).toBe('24 horas');
    const token = /token=([A-Za-z0-9_-]+)$/.exec(link!.vars.link!)![1]!;
    expect(link!.vars.link).toBe(`https://app.escambo.test/confirmar-novo-email?token=${token}`);
    // Só o hash vai para o banco: o token do link não fica guardado.
    expect(saved.tokenHash).toBe(hashToken(token));
    expect(saved.tokenHash).not.toContain(token);

    expect(notice).toMatchObject({ userId: 7, to: 'ana@escambo.test', template: 'notification' });
    expect(notice!.vars.title).toBe('Pedido para trocar o e-mail da sua conta');
    expect(notice!.vars.body).toContain('no***@escambo.test');
    expect(notice!.vars.body).not.toContain('nova@escambo.test');
    expect(notice!.vars.body).toContain('Se não foi você');
    expect(notice!.vars.link).toBe('https://app.escambo.test/esqueci-senha');

    expect(audit.log).toHaveBeenCalledWith({
      userId: 7,
      action: 'email_change_requested',
      entityType: 'user',
      entityId: 7,
      newValue: { requestId: 31, to: 'no***@escambo.test', blocked: null },
      ip: '10.0.0.9',
      userAgent: 'vitest-navegador',
    });
  });

  it('senha errada (ou conta sem senha): 400 e nada é gravado nem enviado', async () => {
    repo.findById.mockResolvedValue(user());
    expect(
      await codeOf(contactService.requestEmailChange(7, { ...input, currentPassword: 'x' }, CTX)),
    ).toBe('wrong_password');
    repo.findById.mockResolvedValue(user({ password_hash: null }));
    expect(await codeOf(contactService.requestEmailChange(7, input, CTX))).toBe('wrong_password');
    repo.findById.mockResolvedValue(undefined);
    expect(await codeOf(contactService.requestEmailChange(7, input, CTX))).toBe('user_not_found');
    expect(changes.create).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('o mesmo e-mail de agora (sem diferenciar maiúsculas) é 400 same_email', async () => {
    repo.findById.mockResolvedValue(user({ email: 'Ana@Escambo.test' }));
    expect(
      await codeOf(
        contactService.requestEmailChange(7, { ...input, newEmail: 'ana@escambo.test' }, CTX),
      ),
    ).toBe('same_email');
    expect(changes.create).not.toHaveBeenCalled();
  });

  it('conta de administração não troca o e-mail pelo perfil (403), mesmo com a senha certa', async () => {
    repo.findById.mockResolvedValue(user({ role: 'admin', email: 'root@escambo.test' }));
    expect(await codeOf(contactService.requestEmailChange(7, input, CTX))).toBe(
      'admin_email_locked',
    );
    expect(changes.create).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it.each([
    ['de outra conta', 'outra@escambo.test', 'email_taken'],
    ['da lista de admins', 'root@escambo.test', 'admin_reserved'],
    ['de um domínio de admin', 'qualquer@admin.escambo.test', 'admin_reserved'],
  ])(
    'endereço %s: a resposta é a mesma, o pedido fica registrado, mas o link não sai',
    async (_caso, newEmail, blocked) => {
      repo.findById.mockResolvedValue(user());
      if (blocked === 'email_taken') {
        repo.findByEmail.mockResolvedValue({ ...user({ email: newEmail }), id: 99 } as UserRow);
      }

      const out = await contactService.requestEmailChange(7, { ...input, newEmail }, CTX);

      expect(out.email).toBe(newEmail);
      expect(changes.create).toHaveBeenCalledTimes(1);
      // Só o aviso ao endereço atual: nada vai ao endereço pedido.
      expect(mail.send).toHaveBeenCalledTimes(1);
      expect(mail.send.mock.calls[0]![0]).toMatchObject({
        to: 'ana@escambo.test',
        template: 'notification',
      });
      expect(audit.log.mock.calls[0]![0].newValue).toMatchObject({ blocked });
    },
  );

  it('passou do teto diário: 429 sem e-mail nem auditoria', async () => {
    repo.findById.mockResolvedValue(user());
    changes.create.mockResolvedValue(null);
    expect(await codeOf(contactService.requestEmailChange(7, input, CTX))).toBe(
      'too_many_email_changes',
    );
    expect(mail.send).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('o envio que falha não derruba o pedido (a resposta não espera os e-mails)', async () => {
    repo.findById.mockResolvedValue(user());
    mail.send.mockRejectedValueOnce(new Error('smtp fora'));
    await expect(contactService.requestEmailChange(7, input, CTX)).resolves.toMatchObject({
      email: 'nova@escambo.test',
    });
  });
});

describe('contactService.cancelEmailChange', () => {
  it('fecha os pedidos abertos e audita só quando havia algum', async () => {
    changes.cancelOpen.mockResolvedValue(1);
    await contactService.cancelEmailChange(7, CTX);
    expect(changes.cancelOpen).toHaveBeenCalledWith(7);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'email_change_cancelled',
        newValue: { reason: 'user', cancelled: 1 },
      }),
    );

    vi.clearAllMocks();
    changes.cancelOpen.mockResolvedValue(0);
    await contactService.cancelEmailChange(7, CTX);
    expect(audit.log).not.toHaveBeenCalled();
  });
});

describe('contactService.confirmEmailChange', () => {
  const confirmed = {
    kind: 'confirmed' as const,
    requestId: 31,
    userId: 7,
    oldEmail: 'ana@escambo.test',
    newEmail: 'nova@escambo.test',
    sessionsRevoked: 2,
  };

  it('procura pelo hash do token, audita mascarado e avisa o endereço antigo; sem login, sem sessão nova', async () => {
    changes.confirm.mockResolvedValue(confirmed);

    expect(await contactService.confirmEmailChange('t'.repeat(32), CTX, undefined)).toEqual({
      email: 'nova@escambo.test',
      session: null,
    });

    expect(changes.confirm.mock.calls[0]![0]).toBe(hashToken('t'.repeat(32)));
    expect(sessions.create).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith({
      userId: 7,
      action: 'email_changed',
      entityType: 'user',
      entityId: 7,
      oldValue: { email: 'an***@escambo.test' },
      newValue: { email: 'no***@escambo.test', requestId: 31, sessionsRevoked: 2 },
      ip: '10.0.0.9',
      userAgent: 'vitest-navegador',
    });
    expect(mail.send).toHaveBeenCalledTimes(1);
    const notice = mail.send.mock.calls[0]![0];
    expect(notice).toMatchObject({ userId: 7, to: 'ana@escambo.test', template: 'notification' });
    expect(notice.vars.title).toBe('O e-mail da sua conta foi trocado');
    expect(notice.vars.body).toContain('no***@escambo.test');
  });

  it('quem abriu o link logado na mesma conta ganha uma sessão nova; outra conta não', async () => {
    changes.confirm.mockResolvedValue(confirmed);
    repo.findById.mockResolvedValue(user({ email: 'nova@escambo.test' }));

    const own = await contactService.confirmEmailChange('t'.repeat(32), CTX, 7);
    expect(own.session).toEqual({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
    });
    expect(sessions.create).toHaveBeenCalledTimes(1);
    expect(sessions.create.mock.calls[0]![0]).toMatchObject({
      userId: 7,
      tokenHash: hashToken(own.session!.refreshToken),
    });

    sessions.create.mockClear();
    const other = await contactService.confirmEmailChange('t'.repeat(32), CTX, 8);
    expect(other.session).toBeNull();
    expect(sessions.create).not.toHaveBeenCalled();

    // A conta sumiu depois da confirmação: troca feita, sem sessão.
    repo.findById.mockResolvedValue(undefined);
    expect((await contactService.confirmEmailChange('t'.repeat(32), CTX, 7)).session).toBeNull();
  });

  it('link inválido é 400; endereço que outra conta pegou é 409; nada é auditado nem avisado', async () => {
    changes.confirm.mockResolvedValue({ kind: 'invalid' });
    expect(await codeOf(contactService.confirmEmailChange('x'.repeat(32), CTX, 7))).toBe(
      'invalid_token',
    );
    changes.confirm.mockResolvedValue({ kind: 'taken' });
    expect(await codeOf(contactService.confirmEmailChange('x'.repeat(32), CTX, 7))).toBe(
      'email_unavailable',
    );
    expect(audit.log).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });

  describe('a regra que a transação aplica à conta travada', () => {
    async function ruleFor(account: Partial<EmailChangeAccount>, newEmail = 'nova@escambo.test') {
      changes.confirm.mockImplementation(async (_hash, check) => {
        check({ ...ACCOUNT, ...account }, newEmail);
        return confirmed;
      });
      return codeOf(contactService.confirmEmailChange('t'.repeat(32), CTX, undefined));
    }

    it('conta excluída, banida ou suspensa não troca', async () => {
      expect(await ruleFor({ deleted_at: new Date() })).toBe('account_deleted');
      expect(await ruleFor({ status: 'banned' })).toBe('account_banned');
      expect(await ruleFor({ status: 'suspended' })).toBe('account_suspended');
    });

    it('admin não troca (o papel pode ter mudado depois do pedido) e ninguém vira admin pela troca', async () => {
      expect(await ruleFor({ role: 'admin' })).toBe('admin_email_locked');
      // A lista de admins pode ter ganhado o endereço depois do pedido.
      expect(await ruleFor({}, 'qualquer@admin.escambo.test')).toBe('email_unavailable');
      expect(await ruleFor({}, 'root@escambo.test')).toBe('email_unavailable');
    });

    it('conta comum, ativa ou ainda sem confirmar o e-mail, troca', async () => {
      for (const status of ['active', 'pending_verification']) {
        changes.confirm.mockImplementation(async (_hash, check) => {
          check({ ...ACCOUNT, status }, 'nova@escambo.test');
          return confirmed;
        });
        await expect(
          contactService.confirmEmailChange('t'.repeat(32), CTX, undefined),
        ).resolves.toMatchObject({ email: 'nova@escambo.test' });
      }
    });
  });
});

describe('contactService.updatePhone', () => {
  it('grava o E.164, audita sem o número e devolve o contato', async () => {
    repo.findContact.mockResolvedValue({
      email: 'ana@escambo.test',
      email_verified_at: null,
      phone: '+5547999991234',
      has_password: 1,
      google_linked: 0,
    } as never);
    changes.findPending.mockResolvedValue(undefined);

    const out = await contactService.updatePhone(7, '+5547999991234', CTX);

    expect(repo.updatePhone).toHaveBeenCalledWith(7, '+5547999991234');
    expect(out.phone).toBe('+5547999991234');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'phone_changed', newValue: { informed: true } }),
    );
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('99999');

    await contactService.updatePhone(7, null, CTX);
    expect(repo.updatePhone).toHaveBeenLastCalledWith(7, null);
    expect(audit.log).toHaveBeenLastCalledWith(
      expect.objectContaining({ newValue: { informed: false } }),
    );
  });
});
