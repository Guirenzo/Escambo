import { beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// Endereço do app com a barra no fim (como costuma vir no .env) e bcrypt de custo baixo, para o
// teste não depender do .env de quem roda nem pesar na suíte. O resto do env é o de verdade.
vi.mock('../../config/env', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../config/env')>();
  return {
    env: { ...original.env, APP_URL: 'https://app.escambo.test/', BCRYPT_SALT_ROUNDS: 4 },
  };
});

vi.mock('./auth.repository', () => ({
  authRepository: {
    findByEmail: vi.fn(),
    findByUlid: vi.fn(),
    findById: vi.fn(),
    updatePassword: vi.fn(),
    markEmailVerified: vi.fn(),
  },
}));
vi.mock('./session.repository', () => ({
  sessionRepository: {
    create: vi.fn(),
    findValidByHash: vi.fn(),
    revokeByHash: vi.fn(),
    revokeAllForUser: vi.fn().mockResolvedValue(3),
  },
}));
vi.mock('../audit/audit.service', () => ({
  auditService: { log: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../notifications/push.repository', () => ({
  pushRepository: { removeAllForUser: vi.fn().mockResolvedValue(0) },
}));
vi.mock('./email-change.repository', () => ({
  emailChangeRepository: { cancelOpen: vi.fn().mockResolvedValue(0) },
}));
vi.mock('../mail/mail.service', () => ({
  mailService: { send: vi.fn().mockResolvedValue(1), enabled: vi.fn().mockReturnValue(true) },
}));

import { authService } from './auth.service';
import { authRepository, type UserRow } from './auth.repository';
import { sessionRepository } from './session.repository';
import { emailChangeRepository } from './email-change.repository';
import { auditService } from '../audit/audit.service';
import { mailService } from '../mail/mail.service';
import { pushRepository } from '../notifications/push.repository';
import { hashToken } from '../../utils/tokens';

/**
 * Troca de senha com login (RF-017): a senha atual confirma o titular, a nova é gravada só como
 * hash, as sessões abertas caem (RN-008) e quem trocou segue com um par novo, a troca fica na
 * auditoria e o titular recebe o aviso por e-mail.
 */

const CTX = { ip: '10.0.0.9', userAgent: 'vitest-navegador' };
const CURRENT = 'senha-antiga-123';
const NEXT = 'senha-nova-456';
const CURRENT_HASH = bcrypt.hashSync(CURRENT, 4);

const repo = vi.mocked(authRepository);
const sessions = vi.mocked(sessionRepository);
const audit = vi.mocked(auditService);
const mail = vi.mocked(mailService);
const push = vi.mocked(pushRepository);
const changes = vi.mocked(emailChangeRepository);

/** Em que posição da sequência de chamadas o mock foi chamado (para conferir a ordem). */
const order = (fn: { mock: { invocationCallOrder: number[] } }): number =>
  fn.mock.invocationCallOrder[0]!;

const user = (o: Partial<{ password_hash: string | null; status: string }> = {}): UserRow =>
  ({
    id: 7,
    ulid: '01USERULID00000000000000000',
    email: 'ana@escambo.test',
    password_hash: CURRENT_HASH,
    role: 'freelancer',
    status: 'active',
    ...o,
  }) as unknown as UserRow;

/** Nada foi gravado nem avisado: a senha, as sessões, a auditoria e o e-mail seguem como estavam. */
function expectNothingChanged(): void {
  expect(repo.updatePassword).not.toHaveBeenCalled();
  expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
  expect(sessions.create).not.toHaveBeenCalled();
  expect(audit.log).not.toHaveBeenCalled();
  expect(mail.send).not.toHaveBeenCalled();
  expect(changes.cancelOpen).not.toHaveBeenCalled();
}

beforeEach(() => vi.clearAllMocks());

describe('authService.changePassword', () => {
  it('grava a nova senha como hash, encerra as sessões e devolve um par novo só para quem trocou', async () => {
    repo.findById.mockResolvedValue(user());

    const tokens = await authService.changePassword(
      7,
      { currentPassword: CURRENT, newPassword: NEXT },
      CTX,
    );

    expect(repo.findById).toHaveBeenCalledWith(7);
    expect(repo.updatePassword).toHaveBeenCalledTimes(1);
    const [userId, stored] = repo.updatePassword.mock.calls[0]!;
    expect(userId).toBe(7);
    expect(stored).not.toBe(NEXT);
    expect(bcrypt.compareSync(NEXT, stored)).toBe(true);
    expect(bcrypt.compareSync(CURRENT, stored)).toBe(false);

    // Todas as sessões caem antes de a nova existir: a desta troca não é revogada junto.
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(7);
    expect(sessions.create).toHaveBeenCalledTimes(1);
    expect(order(repo.updatePassword)).toBeLessThan(order(sessions.revokeAllForUser));
    expect(order(sessions.revokeAllForUser)).toBeLessThan(order(sessions.create));
    const session = sessions.create.mock.calls[0]![0];
    expect(session).toMatchObject({
      userId: 7,
      tokenHash: hashToken(tokens.refreshToken),
      ip: '10.0.0.9',
      userAgent: 'vitest-navegador',
    });

    expect(Object.keys(tokens).sort()).toEqual(['accessToken', 'refreshToken']);
    const claims = jwt.verify(tokens.accessToken, process.env.JWT_SECRET as string) as {
      sub: string;
      uid: number;
      role: string;
    };
    expect(claims).toMatchObject({
      sub: '01USERULID00000000000000000',
      uid: 7,
      role: 'freelancer',
    });
    // O aparelho de quem trocou segue recebendo os avisos no navegador.
    expect(push.removeAllForUser).not.toHaveBeenCalled();
  });

  it('registra a troca na auditoria, sem senha nenhuma, com quantas sessões caíram e de onde veio', async () => {
    repo.findById.mockResolvedValue(user());

    await authService.changePassword(7, { currentPassword: CURRENT, newPassword: NEXT }, CTX);

    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith({
      userId: 7,
      action: 'password_changed',
      entityType: 'user',
      entityId: 7,
      newValue: { sessionsRevoked: 3 },
      ip: '10.0.0.9',
      userAgent: 'vitest-navegador',
    });
    const logged = JSON.stringify(audit.log.mock.calls[0]![0]);
    expect(logged).not.toContain(CURRENT);
    expect(logged).not.toContain(NEXT);
  });

  it('cancela a troca de e-mail pendente (RF-017) e audita o cancelamento à parte', async () => {
    repo.findById.mockResolvedValue(user());
    changes.cancelOpen.mockResolvedValueOnce(1);

    await authService.changePassword(7, { currentPassword: CURRENT, newPassword: NEXT }, CTX);

    expect(changes.cancelOpen).toHaveBeenCalledWith(7);
    // Depois de derrubar as sessões e antes de abrir a desta troca.
    expect(order(sessions.revokeAllForUser)).toBeLessThan(order(changes.cancelOpen));
    expect(order(changes.cancelOpen)).toBeLessThan(order(sessions.create));
    expect(audit.log).toHaveBeenCalledTimes(2);
    expect(audit.log).toHaveBeenCalledWith({
      userId: 7,
      action: 'email_change_cancelled',
      entityType: 'user',
      entityId: 7,
      newValue: { reason: 'password_changed', cancelled: 1 },
      ip: '10.0.0.9',
      userAgent: 'vitest-navegador',
    });
  });

  it('avisa o titular por e-mail, com o caminho para redefinir se não foi ele', async () => {
    repo.findById.mockResolvedValue(user());

    await authService.changePassword(7, { currentPassword: CURRENT, newPassword: NEXT }, CTX);

    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(mail.send).toHaveBeenCalledWith({
      userId: 7,
      to: 'ana@escambo.test',
      template: 'notification',
      vars: {
        title: 'Sua senha foi alterada',
        body: 'A senha da sua conta no Escambo acabou de ser trocada, e as outras sessões abertas foram encerradas. Se não foi você, redefina a senha agora e fale com o suporte.',
        link: 'https://app.escambo.test/esqueci-senha',
        cta: 'Redefinir senha',
      },
    });
    expect(JSON.stringify(mail.send.mock.calls[0]![0])).not.toContain(NEXT);
  });

  it('senha atual errada: 400 wrong_password e nada muda', async () => {
    repo.findById.mockResolvedValue(user());

    await expect(
      authService.changePassword(7, { currentPassword: 'outra-senha-1', newPassword: NEXT }, CTX),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'wrong_password',
      message: 'Senha atual incorreta',
    });
    expectNothingChanged();
  });

  it('conta sem senha gravada também recusa como senha atual incorreta', async () => {
    repo.findById.mockResolvedValue(user({ password_hash: null }));

    await expect(
      authService.changePassword(7, { currentPassword: CURRENT, newPassword: NEXT }, CTX),
    ).rejects.toMatchObject({ statusCode: 400, code: 'wrong_password' });
    expectNothingChanged();
  });

  it('nova senha igual à atual: 400 same_password e nada muda', async () => {
    repo.findById.mockResolvedValue(user());

    await expect(
      authService.changePassword(7, { currentPassword: CURRENT, newPassword: CURRENT }, CTX),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'same_password',
      message: 'A nova senha precisa ser diferente da atual',
    });
    expectNothingChanged();
  });

  it('usuário que não existe mais: 404 user_not_found', async () => {
    repo.findById.mockResolvedValue(undefined);

    await expect(
      authService.changePassword(7, { currentPassword: CURRENT, newPassword: NEXT }, CTX),
    ).rejects.toMatchObject({ statusCode: 404, code: 'user_not_found' });
    expectNothingChanged();
  });
});
