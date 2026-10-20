import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('./admin/admin.repository', () => ({ adminRepository: { recordAction: vi.fn() } }));
vi.mock('./auth/auth.repository', () => ({
  authRepository: { findById: vi.fn(), findByUlid: vi.fn(), setEmailPreference: vi.fn() },
}));
vi.mock('./auth/session.repository', () => ({ sessionRepository: { revokeAllForUser: vi.fn() } }));
vi.mock('./contracts/contracts.repository', () => ({ contractsRepository: { findById: vi.fn() } }));
vi.mock('./contracts/milestones.repository', () => ({
  milestonesRepository: { escrowRemaining: vi.fn() },
}));
vi.mock('./disputes/disputes.repository', () => ({
  disputesRepository: { create: vi.fn(), findById: vi.fn(), listOpen: vi.fn(), resolve: vi.fn() },
}));
vi.mock('./dropouts/dropouts.repository', () => ({
  dropoutsRepository: { findByContractId: vi.fn(), listCounting: vi.fn() },
}));
vi.mock('./lgpd/lgpd.repository', () => ({ lgpdRepository: { recordConsent: vi.fn() } }));
vi.mock('./messaging/messaging.repository', () => ({
  messagingRepository: { getOrCreate: vi.fn() },
}));
vi.mock('./notifications/push.repository', () => ({
  pushRepository: { removeAllForUser: vi.fn() },
}));
vi.mock('./profiles/profiles.repository', () => ({
  profilesRepository: { findFreelancerByUserId: vi.fn(), blendResponseTime: vi.fn() },
}));
vi.mock('./reports/reports.repository', () => ({ reportsRepository: { create: vi.fn() } }));
vi.mock('./reviews/reviews.repository', () => ({
  reviewsRepository: { findByContractIdWithResponse: vi.fn() },
}));
vi.mock('./services/services.repository', () => ({ servicesRepository: { findById: vi.fn() } }));
vi.mock('./settings/settings.repository', () => ({
  settingsRepository: { getNumber: vi.fn(), get: vi.fn(), set: vi.fn() },
}));

import { adminFacade } from './admin/admin.facade';
import { adminRepository } from './admin/admin.repository';
import { authFacade } from './auth/auth.facade';
import { authRepository } from './auth/auth.repository';
import { sessionRepository } from './auth/session.repository';
import { contractsFacade } from './contracts/contracts.facade';
import { contractsRepository } from './contracts/contracts.repository';
import { milestonesRepository } from './contracts/milestones.repository';
import { disputesFacade } from './disputes/disputes.facade';
import { disputesRepository } from './disputes/disputes.repository';
import { dropoutsFacade } from './dropouts/dropouts.facade';
import { dropoutsRepository } from './dropouts/dropouts.repository';
import { lgpdFacade } from './lgpd/lgpd.facade';
import { lgpdRepository } from './lgpd/lgpd.repository';
import { messagingFacade } from './messaging/messaging.facade';
import { messagingRepository } from './messaging/messaging.repository';
import { notificationsFacade } from './notifications/notifications.facade';
import { pushRepository } from './notifications/push.repository';
import { profilesFacade } from './profiles/profiles.facade';
import { profilesRepository } from './profiles/profiles.repository';
import { reportsFacade } from './reports/reports.facade';
import { reportsRepository } from './reports/reports.repository';
import { reviewsFacade } from './reviews/reviews.facade';
import { reviewsRepository } from './reviews/reviews.repository';
import { servicesFacade } from './services/services.facade';
import { servicesRepository } from './services/services.repository';
import { settingsFacade } from './settings/settings.facade';
import { settingsRepository } from './settings/settings.repository';

/**
 * Fachadas dos módulos (RNF-021): quem era de fora e chamava o repository passou a chamar a
 * fachada do módulo dono. A troca não muda comportamento porque a fachada só repassa: a mesma
 * função do repository, com os mesmos argumentos, devolvendo o mesmo valor. Os testes de quem chama
 * continuam mockando o repository e passam sem alteração; aqui fica o contrato, função a função.
 */

const NOW = new Date('2026-10-20T12:00:00Z');
const DRAFT = {
  ulid: '01J',
  contractId: 9,
  openedBy: 3,
  reason: 'deadline',
  description: 'prazo',
};
const OPTS = { guard: 'AND x', now: NOW, source: 'system' };
const RESOLUTION = { disputeId: 4, adminId: 1, contractId: 9, refundToClient: 10 };
const REPORT = {
  reporterId: null,
  targetType: 'message',
  targetId: 7,
  imageUrl: null,
  reason: 'off_platform',
  description: 'automática',
};

/** [fachada.função, chamada, função do repository, argumentos que ela deve receber] */
const CASES: [string, () => Promise<unknown>, unknown, unknown[]][] = [
  [
    'adminFacade.recordAction',
    () => adminFacade.recordAction(1, 'finance_exported', 'finance', null, 'csv'),
    adminRepository.recordAction,
    [1, 'finance_exported', 'finance', null, 'csv'],
  ],
  ['authFacade.findById', () => authFacade.findById(5), authRepository.findById, [5]],
  ['authFacade.findByUlid', () => authFacade.findByUlid('01U'), authRepository.findByUlid, ['01U']],
  [
    'authFacade.setEmailPreference',
    () => authFacade.setEmailPreference(5, { emailFrequency: 'daily' }),
    authRepository.setEmailPreference,
    [5, { emailFrequency: 'daily' }],
  ],
  [
    'authFacade.revokeAllSessions',
    () => authFacade.revokeAllSessions(5),
    sessionRepository.revokeAllForUser,
    [5],
  ],
  [
    'contractsFacade.findById',
    () => contractsFacade.findById(9),
    contractsRepository.findById,
    [9],
  ],
  [
    'contractsFacade.escrowRemaining',
    () => contractsFacade.escrowRemaining(9),
    milestonesRepository.escrowRemaining,
    [9],
  ],
  [
    'disputesFacade.create',
    () => disputesFacade.create(DRAFT as never, OPTS as never),
    disputesRepository.create,
    [DRAFT, OPTS],
  ],
  ['disputesFacade.findById', () => disputesFacade.findById(4), disputesRepository.findById, [4]],
  ['disputesFacade.listOpen', () => disputesFacade.listOpen(), disputesRepository.listOpen, []],
  [
    'disputesFacade.resolve',
    () => disputesFacade.resolve(RESOLUTION as never),
    disputesRepository.resolve,
    [RESOLUTION],
  ],
  [
    'dropoutsFacade.findByContractId',
    () => dropoutsFacade.findByContractId(9),
    dropoutsRepository.findByContractId,
    [9],
  ],
  [
    'dropoutsFacade.listCounting',
    () => dropoutsFacade.listCounting(3, NOW),
    dropoutsRepository.listCounting,
    [3, NOW],
  ],
  [
    'lgpdFacade.recordConsent',
    () =>
      lgpdFacade.recordConsent({
        userId: 5,
        type: 'terms_of_use',
        version: '2026-01',
        accepted: true,
        ip: null,
        userAgent: null,
      }),
    lgpdRepository.recordConsent,
    [
      {
        userId: 5,
        type: 'terms_of_use',
        version: '2026-01',
        accepted: true,
        ip: null,
        userAgent: null,
      },
    ],
  ],
  [
    'messagingFacade.getOrCreate',
    () => messagingFacade.getOrCreate(2, 3, 9),
    messagingRepository.getOrCreate,
    [2, 3, 9],
  ],
  [
    'notificationsFacade.removeAllPushSubscriptions',
    () => notificationsFacade.removeAllPushSubscriptions(5),
    pushRepository.removeAllForUser,
    [5],
  ],
  [
    'profilesFacade.findFreelancerByUserId',
    () => profilesFacade.findFreelancerByUserId(3),
    profilesRepository.findFreelancerByUserId,
    [3],
  ],
  [
    'profilesFacade.blendResponseTime',
    () => profilesFacade.blendResponseTime(3, 1.5),
    profilesRepository.blendResponseTime,
    [3, 1.5],
  ],
  ['reportsFacade.create', () => reportsFacade.create(REPORT), reportsRepository.create, [REPORT]],
  [
    'reviewsFacade.findByContractIdWithResponse',
    () => reviewsFacade.findByContractIdWithResponse(9),
    reviewsRepository.findByContractIdWithResponse,
    [9],
  ],
  ['servicesFacade.findById', () => servicesFacade.findById(8), servicesRepository.findById, [8]],
  [
    'settingsFacade.getNumber',
    () => settingsFacade.getNumber('ranking_radius_km', 50),
    settingsRepository.getNumber,
    ['ranking_radius_km', 50],
  ],
  [
    'settingsFacade.get',
    () => settingsFacade.get('moderation_sla_report_state'),
    settingsRepository.get,
    ['moderation_sla_report_state'],
  ],
  [
    'settingsFacade.setJson',
    () => settingsFacade.setJson('attachment_last_purge', '{"purged":2}'),
    settingsRepository.set,
    ['attachment_last_purge', '{"purged":2}', 'json'],
  ],
];

describe('fachadas dos módulos: só repassam ao repository', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(CASES)('%s: mesmos argumentos, mesmo valor de volta', async (_, call, target, args) => {
    const fn = target as Mock;
    const value = { devolvido: 'pelo repository' };
    fn.mockResolvedValueOnce(value);
    await expect(call()).resolves.toBe(value);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(...args);
  });

  it('o erro do repository chega a quem chama, sem ser engolido', async () => {
    const boom = new Error('ER_LOCK_WAIT_TIMEOUT');
    vi.mocked(disputesRepository.resolve).mockRejectedValueOnce(boom);
    await expect(disputesFacade.resolve(RESOLUTION as never)).rejects.toBe(boom);
  });
});
