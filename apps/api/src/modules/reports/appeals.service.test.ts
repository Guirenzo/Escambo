import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./content-removals.repository', () => ({
  contentRemovalsRepository: {
    findById: vi.fn(),
    listForOwner: vi.fn(),
    appeal: vi.fn(),
    uphold: vi.fn(),
    overturn: vi.fn(),
    overturnContent: vi.fn(),
    markFilePurged: vi.fn(),
    listQuarantineToPurge: vi.fn(),
    listAppeals: vi.fn(),
    listQuarantinedForOwner: vi.fn(),
  },
}));
vi.mock('./moderation.strikes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./moderation.strikes')>()),
  strikePolicy: vi.fn(),
  strikeSummary: vi.fn(),
}));
vi.mock('../media/media.storage', () => ({
  deleteQuarantined: vi.fn(),
  quarantineFilePath: vi.fn(),
  restoreQuarantined: vi.fn(),
}));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify: vi.fn() },
}));
vi.mock('../messaging/messaging.service', () => ({
  messagingService: { announceChange: vi.fn().mockResolvedValue(undefined) },
}));

import { deleteQuarantined, quarantineFilePath, restoreQuarantined } from '../media/media.storage';
import { messagingService } from '../messaging/messaging.service';
import { notificationsService } from '../notifications/notifications.service';
import { appealsService, removalLabel } from './appeals.service';
import { contentRemovalsRepository } from './content-removals.repository';
import { strikePolicy, strikeSummary } from './moderation.strikes';

const repo = vi.mocked(contentRemovalsRepository);
const policy = vi.mocked(strikePolicy);
const summary = vi.mocked(strikeSummary);
const notify = vi.mocked(notificationsService.notify);
const restore = vi.mocked(restoreQuarantined);
const removeFile = vi.mocked(deleteQuarantined);
const filePath = vi.mocked(quarantineFilePath);
const announce = vi.mocked(messagingService.announceChange);

const MEDIA = '/api/media/2026/09/01J8ZQ4K7M3VX5R2T9W6Y1B0CD.webp';
const NOW = new Date('2026-09-20T12:00:00Z');

const removal = (o: Record<string, unknown> = {}) =>
  ({
    id: 31,
    report_id: 4,
    owner_id: 9,
    target_type: 'avatar',
    target_id: 9,
    image_url: MEDIA,
    content_snapshot: null,
    reason: 'offensive',
    note: 'Imagem ofensiva.',
    cleared_refs: [{ table: 'profiles_freelancer', id: 2 }],
    quarantine_file: '31.webp',
    blocklist_id: 7,
    removed_by: 1,
    removed_at: new Date('2026-09-15T12:00:00Z'),
    status: 'removed',
    appeal_text: null,
    appealed_at: null,
    decided_by: null,
    decided_at: null,
    decision_note: null,
    file_purged_at: null,
    work_title: null,
    ...o,
  }) as never;

beforeEach(() => {
  vi.resetAllMocks();
  policy.mockResolvedValue({
    appealWindowDays: 14,
    windowDays: 180,
    blockDays: 7,
    reviewThreshold: 3,
  });
  summary.mockResolvedValue({
    strikes: 1,
    imageStrikes: 1,
    windowDays: 180,
    reviewThreshold: 3,
    uploadsBlockedUntil: null,
  });
  repo.appeal.mockResolvedValue(true);
  repo.uphold.mockResolvedValue(true);
  repo.overturn.mockResolvedValue({ decided: true, restored: 1 });
  restore.mockResolvedValue(true);
  removeFile.mockResolvedValue(true);
  notify.mockResolvedValue(undefined);
  announce.mockResolvedValue(undefined);
});

describe('contestação de remoção de imagem (ADR 41)', () => {
  it('o dono vê as remoções com prazo; só contesta a sua, uma vez e dentro do prazo', async () => {
    repo.listForOwner.mockResolvedValue([
      removal(),
      removal({ id: 30, removed_at: new Date('2026-09-01T12:00:00Z') }),
    ]);
    const mine = await appealsService.mine(9, NOW);
    expect(mine.removals.map((r) => [r.id, r.canAppeal, r.appealDeadline])).toEqual([
      [31, true, '2026-09-29T12:00:00.000Z'],
      [30, false, '2026-09-15T12:00:00.000Z'],
    ]);
    expect(mine.removals[0]).toMatchObject({ label: 'Foto de perfil', reason: 'offensive' });
    expect(mine.strikes.strikes).toBe(1);

    repo.findById.mockResolvedValueOnce(removal({ owner_id: 99 }));
    await expect(appealsService.appeal(9, 31, 'texto', NOW)).rejects.toMatchObject({
      statusCode: 404,
    });
    repo.findById.mockResolvedValueOnce(removal({ status: 'appealed' }));
    await expect(appealsService.appeal(9, 31, 'texto', NOW)).rejects.toMatchObject({
      statusCode: 409,
      code: 'appeal_exists',
    });
    repo.findById.mockResolvedValueOnce(removal({ removed_at: new Date('2026-09-01T12:00:00Z') }));
    await expect(appealsService.appeal(9, 31, 'texto', NOW)).rejects.toMatchObject({
      statusCode: 410,
      code: 'appeal_window_closed',
    });
    expect(repo.appeal).not.toHaveBeenCalled();

    repo.findById
      .mockResolvedValueOnce(removal())
      .mockResolvedValueOnce(removal({ status: 'appealed', appeal_text: 'É a minha foto.' }));
    const appealed = await appealsService.appeal(9, 31, 'É a minha foto.', NOW);
    expect(repo.appeal).toHaveBeenCalledWith(31, 9, 'É a minha foto.');
    expect(appealed).toMatchObject({
      status: 'appealed',
      canAppeal: false,
      appealText: 'É a minha foto.',
    });
  });

  it('manter apaga o arquivo da quarentena e avisa o dono', async () => {
    repo.findById.mockResolvedValue(removal({ status: 'appealed' }));
    const r = await appealsService.decide(1, 31, 'uphold', 'Continua ofensiva.');
    expect(repo.uphold).toHaveBeenCalledWith(31, 1, 'Continua ofensiva.');
    expect(removeFile).toHaveBeenCalledWith('31.webp');
    expect(repo.markFilePurged).toHaveBeenCalledWith(31);
    expect(notify).toHaveBeenCalledWith(9, {
      type: 'appeal_decided',
      title: 'Contestação analisada: a remoção foi mantida',
      body: 'Foto de perfil continua fora do ar. Continua ofensiva.',
      data: { removalId: 31, decision: 'upheld' },
    });
    expect(r).toEqual({
      status: 'upheld',
      restoredReferences: 0,
      imageRestored: false,
      contentRestored: false,
      fileDeleted: true,
    });
  });

  it('reverter devolve o arquivo antes, recoloca a imagem e tira do bloqueio', async () => {
    repo.findById.mockResolvedValue(removal({ status: 'appealed' }));
    const r = await appealsService.decide(1, 31, 'overturn', 'Foto legítima.');
    expect(restore).toHaveBeenCalledWith('31.webp', '2026/09/01J8ZQ4K7M3VX5R2T9W6Y1B0CD.webp');
    // O arquivo volta ANTES de a imagem ser recolocada: a referência nunca aponta para o vazio.
    expect(restore.mock.invocationCallOrder[0]!).toBeLessThan(
      repo.overturn.mock.invocationCallOrder[0]!,
    );
    expect(repo.overturn).toHaveBeenCalledTimes(1);
    expect(repo.overturn).toHaveBeenCalledWith({
      id: 31,
      adminId: 1,
      note: 'Foto legítima.',
      url: MEDIA,
      refs: [{ table: 'profiles_freelancer', id: 2 }],
      blocklistId: 7,
      restoreRefs: true,
      fileBack: true,
    });
    expect(notify).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        title: 'Contestação aceita: sua imagem voltou',
        body: 'Foto de perfil voltou ao seu perfil e a remoção deixou de contar como ocorrência. Foto legítima.',
      }),
    );
    expect(r).toEqual({
      status: 'overturned',
      restoredReferences: 1,
      imageRestored: true,
      contentRestored: true,
      fileDeleted: false,
    });
  });

  it('reverter sem arquivo não recoloca referência quebrada; decisão fora de hora é 409', async () => {
    repo.findById.mockResolvedValueOnce(
      removal({ status: 'appealed', file_purged_at: new Date() }),
    );
    repo.overturn.mockResolvedValueOnce({ decided: true, restored: 0 });
    const r = await appealsService.decide(1, 31, 'overturn', null);
    expect(restore).not.toHaveBeenCalled();
    expect(repo.overturn).toHaveBeenCalledWith(
      expect.objectContaining({ restoreRefs: false, fileBack: false }),
    );
    expect(notify).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        title: 'Contestação aceita',
        body: 'A remoção foi revertida e deixou de contar como ocorrência. A imagem não pôde ser recuperada; envie de novo pelo perfil.',
      }),
    );
    expect(r.imageRestored).toBe(false);

    repo.findById.mockResolvedValueOnce(removal({ status: 'upheld' }));
    await expect(appealsService.decide(1, 31, 'overturn', null)).rejects.toMatchObject({
      statusCode: 409,
      code: 'appeal_not_pending',
    });
  });

  it('expurgo da quarentena usa o prazo de contestação', async () => {
    repo.listQuarantineToPurge.mockResolvedValue([
      removal(),
      removal({ id: 32, quarantine_file: '32.png' }),
    ]);
    expect(await appealsService.purgeQuarantine(NOW)).toBe(2);
    expect(repo.listQuarantineToPurge).toHaveBeenCalledWith(new Date('2026-09-06T12:00:00Z'), 500);
    expect(removeFile).toHaveBeenCalledWith('32.png');
    expect(repo.markFilePurged).toHaveBeenCalledTimes(2);
  });

  it('mensagem: reverter devolve ao chat e avisa a sala e o autor, sem mexer em arquivo (ADR 44)', async () => {
    repo.findById.mockResolvedValue(
      removal({
        status: 'appealed',
        target_type: 'message',
        target_id: 55,
        image_url: null,
        content_snapshot: 'Me paga no pix',
        cleared_refs: null,
        quarantine_file: null,
        blocklist_id: null,
      }),
    );
    repo.overturnContent.mockResolvedValue({ decided: true, restored: 1 });

    const r = await appealsService.decide(1, 31, 'overturn', 'Era brincadeira.');

    expect(repo.overturnContent).toHaveBeenCalledWith({
      id: 31,
      adminId: 1,
      note: 'Era brincadeira.',
      targetType: 'message',
      targetId: 55,
    });
    expect(repo.overturn).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(vi.mocked(messagingService.announceChange)).toHaveBeenCalledWith(55);
    expect(notify).toHaveBeenCalledWith(9, {
      type: 'appeal_decided',
      title: 'Contestação aceita: seu conteúdo voltou',
      body: 'Sua mensagem voltou ao chat e a remoção deixou de contar como ocorrência. Era brincadeira.',
      data: { removalId: 31, decision: 'overturned' },
    });
    expect(r).toEqual({
      status: 'overturned',
      restoredReferences: 1,
      imageRestored: false,
      contentRestored: true,
      fileDeleted: false,
    });
  });

  it('o dono vê o rótulo e o texto da avaliação removida (ADR 44)', async () => {
    repo.listForOwner.mockResolvedValue([
      removal({ target_type: 'review', image_url: null, content_snapshot: 'Nota 1 de 5. Ruim.' }),
    ]);
    const mine = await appealsService.mine(9, NOW);
    expect(mine.removals[0]).toMatchObject({
      targetType: 'review',
      label: 'Avaliação',
      excerpt: 'Nota 1 de 5. Ruim.',
    });
  });
});

const POLICY = { appealWindowDays: 14, windowDays: 180, blockDays: 7, reviewThreshold: 3 };
const textRemoval = (o: Record<string, unknown> = {}) =>
  removal({
    status: 'appealed',
    target_type: 'review',
    target_id: 21,
    image_url: null,
    content_snapshot: 'Nota 1 de 5. Ruim.',
    cleared_refs: null,
    quarantine_file: null,
    blocklist_id: null,
    ...o,
  });

describe('rótulo da remoção', () => {
  it('diz o que saiu do ar: foto, trabalho (com o título enquanto ele existe), avaliação ou mensagem', () => {
    expect(removalLabel({ target_type: 'avatar', work_title: null })).toBe('Foto de perfil');
    expect(removalLabel({ target_type: 'review', work_title: null })).toBe('Avaliação');
    expect(removalLabel({ target_type: 'message', work_title: null })).toBe('Mensagem no chat');
    expect(removalLabel({ target_type: 'portfolio_item', work_title: 'Logo' })).toBe(
      'Imagem do trabalho “Logo”',
    );
    // Trabalho apagado depois da remoção: sem título para mostrar.
    expect(removalLabel({ target_type: 'portfolio_item', work_title: null })).toBe(
      'Imagem do portfólio',
    );
  });
});

describe('o que o dono vê e contesta (ADR 41)', () => {
  it('mine busca as remoções e a reincidência de quem pediu, e só remoção ainda não contestada pode ser contestada', async () => {
    const appealedAt = new Date('2026-09-16T09:00:00Z');
    const decidedAt = new Date('2026-09-17T09:00:00Z');
    repo.listForOwner.mockResolvedValue([
      removal(),
      // Dentro do prazo, mas já contestada e decidida: não abre de novo.
      removal({
        id: 30,
        status: 'upheld',
        appeal_text: 'É a minha foto.',
        appealed_at: appealedAt,
        decided_at: decidedAt,
        decision_note: 'Continua ofensiva.',
      }),
    ]);

    const mine = await appealsService.mine(9, NOW);

    expect(repo.listForOwner).toHaveBeenCalledWith(9);
    expect(summary).toHaveBeenCalledTimes(1);
    expect(summary).toHaveBeenCalledWith(9, NOW, POLICY);
    expect(mine.strikes).toEqual({
      strikes: 1,
      imageStrikes: 1,
      windowDays: 180,
      reviewThreshold: 3,
      uploadsBlockedUntil: null,
    });
    expect(mine.removals).toEqual([
      {
        id: 31,
        targetType: 'avatar',
        label: 'Foto de perfil',
        excerpt: null,
        reason: 'offensive',
        note: 'Imagem ofensiva.',
        removedAt: '2026-09-15T12:00:00.000Z',
        status: 'removed',
        appealDeadline: '2026-09-29T12:00:00.000Z',
        canAppeal: true,
        appealText: null,
        appealedAt: null,
        decidedAt: null,
        decisionNote: null,
      },
      {
        id: 30,
        targetType: 'avatar',
        label: 'Foto de perfil',
        excerpt: null,
        reason: 'offensive',
        note: 'Imagem ofensiva.',
        removedAt: '2026-09-15T12:00:00.000Z',
        status: 'upheld',
        appealDeadline: '2026-09-29T12:00:00.000Z',
        canAppeal: false,
        appealText: 'É a minha foto.',
        appealedAt: '2026-09-16T09:00:00.000Z',
        decidedAt: '2026-09-17T09:00:00.000Z',
        decisionNote: 'Continua ofensiva.',
      },
    ]);
  });

  it('remoção que não existe é o mesmo 404 da remoção de outra pessoa (não revela que existe)', async () => {
    repo.findById.mockResolvedValueOnce(undefined);
    await expect(appealsService.appeal(9, 404, 'texto', NOW)).rejects.toMatchObject({
      statusCode: 404,
      code: 'removal_not_found',
    });
    repo.findById.mockResolvedValueOnce(removal({ owner_id: 99 }));
    await expect(appealsService.appeal(9, 31, 'texto', NOW)).rejects.toMatchObject({
      statusCode: 404,
      code: 'removal_not_found',
    });
    expect(repo.findById).toHaveBeenNthCalledWith(1, 404);
    expect(repo.appeal).not.toHaveBeenCalled();
  });

  it('no último instante do prazo ainda vale; um milissegundo depois, 410', async () => {
    // Removida 14 dias antes de NOW, na mesma hora: o prazo termina exatamente em NOW.
    const atDeadline = removal({ removed_at: new Date('2026-09-06T12:00:00Z') });
    repo.findById.mockResolvedValueOnce(atDeadline).mockResolvedValueOnce(atDeadline);
    const ok = await appealsService.appeal(9, 31, 'É a minha foto.', NOW);
    expect(ok.appealDeadline).toBe('2026-09-20T12:00:00.000Z');
    expect(repo.appeal).toHaveBeenCalledTimes(1);

    repo.findById.mockResolvedValueOnce(atDeadline);
    await expect(
      appealsService.appeal(9, 31, 'É a minha foto.', new Date(NOW.getTime() + 1)),
    ).rejects.toMatchObject({ statusCode: 410, code: 'appeal_window_closed' });
    expect(repo.appeal).toHaveBeenCalledTimes(1);
  });

  it('o prazo para contestar é o da configuração (appeal_window_days), não um número fixo', async () => {
    // Removida há 20 dias: fora do prazo de 14, dentro do de 30.
    const old = removal({ removed_at: new Date('2026-08-31T12:00:00Z') });
    policy.mockResolvedValue({ ...POLICY, appealWindowDays: 30 });
    repo.listForOwner.mockResolvedValue([old]);
    repo.findById.mockResolvedValueOnce(old).mockResolvedValueOnce(old);

    const mine = await appealsService.mine(9, NOW);
    expect(mine.removals[0]).toMatchObject({
      canAppeal: true,
      appealDeadline: '2026-09-30T12:00:00.000Z',
    });
    const ok = await appealsService.appeal(9, 31, 'É a minha foto.', NOW);
    expect(ok.appealDeadline).toBe('2026-09-30T12:00:00.000Z');
    expect(repo.appeal).toHaveBeenCalledTimes(1);

    // Com o prazo encurtado para 7 dias, a remoção de 5 dias atrás vale e a de 20 não.
    policy.mockResolvedValue({ ...POLICY, appealWindowDays: 7 });
    repo.findById.mockResolvedValueOnce(old);
    await expect(appealsService.appeal(9, 31, 'É a minha foto.', NOW)).rejects.toMatchObject({
      statusCode: 410,
      code: 'appeal_window_closed',
    });
    expect(repo.appeal).toHaveBeenCalledTimes(1);
    repo.listForOwner.mockResolvedValue([removal()]);
    const short = await appealsService.mine(9, NOW);
    expect(short.removals[0]).toMatchObject({
      canAppeal: true,
      appealDeadline: '2026-09-22T12:00:00.000Z',
    });
  });

  it('remoção já contestada ou decidida não aceita nova contestação: 409 (e não 410), mesmo com o prazo vencido', async () => {
    for (const status of ['appealed', 'upheld', 'overturned']) {
      // Fora do prazo de propósito: quem já contestou ouve "já contestada", não "prazo terminou".
      repo.findById.mockResolvedValueOnce(
        removal({ status, removed_at: new Date('2026-08-01T12:00:00Z') }),
      );
      await expect(appealsService.appeal(9, 31, 'De novo.', NOW)).rejects.toMatchObject({
        statusCode: 409,
        code: 'appeal_exists',
      });
    }
    expect(repo.appeal).not.toHaveBeenCalled();
  });

  it('remoção de outra pessoa é 404 mesmo já contestada ou fora do prazo (não revela a situação)', async () => {
    repo.findById.mockResolvedValueOnce(
      removal({ owner_id: 99, status: 'upheld', removed_at: new Date('2026-08-01T12:00:00Z') }),
    );
    await expect(appealsService.appeal(9, 31, 'texto', NOW)).rejects.toMatchObject({
      statusCode: 404,
      code: 'removal_not_found',
    });
    expect(repo.appeal).not.toHaveBeenCalled();
  });

  it('sem relógio passado (como a rota chama), o prazo e a reincidência contam a partir de agora', async () => {
    const lastInstant = new Date('2026-09-29T12:00:00Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Removida em 15/09 às 12:00 UTC: com 14 dias, o prazo termina em 29/09 às 12:00 UTC.
      vi.setSystemTime(lastInstant);
      repo.listForOwner.mockResolvedValue([removal()]);
      repo.findById.mockResolvedValue(removal());

      const mine = await appealsService.mine(9);
      expect(mine.removals[0]).toMatchObject({ canAppeal: true });
      expect(summary).toHaveBeenCalledTimes(1);
      expect(summary).toHaveBeenCalledWith(9, lastInstant, POLICY);
      await appealsService.appeal(9, 31, 'É a minha foto.');
      expect(repo.appeal).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date(lastInstant.getTime() + 1));
      const late = await appealsService.mine(9);
      expect(late.removals[0]).toMatchObject({ canAppeal: false });
      await expect(appealsService.appeal(9, 31, 'É a minha foto.')).rejects.toMatchObject({
        statusCode: 410,
        code: 'appeal_window_closed',
      });
      expect(repo.appeal).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('duas contestações ao mesmo tempo: a que chega depois recebe 409, sem reler a remoção', async () => {
    repo.findById.mockResolvedValueOnce(removal());
    repo.appeal.mockResolvedValueOnce(false);

    await expect(appealsService.appeal(9, 31, 'É a minha foto.', NOW)).rejects.toMatchObject({
      statusCode: 409,
      code: 'appeal_exists',
    });

    expect(repo.appeal).toHaveBeenCalledWith(31, 9, 'É a minha foto.');
    expect(repo.findById).toHaveBeenCalledTimes(1);
  });
});

describe('contestações na mão do admin (ADR 41)', () => {
  it('lista pede até 200 do filtro escolhido e calcula a reincidência uma vez por dono', async () => {
    const appealedAt = new Date('2026-09-16T09:00:00Z');
    repo.listAppeals.mockResolvedValue([
      removal({
        status: 'appealed',
        appeal_text: 'É a minha foto.',
        appealed_at: appealedAt,
        owner_ulid: '01OWNER',
        owner_name: 'Bruno Costa',
      }),
      // Mesmo dono, arquivo já expurgado: não há imagem para o admin ver.
      removal({
        id: 32,
        status: 'appealed',
        appeal_text: null,
        appealed_at: appealedAt,
        file_purged_at: new Date('2026-09-18T00:00:00Z'),
        owner_ulid: '01OWNER',
        owner_name: 'Bruno Costa',
      }),
      // Outro dono, remoção de texto: nunca teve arquivo.
      textRemoval({
        id: 33,
        owner_id: 12,
        target_type: 'message',
        content_snapshot: 'Me paga no pix',
        appeal_text: 'Era brincadeira.',
        appealed_at: appealedAt,
        owner_ulid: '01OTHER',
        owner_name: null,
      }),
    ]);
    summary.mockImplementation(async (ownerId) => ({
      strikes: ownerId === 9 ? 2 : 1,
      imageStrikes: 0,
      windowDays: 180,
      reviewThreshold: 3,
      uploadsBlockedUntil: null,
    }));

    const list = await appealsService.listForAdmin('pending');

    expect(repo.listAppeals).toHaveBeenCalledTimes(1);
    expect(repo.listAppeals).toHaveBeenCalledWith('pending', 200);
    expect(summary).toHaveBeenCalledTimes(2);
    expect(summary).toHaveBeenCalledWith(9, expect.any(Date), POLICY);
    expect(summary).toHaveBeenCalledWith(12, expect.any(Date), POLICY);
    expect(list[0]).toEqual({
      id: 31,
      owner: { id: 9, ulid: '01OWNER', name: 'Bruno Costa' },
      targetType: 'avatar',
      label: 'Foto de perfil',
      excerpt: null,
      reason: 'offensive',
      note: 'Imagem ofensiva.',
      removedAt: '2026-09-15T12:00:00.000Z',
      imageUrl: MEDIA,
      appealText: 'É a minha foto.',
      appealedAt: '2026-09-16T09:00:00.000Z',
      status: 'appealed',
      decidedAt: null,
      decisionNote: null,
      hasImage: true,
      ownerStrikes: 2,
    });
    expect(list[1]).toMatchObject({ id: 32, appealText: '', hasImage: false, ownerStrikes: 2 });
    expect(list[2]).toMatchObject({
      id: 33,
      owner: { id: 12, ulid: '01OTHER', name: null },
      targetType: 'message',
      label: 'Mensagem no chat',
      excerpt: 'Me paga no pix',
      imageUrl: null,
      hasImage: false,
      ownerStrikes: 1,
    });
  });

  it('sem contestação na fila: lista vazia, sem calcular a reincidência de ninguém', async () => {
    repo.listAppeals.mockResolvedValue([]);

    expect(await appealsService.listForAdmin('pending')).toEqual([]);

    expect(repo.listAppeals).toHaveBeenCalledTimes(1);
    expect(repo.listAppeals).toHaveBeenCalledWith('pending', 200);
    expect(summary).not.toHaveBeenCalled();
  });

  it('decididas: o filtro vai ao repository, e a decisão sai com a data e a nota', async () => {
    repo.listAppeals.mockResolvedValue([
      removal({
        status: 'overturned',
        appeal_text: 'É a minha foto.',
        appealed_at: new Date('2026-09-16T09:00:00Z'),
        decided_at: new Date('2026-09-17T09:00:00Z'),
        decision_note: 'Foto legítima.',
        quarantine_file: null,
        owner_ulid: '01OWNER',
        owner_name: 'Bruno Costa',
      }),
    ]);

    const list = await appealsService.listForAdmin('decided');

    expect(repo.listAppeals).toHaveBeenCalledWith('decided', 200);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      status: 'overturned',
      decidedAt: '2026-09-17T09:00:00.000Z',
      decisionNote: 'Foto legítima.',
      hasImage: false,
    });
  });

  it('a imagem em quarentena só existe enquanto o arquivo está lá; senão é 404', async () => {
    filePath.mockReturnValue('/dados/quarantine/31.webp');
    repo.findById.mockResolvedValueOnce(removal({ status: 'appealed' }));
    expect(await appealsService.quarantineImage(31)).toBe('/dados/quarantine/31.webp');
    expect(repo.findById).toHaveBeenCalledWith(31);
    expect(filePath).toHaveBeenCalledTimes(1);
    expect(filePath).toHaveBeenCalledWith('31.webp');

    const gone = [
      undefined,
      removal({ quarantine_file: null }),
      removal({ file_purged_at: new Date('2026-09-18T00:00:00Z') }),
    ];
    for (const row of gone) {
      repo.findById.mockResolvedValueOnce(row);
      await expect(appealsService.quarantineImage(31)).rejects.toMatchObject({
        statusCode: 404,
        code: 'removal_image_not_found',
      });
    }
    // Nome que tenta sair da pasta da quarentena não vira caminho.
    filePath.mockReturnValueOnce(null);
    repo.findById.mockResolvedValueOnce(removal({ quarantine_file: '../segredo' }));
    await expect(appealsService.quarantineImage(31)).rejects.toMatchObject({
      statusCode: 404,
      code: 'removal_image_not_found',
    });
    expect(filePath).toHaveBeenCalledTimes(2);
  });

  describe('decidir', () => {
    it('remoção que não existe é 404 e nada é decidido', async () => {
      repo.findById.mockResolvedValue(undefined);
      await expect(appealsService.decide(1, 404, 'uphold', null)).rejects.toMatchObject({
        statusCode: 404,
        code: 'removal_not_found',
      });
      expect(repo.findById).toHaveBeenCalledWith(404);
      expect(repo.uphold).not.toHaveBeenCalled();
      expect(repo.overturn).not.toHaveBeenCalled();
      expect(repo.overturnContent).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });

    it('remoção ainda não contestada não tem o que decidir: 409 sem tocar em nada', async () => {
      repo.findById.mockResolvedValue(removal({ status: 'removed' }));
      for (const decision of ['uphold', 'overturn'] as const) {
        await expect(appealsService.decide(1, 31, decision, null)).rejects.toMatchObject({
          statusCode: 409,
          code: 'appeal_not_pending',
        });
      }
      expect(repo.uphold).not.toHaveBeenCalled();
      expect(repo.overturn).not.toHaveBeenCalled();
      expect(removeFile).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
    });

    it('manter: se outro admin decidiu antes, é 409 e o arquivo fica onde está', async () => {
      repo.findById.mockResolvedValue(removal({ status: 'appealed' }));
      repo.uphold.mockResolvedValueOnce(false);

      await expect(appealsService.decide(1, 31, 'uphold', null)).rejects.toMatchObject({
        statusCode: 409,
        code: 'appeal_not_pending',
      });

      expect(removeFile).not.toHaveBeenCalled();
      expect(repo.markFilePurged).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });

    it('manter remoção sem arquivo em quarentena (texto, ou arquivo já expurgado): nada a apagar, e o aviso sai sem nota', async () => {
      repo.findById.mockResolvedValueOnce(textRemoval());

      const r = await appealsService.decide(1, 31, 'uphold', null);

      expect(repo.uphold).toHaveBeenCalledWith(31, 1, null);
      expect(removeFile).not.toHaveBeenCalled();
      expect(repo.markFilePurged).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(9, {
        type: 'appeal_decided',
        title: 'Contestação analisada: a remoção foi mantida',
        body: 'Avaliação continua fora do ar.',
        data: { removalId: 31, decision: 'upheld' },
      });
      expect(r).toEqual({
        status: 'upheld',
        restoredReferences: 0,
        imageRestored: false,
        contentRestored: false,
        fileDeleted: false,
      });

      repo.findById.mockResolvedValueOnce(
        removal({ status: 'appealed', file_purged_at: new Date('2026-09-18T00:00:00Z') }),
      );
      const purged = await appealsService.decide(1, 31, 'uphold', null);
      expect(purged.fileDeleted).toBe(false);
      expect(removeFile).not.toHaveBeenCalled();
      expect(repo.markFilePurged).not.toHaveBeenCalled();
    });

    it('avaliação: reverter devolve ao perfil do freelancer e avisa só o autor, sem mexer no chat (ADR 44)', async () => {
      repo.findById.mockResolvedValue(textRemoval());
      repo.overturnContent.mockResolvedValue({ decided: true, restored: 1 });

      const r = await appealsService.decide(1, 31, 'overturn', null);

      expect(repo.overturnContent).toHaveBeenCalledWith({
        id: 31,
        adminId: 1,
        note: null,
        targetType: 'review',
        targetId: 21,
      });
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(9, {
        type: 'appeal_decided',
        title: 'Contestação aceita: seu conteúdo voltou',
        body: 'Sua avaliação voltou ao perfil do freelancer e a remoção deixou de contar como ocorrência.',
        data: { removalId: 31, decision: 'overturned' },
      });
      expect(announce).not.toHaveBeenCalled();
      expect(repo.overturn).not.toHaveBeenCalled();
      expect(r).toEqual({
        status: 'overturned',
        restoredReferences: 1,
        imageRestored: false,
        contentRestored: true,
        fileDeleted: false,
      });
    });

    it('texto que não pôde voltar (já não existe): a ocorrência cai, mas o aviso não promete o conteúdo de volta nem mexe no chat', async () => {
      repo.findById.mockResolvedValue(textRemoval({ target_type: 'message', target_id: 55 }));
      repo.overturnContent.mockResolvedValue({ decided: true, restored: 0 });

      const r = await appealsService.decide(1, 31, 'overturn', 'Era brincadeira.');

      expect(notify).toHaveBeenCalledWith(9, {
        type: 'appeal_decided',
        title: 'Contestação aceita',
        body: 'A remoção foi revertida e deixou de contar como ocorrência. Era brincadeira.',
        data: { removalId: 31, decision: 'overturned' },
      });
      expect(announce).not.toHaveBeenCalled();
      expect(r).toEqual({
        status: 'overturned',
        restoredReferences: 0,
        imageRestored: false,
        contentRestored: false,
        fileDeleted: false,
      });
    });

    it('texto: se outro admin decidiu antes, é 409 e ninguém é avisado', async () => {
      repo.findById.mockResolvedValue(textRemoval({ target_type: 'message', target_id: 55 }));
      repo.overturnContent.mockResolvedValue({ decided: false, restored: 0 });

      await expect(appealsService.decide(1, 31, 'overturn', null)).rejects.toMatchObject({
        statusCode: 409,
        code: 'appeal_not_pending',
      });

      expect(notify).not.toHaveBeenCalled();
      expect(announce).not.toHaveBeenCalled();
    });

    it('mensagem: falha ao avisar a sala do chat não desfaz a decisão', async () => {
      repo.findById.mockResolvedValue(textRemoval({ target_type: 'message', target_id: 55 }));
      repo.overturnContent.mockResolvedValue({ decided: true, restored: 1 });
      announce.mockRejectedValueOnce(new Error('socket fora'));

      const r = await appealsService.decide(1, 31, 'overturn', null);

      expect(announce).toHaveBeenCalledWith(55);
      expect(r).toMatchObject({ status: 'overturned', contentRestored: true });
    });

    it('imagem de link externo: não há arquivo para devolver, mas a imagem é recolocada onde estava', async () => {
      const external = 'https://i.pravatar.cc/150';
      repo.findById.mockResolvedValue(
        removal({
          status: 'appealed',
          target_type: 'portfolio_item',
          target_id: 3,
          image_url: external,
          // No banco a coluna JSON pode chegar como texto.
          cleared_refs: '[{"table":"freelancer_portfolio_items","id":3}]',
          quarantine_file: null,
          blocklist_id: null,
          work_title: 'Logo',
        }),
      );

      const r = await appealsService.decide(1, 31, 'overturn', null);

      expect(restore).not.toHaveBeenCalled();
      expect(repo.overturn).toHaveBeenCalledWith({
        id: 31,
        adminId: 1,
        note: null,
        url: external,
        refs: [{ table: 'freelancer_portfolio_items', id: 3 }],
        blocklistId: null,
        restoreRefs: true,
        fileBack: false,
      });
      expect(notify).toHaveBeenCalledWith(9, {
        type: 'appeal_decided',
        title: 'Contestação aceita: sua imagem voltou',
        body: 'Imagem do trabalho “Logo” voltou ao seu perfil e a remoção deixou de contar como ocorrência.',
        data: { removalId: 31, decision: 'overturned' },
      });
      expect(r).toMatchObject({ restoredReferences: 1, imageRestored: true });
    });

    it('arquivo devolvido, mas o dono já pôs outra imagem no lugar: a antiga não volta e o aviso explica', async () => {
      repo.findById.mockResolvedValue(removal({ status: 'appealed' }));
      repo.overturn.mockResolvedValueOnce({ decided: true, restored: 0 });

      const r = await appealsService.decide(1, 31, 'overturn', null);

      expect(repo.overturn).toHaveBeenCalledWith(
        expect.objectContaining({ restoreRefs: true, fileBack: true }),
      );
      expect(notify).toHaveBeenCalledWith(
        9,
        expect.objectContaining({
          title: 'Contestação aceita',
          body: 'A remoção foi revertida e deixou de contar como ocorrência. Como você já tinha colocado outra imagem no lugar, a antiga não foi recolocada.',
        }),
      );
      expect(r).toEqual({
        status: 'overturned',
        restoredReferences: 0,
        imageRestored: false,
        contentRestored: false,
        fileDeleted: false,
      });
    });

    it('arquivo que não sai da quarentena (sumiu do disco): a decisão vale, sem recolocar referência quebrada', async () => {
      repo.findById.mockResolvedValue(removal({ status: 'appealed' }));
      restore.mockResolvedValueOnce(false);
      repo.overturn.mockResolvedValueOnce({ decided: true, restored: 0 });

      await appealsService.decide(1, 31, 'overturn', null);

      expect(restore).toHaveBeenCalledTimes(1);
      expect(repo.overturn).toHaveBeenCalledWith(
        expect.objectContaining({ restoreRefs: false, fileBack: false }),
      );
      expect(notify).toHaveBeenCalledWith(
        9,
        expect.objectContaining({
          body: 'A remoção foi revertida e deixou de contar como ocorrência. A imagem não pôde ser recuperada; envie de novo pelo perfil.',
        }),
      );
    });

    it('lista de onde a imagem saiu ilegível, vazia ou que não é lista vale como nenhuma referência', async () => {
      for (const cleared of ['{não é json', '{"table":"profiles_client","id":1}', null, 42]) {
        repo.overturn.mockClear();
        repo.findById.mockResolvedValueOnce(removal({ status: 'appealed', cleared_refs: cleared }));
        await appealsService.decide(1, 31, 'overturn', null);
        expect(repo.overturn).toHaveBeenCalledWith(expect.objectContaining({ refs: [] }));
      }
    });

    it('manter: o resultado diz se o arquivo saiu mesmo do disco, e o dono é avisado de qualquer jeito', async () => {
      repo.findById.mockResolvedValue(removal({ status: 'appealed' }));
      removeFile.mockResolvedValueOnce(false);

      const r = await appealsService.decide(1, 31, 'uphold', null);

      expect(removeFile).toHaveBeenCalledTimes(1);
      expect(removeFile).toHaveBeenCalledWith('31.webp');
      expect(r).toEqual({
        status: 'upheld',
        restoredReferences: 0,
        imageRestored: false,
        contentRestored: false,
        fileDeleted: false,
      });
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(9, {
        type: 'appeal_decided',
        title: 'Contestação analisada: a remoção foi mantida',
        body: 'Foto de perfil continua fora do ar.',
        data: { removalId: 31, decision: 'upheld' },
      });
      // Manter não devolve nada: nem arquivo, nem referência.
      expect(restore).not.toHaveBeenCalled();
      expect(repo.overturn).not.toHaveBeenCalled();
      expect(repo.overturnContent).not.toHaveBeenCalled();
    });

    it('imagem interna que nunca chegou à quarentena (o arquivo já tinha sumido na remoção): não tenta devolver arquivo nem recoloca referência quebrada', async () => {
      repo.findById.mockResolvedValue(removal({ status: 'appealed', quarantine_file: null }));
      repo.overturn.mockResolvedValueOnce({ decided: true, restored: 0 });

      const r = await appealsService.decide(1, 31, 'overturn', null);

      expect(restore).not.toHaveBeenCalled();
      expect(repo.overturn).toHaveBeenCalledWith({
        id: 31,
        adminId: 1,
        note: null,
        url: MEDIA,
        refs: [{ table: 'profiles_freelancer', id: 2 }],
        blocklistId: 7,
        restoreRefs: false,
        fileBack: false,
      });
      expect(notify).toHaveBeenCalledWith(9, {
        type: 'appeal_decided',
        title: 'Contestação aceita',
        body: 'A remoção foi revertida e deixou de contar como ocorrência. A imagem não pôde ser recuperada; envie de novo pelo perfil.',
        data: { removalId: 31, decision: 'overturned' },
      });
      expect(r).toEqual({
        status: 'overturned',
        restoredReferences: 0,
        imageRestored: false,
        contentRestored: false,
        fileDeleted: false,
      });
    });

    it('reverter imagem não passa pela reversão de texto nem apaga arquivo da quarentena', async () => {
      repo.findById.mockResolvedValue(removal({ status: 'appealed' }));

      await appealsService.decide(1, 31, 'overturn', null);

      expect(repo.overturnContent).not.toHaveBeenCalled();
      expect(repo.uphold).not.toHaveBeenCalled();
      expect(removeFile).not.toHaveBeenCalled();
      expect(repo.markFilePurged).not.toHaveBeenCalled();
      expect(announce).not.toHaveBeenCalled();
    });

    it('imagem: se outro admin decidiu antes, é 409 e o dono não é avisado', async () => {
      repo.findById.mockResolvedValue(removal({ status: 'appealed' }));
      repo.overturn.mockResolvedValueOnce({ decided: false, restored: 0 });

      await expect(appealsService.decide(1, 31, 'overturn', null)).rejects.toMatchObject({
        statusCode: 409,
        code: 'appeal_not_pending',
      });

      expect(notify).not.toHaveBeenCalled();
    });
  });
});

describe('expurgo da quarentena', () => {
  it('o corte é agora menos o prazo de contestação configurado, e cada arquivo apagado fica marcado', async () => {
    policy.mockResolvedValue({ ...POLICY, appealWindowDays: 30 });
    repo.listQuarantineToPurge.mockResolvedValue([removal({ id: 30, quarantine_file: '30.webp' })]);

    expect(await appealsService.purgeQuarantine(NOW)).toBe(1);

    expect(repo.listQuarantineToPurge).toHaveBeenCalledWith(new Date('2026-08-21T12:00:00Z'), 500);
    expect(removeFile).toHaveBeenCalledTimes(1);
    expect(removeFile).toHaveBeenCalledWith('30.webp');
    expect(repo.markFilePurged).toHaveBeenCalledTimes(1);
    expect(repo.markFilePurged).toHaveBeenCalledWith(30);
  });

  it('titular anonimizado (LGPD): todos os arquivos dele saem na hora, sem esperar prazo', async () => {
    repo.listQuarantinedForOwner.mockResolvedValue([
      removal(),
      removal({ id: 32, quarantine_file: '32.png', status: 'appealed' }),
    ]);

    expect(await appealsService.purgeForOwner(9)).toBe(2);

    expect(repo.listQuarantinedForOwner).toHaveBeenCalledTimes(1);
    expect(repo.listQuarantinedForOwner).toHaveBeenCalledWith(9);
    expect(removeFile.mock.calls).toEqual([['31.webp'], ['32.png']]);
    expect(repo.markFilePurged.mock.calls).toEqual([[31], [32]]);
    // Não depende do prazo de contestação.
    expect(policy).not.toHaveBeenCalled();
    expect(repo.listQuarantineToPurge).not.toHaveBeenCalled();
  });

  it('sem nada em quarentena não apaga nem marca nada', async () => {
    repo.listQuarantinedForOwner.mockResolvedValue([]);
    expect(await appealsService.purgeForOwner(9)).toBe(0);
    expect(removeFile).not.toHaveBeenCalled();
    expect(repo.markFilePurged).not.toHaveBeenCalled();

    repo.listQuarantineToPurge.mockResolvedValue([]);
    expect(await appealsService.purgeQuarantine(NOW)).toBe(0);
    expect(removeFile).not.toHaveBeenCalled();
    expect(repo.markFilePurged).not.toHaveBeenCalled();
  });

  it('sem relógio passado (como o job chama), o corte do expurgo conta a partir de agora; cada arquivo é marcado depois de apagado', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T08:30:00Z'));
    try {
      repo.listQuarantineToPurge.mockResolvedValue([
        removal({ id: 30, quarantine_file: '30.webp' }),
        removal({ id: 33, quarantine_file: '33.jpg', status: 'upheld' }),
      ]);

      expect(await appealsService.purgeQuarantine()).toBe(2);

      expect(repo.listQuarantineToPurge).toHaveBeenCalledTimes(1);
      expect(repo.listQuarantineToPurge).toHaveBeenCalledWith(
        new Date('2026-09-17T08:30:00Z'),
        500,
      );
      expect(removeFile.mock.calls).toEqual([['30.webp'], ['33.jpg']]);
      expect(repo.markFilePurged.mock.calls).toEqual([[30], [33]]);
      // Apaga e só então marca, arquivo por arquivo: uma queda no meio não marca o que não saiu.
      const deleted = removeFile.mock.invocationCallOrder;
      const marked = repo.markFilePurged.mock.invocationCallOrder;
      expect(deleted[0]!).toBeLessThan(marked[0]!);
      expect(marked[0]!).toBeLessThan(deleted[1]!);
      expect(deleted[1]!).toBeLessThan(marked[1]!);
    } finally {
      vi.useRealTimers();
    }
  });
});
