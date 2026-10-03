import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Repositories e provedor falsos: os testes de envio conferem o que o service pede a cada um. As
// funções puras do provedor (resultForStatus) continuam as de verdade.
const { subs, notifs, users, provider } = vi.hoisted(() => ({
  subs: {
    upsert: vi.fn(),
    remove: vi.fn(),
    belongsTo: vi.fn(),
    countForUser: vi.fn(),
    listForUser: vi.fn(),
    markSent: vi.fn(),
    removeById: vi.fn(),
    markError: vi.fn(),
    deliversWork: vi.fn(),
  },
  notifs: { countHeld: vi.fn(), markPushHeld: vi.fn() },
  users: { findById: vi.fn() },
  provider: { name: 'simulated' as const, send: vi.fn() },
}));
vi.mock('./push.repository', () => ({ pushRepository: subs }));
vi.mock('./notifications.repository', () => ({ notificationsRepository: notifs }));
vi.mock('../auth/auth.repository', () => ({ authRepository: users }));
vi.mock('./push.provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./push.provider')>()),
  activePushProvider: () => provider,
  vapidKeys: () => ({ publicKey: 'chave-publica-vapid', privateKey: 'chave-privada-vapid' }),
}));

import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { EMAILED_NOTIFICATION_TYPES } from '../mail/mail.service';
import { DEADLINE_FIRST_TYPES } from './deadline-types';
import {
  buildPayload,
  passCategoryFor,
  PUSHED_NOTIFICATION_TYPES,
  pushService,
  pushUrl,
  QUIET_PASS_BY_TYPE,
  quietSummaryPayload,
  trimBody,
} from './push.service';
import { isPushEndpointAllowed } from './push.endpoint';
import { resultForStatus } from './push.provider';

describe('avisos push (ADR 52)', () => {
  it('pushUrl leva para a tela do assunto; contratação manda em qualquer tipo', () => {
    expect(pushUrl('contract_proposal', { contractId: 42 })).toBe('/contratos/42');
    expect(pushUrl('milestone_approved', { contractId: '7' })).toBe('/contratos/7');
    expect(pushUrl('barter_proposed', null)).toBe('/trocas');
    expect(pushUrl('withdrawal_completed', {})).toBe('/carteira');
    expect(pushUrl('deposit_confirmed', undefined)).toBe('/carteira');
    expect(pushUrl('saved_search_match', { searchId: 3 })).toBe('/servicos');
    expect(pushUrl('review_received', null)).toBe('/notificacoes');
  });

  it('trimBody junta espaços e corta com reticência', () => {
    expect(trimBody('  Proposta   nova \n aceita ')).toBe('Proposta nova aceita');
    expect(trimBody(null)).toBe('');
    expect(trimBody('a'.repeat(130))).toBe(`${'a'.repeat(119)}…`);
    expect(trimBody('a'.repeat(120))).toHaveLength(120);
    expect(trimBody('12345 78901', 8)).toBe('12345 7…');
  });

  it('buildPayload monta título, corpo, destino e a etiqueta que substitui o aviso anterior', () => {
    expect(
      buildPayload({
        type: 'contract_delivered',
        title: 'Entrega registrada',
        body: '  A entrega do contrato chegou  ',
        data: { contractId: 9 },
      }),
    ).toEqual({
      title: 'Entrega registrada',
      body: 'A entrega do contrato chegou',
      url: '/contratos/9',
      tag: 'contract_delivered:9',
    });
    // A disputa é o assunto quando não há contrato no aviso.
    expect(
      buildPayload({ type: 'dispute_opened', title: 'Disputa', data: { disputeId: 4 } }).tag,
    ).toBe('dispute_opened:4');
  });

  it('cada assunto vira etiqueta (contratação, disputa, troca, busca, saque, pagamento, avaliação, remoção), e a contratação vem primeiro', () => {
    const tagOf = (data: Record<string, unknown>): string =>
      buildPayload({ type: 't', title: 'x', data, notificationId: 31 }).tag;
    expect(tagOf({ contractId: 1 })).toBe('t:1');
    expect(tagOf({ disputeId: 2 })).toBe('t:2');
    expect(tagOf({ barterId: 3 })).toBe('t:3');
    expect(tagOf({ savedSearchId: 4 })).toBe('t:4');
    expect(tagOf({ withdrawalId: 5 })).toBe('t:5');
    expect(tagOf({ paymentId: 6 })).toBe('t:6');
    expect(tagOf({ reviewId: 7 })).toBe('t:7');
    expect(tagOf({ removalId: 'r8' })).toBe('t:r8');
    // Dois assuntos no mesmo aviso: vale o primeiro da lista, não a ordem das chaves do objeto.
    expect(tagOf({ disputeId: 2, contractId: 1 })).toBe('t:1');
    expect(tagOf({ removalId: 8, barterId: 3 })).toBe('t:3');
    // Assunto nulo ou que não é número nem texto não conta; campo fora da lista também não.
    expect(tagOf({ contractId: null, disputeId: 2 })).toBe('t:2');
    expect(tagOf({ contractId: { id: 1 }, rating: 5 })).toBe('t:n31');
  });

  it('pushUrl: contratação nula ou que não é número nem texto não vira endereço de contratação', () => {
    expect(pushUrl('contract_proposal', { contractId: null })).toBe('/notificacoes');
    expect(pushUrl('barter_accepted', { contractId: { id: 1 } })).toBe('/trocas');
  });

  it('sem assunto, cada aviso fica com etiqueta própria e não apaga o anterior', () => {
    expect(
      buildPayload({ type: 'review_received', title: 'Nova avaliação', notificationId: 31 }),
    ).toEqual({
      title: 'Nova avaliação',
      body: '',
      url: '/notificacoes',
      tag: 'review_received:n31',
    });
    const primeiro = buildPayload({ type: 'review_received', title: 'A', notificationId: 31 });
    const segundo = buildPayload({ type: 'review_received', title: 'B', notificationId: 32 });
    expect(primeiro.tag).not.toBe(segundo.tag);
  });

  it('resposta do serviço de push: assinatura morta some, falha passageira fica', () => {
    expect(resultForStatus(404)).toBe('gone');
    expect(resultForStatus(410)).toBe('gone');
    // Chave VAPID trocada: o serviço recusa a assinatura, que não serve mais.
    expect(resultForStatus(401)).toBe('gone');
    expect(resultForStatus(403)).toBe('gone');
    expect(resultForStatus(429)).toBe('failed');
    expect(resultForStatus(500)).toBe('failed');
    expect(resultForStatus(undefined)).toBe('failed');
  });

  it('endpoint de push: só https de serviço conhecido quando o envio é de verdade', () => {
    const real = (e: string): boolean => isPushEndpointAllowed(e, true);
    expect(real('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(real('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
    expect(real('https://web.push.apple.com/abc')).toBe(true);
    expect(real('https://sub.notify.windows.com/abc')).toBe(true);
    // A API é quem faz a requisição: endereço interno viraria sonda de rede.
    expect(real('https://localhost/abc')).toBe(false);
    expect(real('https://10.0.0.5/abc')).toBe(false);
    expect(real('http://fcm.googleapis.com/abc')).toBe(false);
    expect(real('https://fcm.googleapis.com.invasor.test/abc')).toBe(false);
    expect(real('nada')).toBe(false);
    // Com o provedor simulado nada sai da máquina: basta ser https e não apontar para um IP.
    expect(isPushEndpointAllowed('https://push.escambo.test/abc', false)).toBe(true);
    expect(isPushEndpointAllowed('https://127.0.0.1/abc', false)).toBe(false);
    expect(isPushEndpointAllowed('https://[::1]/abc', false)).toBe(false);
  });

  it('com o canal desligado não há chave pública: a tela explica em vez de oferecer', () => {
    // vitest.config.ts fixa PUSH_PROVIDER='off' nos testes de unidade.
    expect(pushService.publicKey()).toBe('');
  });

  it('os tipos que batem no aparelho são os mesmos do e-mail, sem o ruído do chat', () => {
    expect(PUSHED_NOTIFICATION_TYPES.has('contract_proposal')).toBe(true);
    expect(PUSHED_NOTIFICATION_TYPES.has('dispute_opened')).toBe(true);
    expect(PUSHED_NOTIFICATION_TYPES.has('message_received')).toBe(false);
  });
});

/** O que pode sair durante o silêncio (ADR 56): todos os tipos classificados, e o par conferido. */
describe('o que sai no silêncio (ADR 56)', () => {
  it('o mapa classifica todos os tipos que viram push, nem um a mais', () => {
    expect(Object.keys(QUIET_PASS_BY_TYPE).sort()).toEqual([...PUSHED_NOTIFICATION_TYPES].sort());
  });

  it('só o aviso de atraso pode sair, pela categoria de prazo (ADR 57 estreitou o ADR 56)', () => {
    const podem = Object.entries(QUIET_PASS_BY_TYPE).filter(([, c]) => c !== null);
    expect(podem).toEqual([['contract_overdue', 'deadline']]);
    // a recusa e a expiração do pedido dão pelo menos 6 h de dia; a revisão não tem carência
    expect(QUIET_PASS_BY_TYPE.deadline_extension_declined).toBeNull();
    expect(QUIET_PASS_BY_TYPE.deadline_extension_expired).toBeNull();
    expect(QUIET_PASS_BY_TYPE.contract_revision).toBeNull();
    expect(passCategoryFor('deadline_extension_declined', 'deadline')).toBeNull();
  });

  it('o mapa tem exatamente as chaves do conjunto do e-mail, e o push usa o mesmo conjunto', () => {
    expect(PUSHED_NOTIFICATION_TYPES).toBe(EMAILED_NOTIFICATION_TYPES);
    expect(Object.keys(QUIET_PASS_BY_TYPE).sort()).toEqual([...EMAILED_NOTIFICATION_TYPES].sort());
  });

  it.each([
    'contract_proposal_reminder',
    'contract_deadline_reminder',
    'contract_approval_reminder',
    'contract_extension_reminder',
    'contract_revision_stalled',
    'contract_auto_approved',
  ])(
    '%s (ADR 58) vira push e espera o fim da janela: null no mapa, nenhuma categoria vale',
    (type) => {
      expect(PUSHED_NOTIFICATION_TYPES.has(type)).toBe(true);
      expect(Object.hasOwn(QUIET_PASS_BY_TYPE, type)).toBe(true);
      expect(QUIET_PASS_BY_TYPE[type]).toBeNull();
      expect(passCategoryFor(type, 'deadline')).toBeNull();
    },
  );

  it('passCategoryFor aceita só o par do mapa', () => {
    expect(passCategoryFor('contract_overdue', 'deadline')).toBe('deadline');
    expect(passCategoryFor('contract_proposal', 'deadline')).toBeNull();
    expect(passCategoryFor('message_received', 'deadline')).toBeNull();
    for (const t of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(passCategoryFor(t, 'deadline')).toBeNull();
    }
    expect(passCategoryFor('contract_overdue', null)).toBeNull();
    expect(passCategoryFor('contract_overdue', undefined)).toBeNull();
  });

  it('etiqueta própria: tipo:alvo:nID; sem assunto, tipo:nID; sem a opção, igual a antes', () => {
    const p = { type: 'deadline_extension_declined', title: 't', data: { contractId: 3 } };
    expect(buildPayload({ ...p, notificationId: 41 }, { ownTag: true }).tag).toBe(
      'deadline_extension_declined:3:n41',
    );
    expect(buildPayload({ ...p, notificationId: 42 }, { ownTag: true }).tag).toBe(
      'deadline_extension_declined:3:n42',
    );
    expect(buildPayload({ ...p, notificationId: 41 }).tag).toBe('deadline_extension_declined:3');
    expect(
      buildPayload({ type: 'contract_overdue', title: 't', notificationId: 5 }, { ownTag: true })
        .tag,
    ).toBe('contract_overdue:n5');
  });

  it('o resumo do fim do silêncio põe primeiro os lembretes e o pedido de extensão (ADR 58); revisão parada e aprovação automática ficam na ordem de chegada', () => {
    const p = quietSummaryPayload([
      { title: 'Aprovada automaticamente: Site', type: 'contract_auto_approved' },
      { title: 'Revisão parada: Vídeo', type: 'contract_revision_stalled' },
      { title: 'Lembrete: entrega do Logo', type: 'contract_deadline_reminder' },
      { title: 'Pedido de extensão: Site', type: 'deadline_extension_requested' },
    ]);
    expect(p.body).toBe(
      '4 avisos ficaram por ver: Lembrete: entrega do Logo · Pedido de extensão: Site · Aprovada automaticamente: Site',
    );
  });

  it.each([...DEADLINE_FIRST_TYPES])(
    '%s vem antes de um aviso comum no resumo do silêncio',
    (type) => {
      expect(
        quietSummaryPayload([
          { title: 'Nova proposta', type: 'contract_proposal' },
          { title: 'Hora-limite', type },
        ]).body,
      ).toBe('2 avisos ficaram por ver: Hora-limite · Nova proposta');
    },
  );

  it.each(['contract_revision_stalled', 'contract_auto_approved', 'contract_delivered'])(
    '%s não passa à frente: fica na ordem de chegada',
    (type) => {
      expect(
        quietSummaryPayload([
          { title: 'Nova proposta', type: 'contract_proposal' },
          { title: 'Outro', type },
        ]).body,
      ).toBe('2 avisos ficaram por ver: Nova proposta · Outro');
    },
  );
});

/** Assinaturas por aparelho e o envio para todos eles (ADR 52), com repositories e provedor falsos. */
describe('pushService: assinaturas e envio (ADR 52)', () => {
  const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/aparelho-1';
  const payload = { title: 'Proposta', body: 'x', url: '/contratos/3', tag: 'contract_proposal:3' };
  const device = (id: number) => ({
    id,
    user_id: 7,
    endpoint: `https://push.escambo.test/${id}`,
    p256dh: `p${id}`,
    auth_key: `a${id}`,
  });
  const target = (id: number) => ({
    endpoint: `https://push.escambo.test/${id}`,
    p256dh: `p${id}`,
    auth: `a${id}`,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    env.PUSH_PROVIDER = 'simulated';
  });
  afterEach(() => {
    // vitest.config.ts fixa 'off' nos testes de unidade.
    env.PUSH_PROVIDER = 'off';
    vi.restoreAllMocks();
  });

  it('com o canal ligado, a chave pública é a do par VAPID (nunca a privada)', () => {
    expect(pushService.publicKey()).toBe('chave-publica-vapid');
  });

  it('subscribe grava a assinatura do aparelho na conta de quem pediu', async () => {
    await pushService.subscribe(7, { endpoint: ENDPOINT, p256dh: 'chave', auth: 'segredo' });

    expect(subs.upsert).toHaveBeenCalledTimes(1);
    expect(subs.upsert).toHaveBeenCalledWith({
      userId: 7,
      endpoint: ENDPOINT,
      p256dh: 'chave',
      auth: 'segredo',
    });
  });

  it('unsubscribe só remove o aparelho da própria conta e diz se havia o que remover', async () => {
    subs.remove.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    expect(await pushService.unsubscribe(7, ENDPOINT)).toBe(true);
    expect(await pushService.unsubscribe(8, ENDPOINT)).toBe(false);

    expect(subs.remove).toHaveBeenNthCalledWith(1, 7, ENDPOINT);
    expect(subs.remove).toHaveBeenNthCalledWith(2, 8, ENDPOINT);
  });

  it('as consultas da tela (este aparelho, quantos aparelhos, retidos, quem entrega trabalho) são sempre da conta pedida', async () => {
    subs.belongsTo.mockResolvedValue(true);
    subs.countForUser.mockResolvedValue(2);
    notifs.countHeld.mockResolvedValue(3);
    subs.deliversWork.mockResolvedValue(false);

    expect(await pushService.subscribed(7, ENDPOINT)).toBe(true);
    expect(await pushService.devices(7)).toBe(2);
    expect(await pushService.held(7)).toBe(3);
    expect(await pushService.deliversWork(7)).toBe(false);

    expect(subs.belongsTo).toHaveBeenCalledWith(7, ENDPOINT);
    expect(subs.countForUser).toHaveBeenCalledWith(7);
    expect(notifs.countHeld).toHaveBeenCalledWith(7);
    expect(subs.deliversWork).toHaveBeenCalledWith(7);
  });

  describe('send', () => {
    it('envia para cada aparelho da conta: o entregue ganha a marca, o morto é apagado e a falha fica anotada', async () => {
      subs.listForUser.mockResolvedValue([device(1), device(2), device(3)]);
      provider.send
        .mockResolvedValueOnce('sent')
        .mockResolvedValueOnce('gone')
        .mockResolvedValueOnce('failed');
      const opts = { ttlSeconds: 600, urgency: 'high' as const };

      const result = await pushService.send(7, payload, opts);

      expect(result).toEqual({ sent: 1, removed: 1, failed: 1 });
      expect(subs.listForUser).toHaveBeenCalledWith(7);
      expect(provider.send.mock.calls).toEqual([
        [target(1), payload, opts],
        [target(2), payload, opts],
        [target(3), payload, opts],
      ]);
      expect(subs.markSent.mock.calls).toEqual([[1]]);
      expect(subs.removeById.mock.calls).toEqual([[2]]);
      expect(subs.markError.mock.calls).toEqual([[3, 'provedor simulated']]);
    });

    it('sem opções, o provedor recebe opções vazias (o TTL padrão é dele)', async () => {
      subs.listForUser.mockResolvedValue([device(1)]);
      provider.send.mockResolvedValue('sent');

      expect(await pushService.send(7, payload)).toEqual({ sent: 1, removed: 0, failed: 0 });

      expect(provider.send.mock.calls[0]![2]).toStrictEqual({});
    });

    it('conta sem aparelho: nada sai e nada é marcado', async () => {
      subs.listForUser.mockResolvedValue([]);

      expect(await pushService.send(7, payload)).toEqual({ sent: 0, removed: 0, failed: 0 });

      expect(provider.send).not.toHaveBeenCalled();
      expect(subs.markSent).not.toHaveBeenCalled();
      expect(subs.removeById).not.toHaveBeenCalled();
      expect(subs.markError).not.toHaveBeenCalled();
    });

    it('com o canal desligado, nem consulta os aparelhos', async () => {
      env.PUSH_PROVIDER = 'off';

      expect(await pushService.send(7, payload)).toEqual({ sent: 0, removed: 0, failed: 0 });

      expect(subs.listForUser).not.toHaveBeenCalled();
      expect(provider.send).not.toHaveBeenCalled();
    });
  });

  describe('notify (melhor esforço)', () => {
    const notice = {
      type: 'contract_proposal',
      title: 'Proposta',
      body: 'x',
      data: { contractId: 3 },
      notificationId: 41,
    };
    const account = (over: Record<string, unknown> = {}) => ({
      id: 7,
      deleted_at: null,
      timezone: 'America/Sao_Paulo',
      push_quiet_start: null,
      push_quiet_end: null,
      push_quiet_pass: null,
      ...over,
    });
    const noon = new Date('2026-09-15T15:00:00Z'); // 12:00 em Brasília

    it('nunca lança: se a consulta da conta falha, quem notificou segue e o log registra o tipo', async () => {
      const warn = vi.spyOn(logger, 'warn');
      const down = new Error('banco fora');
      users.findById.mockRejectedValue(down);

      await expect(pushService.notify(7, notice)).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith(
        { err: down, type: 'contract_proposal' },
        'push da notificação falhou',
      );
      expect(provider.send).not.toHaveBeenCalled();
    });

    it('falha no envio (provedor fora) também não derruba quem notificou', async () => {
      users.findById.mockResolvedValue(account());
      subs.listForUser.mockResolvedValue([device(1)]);
      const warn = vi.spyOn(logger, 'warn');
      const offline = new Error('provedor fora');
      provider.send.mockRejectedValue(offline);

      await expect(pushService.notify(7, notice, noon)).resolves.toBeUndefined();

      expect(provider.send.mock.calls).toEqual([
        [
          target(1),
          { title: 'Proposta', body: 'x', url: '/contratos/3', tag: 'contract_proposal:3' },
          { ttlSeconds: 12 * 3600 },
        ],
      ]);
      expect(subs.markSent).not.toHaveBeenCalled();
      expect(subs.markError).not.toHaveBeenCalled();
      expect(subs.removeById).not.toHaveBeenCalled();
      expect(warn.mock.calls).toEqual([
        [{ err: offline, type: 'contract_proposal' }, 'push da notificação falhou'],
      ]);
    });

    it('falha ao anotar a entrega (banco fora depois do envio) também fica só no log de quem notificou', async () => {
      users.findById.mockResolvedValue(account());
      subs.listForUser.mockResolvedValue([device(1)]);
      provider.send.mockResolvedValue('sent');
      const warn = vi.spyOn(logger, 'warn');
      const down = new Error('banco fora');
      subs.markSent.mockRejectedValueOnce(down);

      await expect(pushService.notify(7, notice, noon)).resolves.toBeUndefined();

      expect(subs.markSent.mock.calls).toEqual([[1]]);
      expect(warn.mock.calls).toEqual([
        [{ err: down, type: 'contract_proposal' }, 'push da notificação falhou'],
      ]);
    });

    it('falha ao marcar o aviso como retido não derruba quem notificou, e nada sai no silêncio', async () => {
      const night = new Date('2026-09-15T01:00:00Z'); // 22:00 em Brasília
      users.findById.mockResolvedValue(account({ push_quiet_start: 22, push_quiet_end: 7 }));
      const warn = vi.spyOn(logger, 'warn');
      const down = new Error('banco fora');
      notifs.markPushHeld.mockRejectedValueOnce(down);

      await expect(pushService.notify(7, notice, night)).resolves.toBeUndefined();

      expect(notifs.markPushHeld.mock.calls).toEqual([[41, night]]);
      expect(subs.listForUser).not.toHaveBeenCalled();
      expect(provider.send).not.toHaveBeenCalled();
      expect(warn.mock.calls).toEqual([
        [{ err: down, type: 'contract_proposal' }, 'push da notificação falhou'],
      ]);
    });

    it('com o canal desligado, notify nem consulta a conta nem os aparelhos', async () => {
      env.PUSH_PROVIDER = 'off';

      await expect(pushService.notify(7, notice, noon)).resolves.toBeUndefined();

      expect(users.findById).not.toHaveBeenCalled();
      expect(subs.listForUser).not.toHaveBeenCalled();
      expect(notifs.markPushHeld).not.toHaveBeenCalled();
    });

    it('conta encerrada não recebe aviso, mesmo fora do silêncio e com aparelho ligado', async () => {
      users.findById.mockResolvedValue(account({ deleted_at: new Date('2026-09-01T00:00:00Z') }));
      subs.listForUser.mockResolvedValue([device(1)]);

      await pushService.notify(7, notice, noon);

      expect(users.findById).toHaveBeenCalledWith(7);
      expect(subs.listForUser).not.toHaveBeenCalled();
      expect(provider.send).not.toHaveBeenCalled();
    });

    it('dentro do silêncio, o aviso fica marcado como retido naquela notificação, com a hora do evento, e nada sai (ADR 54)', async () => {
      const night = new Date('2026-09-15T01:00:00Z'); // 22:00 em Brasília
      users.findById.mockResolvedValue(account({ push_quiet_start: 22, push_quiet_end: 7 }));

      await pushService.notify(7, notice, night);

      expect(notifs.markPushHeld.mock.calls).toEqual([[41, night]]);
      expect(subs.listForUser).not.toHaveBeenCalled();
      expect(provider.send).not.toHaveBeenCalled();
    });

    it('aparelho que o serviço de push diz que morreu é apagado também no caminho do aviso comum', async () => {
      users.findById.mockResolvedValue(account());
      subs.listForUser.mockResolvedValue([device(1), device(2)]);
      provider.send.mockResolvedValueOnce('gone').mockResolvedValueOnce('sent');

      await pushService.notify(7, notice, noon);

      expect(subs.removeById.mock.calls).toEqual([[1]]);
      expect(subs.markSent.mock.calls).toEqual([[2]]);
      expect(subs.markError).not.toHaveBeenCalled();
    });

    it('conta que não existe mais não recebe aviso nem consulta de aparelhos', async () => {
      users.findById.mockResolvedValue(undefined);

      await pushService.notify(7, notice, noon);

      expect(users.findById).toHaveBeenCalledWith(7);
      expect(subs.listForUser).not.toHaveBeenCalled();
      expect(notifs.markPushHeld).not.toHaveBeenCalled();
    });

    it('tipo que não vira push (chat) nem consulta a conta', async () => {
      await pushService.notify(7, { ...notice, type: 'message_received' }, noon);

      expect(users.findById).not.toHaveBeenCalled();
      expect(provider.send).not.toHaveBeenCalled();
    });

    it('fora do silêncio, sai para os aparelhos da conta com o aviso montado e o TTL', async () => {
      users.findById.mockResolvedValue(account());
      subs.listForUser.mockResolvedValue([device(1)]);
      provider.send.mockResolvedValue('sent');

      await pushService.notify(7, notice, noon);

      expect(subs.listForUser).toHaveBeenCalledWith(7);
      expect(provider.send).toHaveBeenCalledTimes(1);
      expect(provider.send).toHaveBeenCalledWith(
        target(1),
        { title: 'Proposta', body: 'x', url: '/contratos/3', tag: 'contract_proposal:3' },
        { ttlSeconds: 12 * 3600 },
      );
      expect(subs.markSent).toHaveBeenCalledWith(1);
      expect(notifs.markPushHeld).not.toHaveBeenCalled();
    });

    it('etiqueta própria no caminho normal (lembretes, ADR 58): fora do silêncio sai com tipo:alvo:nID, sem prioridade alta', async () => {
      users.findById.mockResolvedValue(account());
      subs.listForUser.mockResolvedValue([device(1)]);
      provider.send.mockResolvedValue('sent');
      const lembrete = {
        type: 'contract_deadline_reminder',
        title: 'Lembrete: Logo',
        body: 'Entregue até sex, 02/10/2026, até 23:59.',
        data: { contractId: 3 },
        notificationId: 41,
      };

      await pushService.notify(7, { ...lembrete, ownTag: true }, noon);
      // Sem a opção (ou com false), a etiqueta é a do assunto: substitui o aviso anterior.
      await pushService.notify(7, { ...lembrete, notificationId: 42, ownTag: false }, noon);
      await pushService.notify(7, { ...lembrete, notificationId: 43 }, noon);

      expect(provider.send.mock.calls).toEqual([
        [
          target(1),
          {
            title: 'Lembrete: Logo',
            body: 'Entregue até sex, 02/10/2026, até 23:59.',
            url: '/contratos/3',
            tag: 'contract_deadline_reminder:3:n41',
          },
          { ttlSeconds: 12 * 3600 },
        ],
        [
          target(1),
          {
            title: 'Lembrete: Logo',
            body: 'Entregue até sex, 02/10/2026, até 23:59.',
            url: '/contratos/3',
            tag: 'contract_deadline_reminder:3',
          },
          { ttlSeconds: 12 * 3600 },
        ],
        [
          target(1),
          {
            title: 'Lembrete: Logo',
            body: 'Entregue até sex, 02/10/2026, até 23:59.',
            url: '/contratos/3',
            tag: 'contract_deadline_reminder:3',
          },
          { ttlSeconds: 12 * 3600 },
        ],
      ]);
      for (const call of provider.send.mock.calls) {
        expect(call[2]).toStrictEqual({ ttlSeconds: 12 * 3600 });
      }
      expect(notifs.markPushHeld).not.toHaveBeenCalled();
    });

    it('lembrete com etiqueta própria dentro do silêncio fica retido, mesmo para quem libera o prazo', async () => {
      const night = new Date('2026-09-15T01:00:00Z'); // 22:00 em Brasília
      users.findById.mockResolvedValue(
        account({ push_quiet_start: 22, push_quiet_end: 7, push_quiet_pass: 'deadline' }),
      );

      await pushService.notify(
        7,
        {
          type: 'contract_deadline_reminder',
          title: 'Lembrete: Logo',
          data: { contractId: 3 },
          notificationId: 41,
          ownTag: true,
        },
        night,
      );

      expect(notifs.markPushHeld.mock.calls).toEqual([[41, night]]);
      expect(subs.listForUser).not.toHaveBeenCalled();
      expect(provider.send).not.toHaveBeenCalled();
    });

    it('lembrete que chega afirmando a categoria do prazo não fura o silêncio: o par não está no mapa, vai para o log e o aviso fica retido', async () => {
      const night = new Date('2026-09-15T01:00:00Z'); // 22:00 em Brasília
      users.findById.mockResolvedValue(
        account({ push_quiet_start: 22, push_quiet_end: 7, push_quiet_pass: 'deadline' }),
      );
      const warn = vi.spyOn(logger, 'warn');

      for (const [i, type] of [
        'contract_proposal_reminder',
        'contract_deadline_reminder',
        'contract_approval_reminder',
        'contract_extension_reminder',
        'contract_revision_stalled',
        'contract_auto_approved',
      ].entries()) {
        await pushService.notify(
          7,
          {
            type,
            title: 'Aviso',
            data: { contractId: 3 },
            notificationId: 60 + i,
            passCategory: 'deadline',
            ownTag: true,
          },
          night,
        );
      }

      expect(notifs.markPushHeld.mock.calls).toEqual([
        [60, night],
        [61, night],
        [62, night],
        [63, night],
        [64, night],
        [65, night],
      ]);
      expect(provider.send).not.toHaveBeenCalled();
      expect(warn.mock.calls.map((c) => c[0])).toEqual([
        { type: 'contract_proposal_reminder', passCategory: 'deadline' },
        { type: 'contract_deadline_reminder', passCategory: 'deadline' },
        { type: 'contract_approval_reminder', passCategory: 'deadline' },
        { type: 'contract_extension_reminder', passCategory: 'deadline' },
        { type: 'contract_revision_stalled', passCategory: 'deadline' },
        { type: 'contract_auto_approved', passCategory: 'deadline' },
      ]);
      for (const call of warn.mock.calls) {
        expect(call[1]).toBe(
          'categoria fora da lista do ADR 56 para este tipo: vai como aviso comum',
        );
      }
    });

    it('dentro do silêncio, aviso sem notificação in-app (sem id) fica retido sem marcar nada', async () => {
      users.findById.mockResolvedValue(account({ push_quiet_start: 22, push_quiet_end: 7 }));

      await pushService.notify(
        7,
        { type: 'contract_proposal', title: 'Proposta' },
        new Date('2026-09-15T01:00:00Z'), // 22:00 em Brasília
      );

      expect(notifs.markPushHeld).not.toHaveBeenCalled();
      expect(subs.listForUser).not.toHaveBeenCalled();
    });

    it('categoria afirmada que não é a do tipo fica no log e o aviso segue como comum (ADR 56)', async () => {
      const warn = vi.spyOn(logger, 'warn');
      users.findById.mockResolvedValue(account({ push_quiet_pass: 'deadline' }));
      subs.listForUser.mockResolvedValue([device(1)]);
      provider.send.mockResolvedValue('sent');

      await pushService.notify(7, { ...notice, passCategory: 'deadline' }, noon);

      expect(warn).toHaveBeenCalledWith(
        { type: 'contract_proposal', passCategory: 'deadline' },
        'categoria fora da lista do ADR 56 para este tipo: vai como aviso comum',
      );
      // Aviso comum: sem prioridade alta e com a etiqueta de sempre.
      expect(provider.send.mock.calls[0]![1]).toMatchObject({ tag: 'contract_proposal:3' });
      expect(provider.send.mock.calls[0]![2]).toStrictEqual({ ttlSeconds: 12 * 3600 });
    });

    it('o aviso no log é só para o par errado: sem categoria, ou com a categoria do próprio tipo, nada é registrado', async () => {
      const warn = vi.spyOn(logger, 'warn');
      users.findById.mockResolvedValue(account({ push_quiet_pass: 'deadline' }));
      subs.listForUser.mockResolvedValue([device(1)]);
      provider.send.mockResolvedValue('sent');

      // Aviso comum, sem categoria afirmada.
      await pushService.notify(7, notice, noon);
      // Prazo estourado com a categoria que o mapa dá a ele (ADR 56).
      await pushService.notify(
        7,
        { ...notice, type: 'contract_overdue', passCategory: 'deadline' },
        noon,
      );

      expect(warn).not.toHaveBeenCalled();
      expect(provider.send.mock.calls.map((c) => (c[1] as { tag: string }).tag)).toEqual([
        'contract_proposal:3',
        // Fora da janela não é "sair no silêncio": a etiqueta é a de sempre, sem prioridade alta.
        'contract_overdue:3',
      ]);
      expect(provider.send.mock.calls[1]![2]).toStrictEqual({ ttlSeconds: 12 * 3600 });
    });
  });

  describe('sendTest', () => {
    it('manda o aviso de teste, com texto e etiqueta próprios, só para os aparelhos da conta', async () => {
      users.findById.mockResolvedValue(undefined);
      subs.listForUser.mockResolvedValue([device(1)]);
      provider.send.mockResolvedValue('sent');

      const result = await pushService.sendTest(7, new Date('2026-09-15T15:00:00Z'));

      expect(result).toEqual({ sent: 1, removed: 0, failed: 0 });
      expect(users.findById).toHaveBeenCalledWith(7);
      expect(subs.listForUser).toHaveBeenCalledWith(7);
      expect(provider.send).toHaveBeenCalledWith(
        target(1),
        {
          title: 'Tudo certo!',
          body: 'É assim que os avisos do Escambo vão chegar neste aparelho.',
          url: '/notificacoes',
          tag: 'push_test:n0',
        },
        // Sem janela de silêncio (aqui, nem conta carregada), vale o teto de 12 horas.
        { ttlSeconds: 12 * 3600 },
      );
    });

    const quietAccount = {
      id: 7,
      deleted_at: null,
      timezone: 'America/Sao_Paulo',
      push_quiet_start: 22,
      push_quiet_end: 7,
      push_quiet_pass: null,
    };

    it('fura o silêncio de propósito: dentro da janela sai do mesmo jeito, sem marcar retido e sem prioridade alta (ADR 54)', async () => {
      users.findById.mockResolvedValue(quietAccount);
      subs.listForUser.mockResolvedValue([device(1)]);
      provider.send.mockResolvedValue('sent');

      // 23:00 em Brasília: dentro da janela 22→7.
      const result = await pushService.sendTest(7, new Date('2026-09-15T02:00:00Z'));

      expect(result).toEqual({ sent: 1, removed: 0, failed: 0 });
      expect(notifs.markPushHeld).not.toHaveBeenCalled();
      expect(provider.send).toHaveBeenCalledTimes(1);
      // O próximo início da janela é só amanhã às 22:00 (23 h): vale o teto de 12 horas, e a
      // chave da prioridade nem vai.
      expect(provider.send.mock.calls[0]![2]).toStrictEqual({ ttlSeconds: 12 * 3600 });
      expect(subs.markSent).toHaveBeenCalledWith(1);
    });

    it('a 5 minutos do silêncio, o TTL do teste fica no piso de 15 minutos', async () => {
      users.findById.mockResolvedValue(quietAccount);
      subs.listForUser.mockResolvedValue([device(1)]);
      provider.send.mockResolvedValue('sent');

      await pushService.sendTest(7, new Date('2026-09-15T00:55:00Z')); // 21:55 em Brasília

      expect(provider.send.mock.calls[0]![2]).toStrictEqual({ ttlSeconds: 15 * 60 });
    });

    it('falha ao listar os aparelhos sobe para a rota: o teste é um pedido da pessoa, não melhor esforço', async () => {
      const down = new Error('banco fora');
      users.findById.mockResolvedValue(undefined);
      subs.listForUser.mockRejectedValue(down);

      await expect(pushService.sendTest(7)).rejects.toBe(down);

      expect(provider.send).not.toHaveBeenCalled();
    });
  });
});
