import { userZone } from '../auth/user-zone';
import type {
  AdminReportActionResult,
  AdminReportGroup,
  BrazilTimezone,
  ReportReason,
  ReportStatus,
  ReportTargetType,
  StrikeSummary,
} from '@escambo/types';
import { logger } from '../../config/logger';
import { captureError } from '../../config/sentry';
import { HttpError } from '../../utils/http-error';
import { formatDateTime } from '../../utils/timezone';
import { fingerprint } from '../media/media.image';
import { mediaKeyFromUrl } from '../media/media.paths';
import {
  deleteMediaImage,
  deleteQuarantined,
  quarantineMediaImage,
  readMediaFile,
} from '../media/media.storage';
import { messagingService } from '../messaging/messaging.service';
import { notificationsService } from '../notifications/notifications.service';
import { contentRemovalsRepository } from './content-removals.repository';
import {
  appealDeadline,
  strikePolicy,
  strikeSummary,
  type StrikePolicy,
} from './moderation.strikes';
import { reportsRepository, type ContentReportRow, type TargetInfoRow } from './reports.repository';
import { isImageTarget, isTextTarget, type ReportAction } from './reports.schema';

/**
 * Fila de moderação (ADR 39). Denúncias do mesmo alvo e da mesma imagem viram um grupo (a foto pode
 * ser trocada entre uma denúncia e outra, e cada imagem é analisada por si), e cada decisão vale
 * para o grupo inteiro. Remoção de imagem com dono vira registro contestável, com o arquivo em
 * quarentena, e conta para a reincidência (ADR 41).
 */

/** Quantas denúncias a fila lê de uma vez: sobra para a triagem sem varrer a tabela toda. */
export const MODERATION_ROWS_LIMIT = 500;

const OPEN = new Set(['pending', 'reviewing']);

/** Motivo como aparece no aviso ao dono da imagem. */
const REASON_TEXT: Record<string, string> = {
  spam: 'spam',
  fraud: 'fraude ou golpe',
  offensive: 'conteúdo ofensivo',
  off_platform: 'negociação fora da plataforma',
  illegal: 'atividade ilegal',
  other: 'violar as regras do Escambo',
};

const iso = (d: Date): string => new Date(d).toISOString();

/** Fuso da conta, para as datas do aviso saírem na hora dela (ADR 46). */
const zoneOf = userZone;

function labelFor(type: string, info: TargetInfoRow | undefined): string {
  switch (type) {
    case 'avatar':
      return 'Foto de perfil';
    case 'portfolio_item':
      return info?.title ? `Imagem do trabalho “${info.title}”` : 'Imagem do portfólio';
    case 'service':
      return info?.title ? `Serviço “${info.title}”` : 'Serviço';
    case 'review':
      return 'Avaliação';
    case 'message':
      return 'Mensagem no chat';
    default:
      return 'Perfil';
  }
}

function excerptFor(type: string, info: TargetInfoRow | undefined): string | null {
  if ((type !== 'review' && type !== 'message') || !info?.title) return null;
  const text = info.title.trim();
  if (!text) return null;
  return text.length > 280 ? `${text.slice(0, 279)}…` : text;
}

async function describeTargets(rows: ContentReportRow[]): Promise<Map<string, TargetInfoRow>> {
  const idsOf = (...types: string[]): number[] => [
    ...new Set(rows.filter((r) => types.includes(r.target_type)).map((r) => r.target_id)),
  ];
  const [users, portfolio, services, reviews, messages] = await Promise.all([
    reportsRepository.usersByIds(idsOf('user', 'avatar')),
    reportsRepository.portfolioByIds(idsOf('portfolio_item')),
    reportsRepository.servicesByIds(idsOf('service')),
    reportsRepository.reviewsByIds(idsOf('review')),
    reportsRepository.messagesByIds(idsOf('message')),
  ]);
  const map = new Map<string, TargetInfoRow>();
  for (const u of users) {
    map.set(`user:${u.id}`, u);
    map.set(`avatar:${u.id}`, u);
  }
  for (const i of portfolio) map.set(`portfolio_item:${i.id}`, i);
  for (const s of services) map.set(`service:${s.id}`, s);
  for (const r of reviews) map.set(`review:${r.id}`, r);
  for (const m of messages) map.set(`message:${m.id}`, m);
  return map;
}

/** rows vêm da mais recente para a mais antiga. */
function toGroup(rows: ContentReportRow[], info: TargetInfoRow | undefined): AdminReportGroup {
  const latest = rows[0]!;
  const oldest = rows[rows.length - 1]!;
  const counts = new Map<ReportReason, number>();
  for (const r of rows) {
    const reason = r.reason as ReportReason;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return {
    id: latest.id,
    targetType: latest.target_type as ReportTargetType,
    targetId: latest.target_id,
    imageUrl: latest.image_url,
    imageLive: latest.image_url !== null && info?.image_url === latest.image_url,
    label: labelFor(latest.target_type, info),
    excerpt: excerptFor(latest.target_type, info),
    owner:
      info?.owner_id != null && info.owner_ulid
        ? { id: info.owner_id, ulid: info.owner_ulid, name: info.owner_name }
        : null,
    status: (OPEN.has(latest.status) ? 'pending' : latest.status) as ReportStatus,
    reports: rows.length,
    reasons: [...counts].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count })),
    descriptions: rows
      .map((r) => r.description?.trim())
      .filter((d): d is string => Boolean(d))
      .slice(0, 3),
    firstReportedAt: iso(oldest.created_at),
    lastReportedAt: iso(latest.created_at),
    reviewedAt: latest.reviewed_at ? iso(latest.reviewed_at) : null,
    resolutionNote: latest.resolution_note,
    automatic: rows.some((r) => r.reporter_id === null),
  };
}

/** Cópia do texto removido (ADR 44): a nota vai junto na avaliação, o nome do anexo na mensagem. */
export function contentSnapshot(
  type: string,
  t: { text: string | null; rating: number | null; file_name: string | null },
): string {
  const text = t.text?.trim() ?? '';
  const body =
    type === 'review'
      ? [`Nota ${t.rating ?? '?'} de 5.`, text].filter(Boolean).join(' ')
      : text || (t.file_name ? `Anexo: ${t.file_name}` : '(mensagem sem texto)');
  return body.length > 1000 ? `${body.slice(0, 999)}…` : body;
}

/** De qual decisão é o passo, para o log. */
interface StepCtx {
  reportId: number;
  removalId: number | null;
}

/**
 * Passo depois do commit da remoção (quarentena, reincidência, revisão da conta, aviso). A decisão
 * já está gravada e a nova tentativa daria 409, então a falha de um passo não vira 500: vai para o
 * log e o Sentry, o passo vale `fallback` e os seguintes seguem.
 */
async function afterCommit<T>(
  step: string,
  ctx: StepCtx,
  work: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await work();
  } catch (err) {
    logger.error({ err, ...ctx }, `moderação: ${step} falhou depois da decisão gravada`);
    captureError(err);
    return fallback;
  }
}

/**
 * Anota na remoção o arquivo que foi para a quarentena. Sem a anotação nada mais acharia o arquivo
 * (nem a reversão, nem o expurgo): se ela falha, o arquivo é apagado na hora, como numa remoção
 * mantida, e a contestação aceita avisa que a imagem não pôde ser recuperada. Devolver o arquivo
 * para a pasta pública deixaria a imagem removida no ar pela URL antiga até o expurgo de órfãos.
 */
async function noteQuarantineFile(
  ctx: StepCtx & { removalId: number },
  file: string,
): Promise<void> {
  try {
    await contentRemovalsRepository.setQuarantineFile(ctx.removalId, file);
  } catch (err) {
    logger.error(
      { err, ...ctx, file },
      'moderação: arquivo da quarentena não anotado na remoção; vai ser apagado',
    );
    captureError(err);
    await afterCommit('limpeza da quarentena', ctx, () => deleteQuarantined(file), false);
  }
}

/**
 * O dono chegou ao limite de reincidência com esta remoção? Abre a denúncia da conta para revisão,
 * uma vez enquanto ela estiver aberta. Conta qualquer conteúdo removido (ADR 41 e 44).
 */
async function openAccountReview(
  adminId: number,
  ownerId: number,
  strikes: StrikeSummary,
  reviewThreshold: number,
): Promise<boolean> {
  if (strikes.strikes < reviewThreshold) return false;
  if (await reportsRepository.hasOpenAccountReview(ownerId)) return false;
  await reportsRepository.create({
    reporterId: adminId,
    targetType: 'user',
    targetId: ownerId,
    imageUrl: null,
    reason: 'other',
    description: `Reincidência: ${strikes.strikes} remoções de conteúdo nos últimos ${strikes.windowDays} dias. Revise a conta.`,
  });
  return true;
}

/**
 * Reincidência do dono depois da remoção e, no limite, a revisão da conta. Sem a política (falha ao
 * ler a configuração) não há como contar: segue sem reincidência, e o aviso sai sem a data.
 */
async function ownerFollowUp(
  adminId: number,
  ownerId: number,
  ctx: StepCtx,
): Promise<{
  now: Date;
  policy: StrikePolicy | null;
  strikes: StrikeSummary | null;
  accountReviewOpened: boolean;
}> {
  const now = new Date();
  const policy = await afterCommit('política de reincidência', ctx, () => strikePolicy(), null);
  const strikes = policy
    ? await afterCommit('reincidência', ctx, () => strikeSummary(ownerId, now, policy), null)
    : null;
  const accountReviewOpened =
    policy && strikes
      ? await afterCommit(
          'revisão da conta',
          ctx,
          () => openAccountReview(adminId, ownerId, strikes, policy.reviewThreshold),
          false,
        )
      : false;
  return { now, policy, strikes, accountReviewOpened };
}

/** A frase do prazo para contestar, na hora do dono; sem a política, só diz onde contestar. */
function appealLine(policy: StrikePolicy | null, now: Date, zone: BrazilTimezone): string {
  return policy
    ? `Se discordar, conteste pelo seu perfil até ${formatDateTime(appealDeadline(now, policy.appealWindowDays), zone)}.`
    : 'Se discordar, conteste pelo seu perfil.';
}

/**
 * Remove a avaliação ou a mensagem do grupo (ADR 44): tira do ar numa transação, avisa o autor com
 * o prazo para contestar, conta a reincidência e, se for mensagem, atualiza o chat das duas partes.
 * Conteúdo que já tinha saído do ar só fecha as denúncias.
 */
async function removeContent(
  adminId: number,
  reportId: number,
  report: ContentReportRow,
  group: {
    targetType: string;
    targetId: number;
    imageUrl: string | null;
    adminId: number;
    note: string | null;
  },
): Promise<AdminReportActionResult> {
  const type = report.target_type;
  if (!isTextTarget(type)) {
    throw new HttpError(
      422,
      'Só uma denúncia de avaliação ou de mensagem permite remover o conteúdo',
      'not_a_content_report',
    );
  }
  const content = await reportsRepository.textTarget(type, report.target_id);
  const author =
    content && !content.removed_at
      ? { id: content.owner_id, snapshot: contentSnapshot(type, content) }
      : null;
  const { reports, removalId } = await reportsRepository.removeContentAndClose({
    ...group,
    targetType: type,
    reportId,
    reason: report.reason,
    author,
  });

  let strikes: StrikeSummary | null = null;
  let accountReviewOpened = false;
  if (author && removalId !== null) {
    // Daqui em diante a remoção já está gravada: cada passo é isolado (afterCommit).
    const ctx = { reportId, removalId };
    const followUp = await ownerFollowUp(adminId, author.id, ctx);
    ({ strikes, accountReviewOpened } = followUp);
    const zone = await zoneOf(author.id);
    await afterCommit(
      'aviso ao autor',
      ctx,
      () =>
        notificationsService.notify(author.id, {
          type: 'content_removed',
          title:
            type === 'review'
              ? 'Sua avaliação foi removida'
              : 'Uma mensagem sua no chat foi removida',
          body: [
            `A moderação removeu ${type === 'review' ? 'a avaliação' : 'a mensagem'} por ${REASON_TEXT[report.reason] ?? REASON_TEXT.other}.`,
            group.note,
            appealLine(followUp.policy, followUp.now, zone),
          ]
            .filter(Boolean)
            .join(' '),
          data: { contentRemoved: type, reportId, removalId },
        }),
      undefined,
    );
    if (type === 'message') {
      await messagingService.announceChange(report.target_id).catch(() => undefined);
    }
  }
  return {
    status: 'actioned',
    reports,
    referencesCleared: 0,
    fileRemoved: false,
    blocked: false,
    removalId,
    ownerStrikes: strikes?.strikes ?? null,
    uploadsBlockedUntil: strikes?.uploadsBlockedUntil ?? null,
    accountReviewOpened,
  };
}

const NO_REMOVAL = {
  referencesCleared: 0,
  fileRemoved: false,
  blocked: false,
  removalId: null,
  ownerStrikes: null,
  uploadsBlockedUntil: null,
  accountReviewOpened: false,
} as const;

export const moderationService = {
  /** Pendentes: as mais denunciadas primeiro. Resolvidas: as decisões mais recentes primeiro. */
  async listQueue(scope: 'pending' | 'resolved'): Promise<AdminReportGroup[]> {
    const rows = await reportsRepository.listForModeration(scope, MODERATION_ROWS_LIMIT);
    const targets = await describeTargets(rows);
    const buckets = new Map<string, ContentReportRow[]>();
    for (const r of rows) {
      const base = `${r.target_type}:${r.target_id}:${r.image_url ?? ''}`;
      // Resolvidas: cada decisão é um grupo (o mesmo alvo pode ter sido analisado mais de uma vez).
      const key =
        scope === 'pending'
          ? base
          : `${base}:${r.status}:${r.reviewed_at ? new Date(r.reviewed_at).getTime() : ''}`;
      buckets.set(key, [...(buckets.get(key) ?? []), r]);
    }
    const groups = [...buckets.values()].map((g) =>
      toGroup(g, targets.get(`${g[0]!.target_type}:${g[0]!.target_id}`)),
    );
    return scope === 'pending'
      ? groups.sort(
          (a, b) => b.reports - a.reports || b.lastReportedAt.localeCompare(a.lastReportedAt),
        )
      : groups.sort((a, b) => (b.reviewedAt ?? '').localeCompare(a.reviewedAt ?? ''));
  },

  /**
   * Decide o grupo da denúncia `reportId`. Dispensar e resolver só fecham as denúncias. Remover a
   * imagem tira a URL de todo perfil e trabalho, fecha as denúncias, bloqueia o reenvio e registra
   * a remoção numa transação; depois o arquivo vai para a quarentena, a reincidência do dono é
   * calculada (com revisão da conta ao chegar no limite) e o dono é avisado de como contestar.
   */
  async act(
    adminId: number,
    reportId: number,
    action: ReportAction,
    note: string | null,
  ): Promise<{
    result: AdminReportActionResult;
    target: { type: ReportTargetType; id: number; imageUrl: string | null };
  }> {
    const report = await reportsRepository.findById(reportId);
    if (!report) throw new HttpError(404, 'Denúncia não encontrada', 'report_not_found');
    if (!OPEN.has(report.status)) {
      throw new HttpError(409, 'Estas denúncias já foram analisadas', 'report_already_resolved');
    }
    const target = {
      type: report.target_type as ReportTargetType,
      id: report.target_id,
      imageUrl: report.image_url,
    };
    const group = {
      targetType: report.target_type,
      targetId: report.target_id,
      imageUrl: report.image_url,
      adminId,
      note,
    };

    if (action === 'remove-content') {
      return { target, result: await removeContent(adminId, reportId, report, group) };
    }

    if (action === 'dismiss' || action === 'resolve') {
      const status = action === 'dismiss' ? 'dismissed' : 'actioned';
      const reports = await reportsRepository.closeGroup({ ...group, status });
      return { target, result: { ...NO_REMOVAL, status, reports } };
    }

    if (!isImageTarget(report.target_type) || !report.image_url) {
      throw new HttpError(
        422,
        'Só uma denúncia de imagem permite remover a imagem',
        'not_an_image_report',
      );
    }
    const owner = await reportsRepository.imageTarget(report.target_type, report.target_id);
    const key = mediaKeyFromUrl(report.image_url);
    // A impressão sai do arquivo antes de ele sair do ar; link externo não tem arquivo para bloquear.
    const original = key ? await readMediaFile(key) : null;
    const print = original ? await fingerprint(original) : null;
    const { cleared, reports, removalId } = await reportsRepository.removeImageAndClose({
      ...group,
      url: report.image_url,
      print,
      reportId,
      ownerId: owner?.owner_id ?? null,
      reason: report.reason,
    });

    // Daqui em diante a remoção já está gravada: cada passo é isolado (afterCommit).
    const ctx = { reportId, removalId };
    // Com registro, o arquivo vai para a quarentena enquanto cabe contestação; sem dono, sai de vez.
    let fileRemoved = false;
    if (key && removalId !== null) {
      const quarantined = await afterCommit(
        'quarentena do arquivo',
        ctx,
        () => quarantineMediaImage(key, removalId),
        null,
      );
      if (quarantined) {
        await noteQuarantineFile({ reportId, removalId }, quarantined);
        fileRemoved = true;
      } else {
        // A quarentena falhou (pasta sem permissão, disco cheio, arquivo preso) ou o arquivo já não
        // estava lá. A remoção está gravada e as referências saíram, mas o arquivo continuaria
        // servido pela URL até o expurgo de órfãos: sai de vez agora, e a contestação aceita avisa
        // que a imagem não pôde ser recuperada (como sem arquivo anotado na remoção).
        fileRemoved = await afterCommit(
          'remoção do arquivo (quarentena falhou)',
          ctx,
          () => deleteMediaImage(key),
          false,
        );
        if (fileRemoved) {
          logger.warn(
            { ...ctx, key },
            'moderação: quarentena falhou; arquivo apagado de vez, a contestação não o recupera',
          );
        }
      }
    } else if (key) {
      fileRemoved = await afterCommit(
        'remoção do arquivo',
        ctx,
        () => deleteMediaImage(key),
        false,
      );
    }

    let strikes: StrikeSummary | null = null;
    let accountReviewOpened = false;
    if (owner && removalId !== null) {
      const followUp = await ownerFollowUp(adminId, owner.owner_id, ctx);
      ({ strikes, accountReviewOpened } = followUp);
      const counted = followUp.strikes;
      const zone = await zoneOf(owner.owner_id);
      await afterCommit(
        'aviso ao dono',
        ctx,
        () =>
          notificationsService.notify(owner.owner_id, {
            type: 'content_removed',
            title:
              report.target_type === 'avatar'
                ? 'Sua foto de perfil foi removida'
                : owner.title
                  ? `A imagem do trabalho “${owner.title}” foi removida`
                  : 'Uma imagem do seu portfólio foi removida',
            body: [
              `A moderação removeu a imagem por ${REASON_TEXT[report.reason] ?? REASON_TEXT.other}.`,
              note,
              print ? 'A mesma imagem não pode ser enviada de novo.' : null,
              appealLine(followUp.policy, followUp.now, zone),
              counted?.uploadsBlockedUntil
                ? `Como é a ${counted.imageStrikes}ª imagem removida nos últimos ${counted.windowDays} dias, o envio de imagens fica bloqueado até ${formatDateTime(new Date(counted.uploadsBlockedUntil), zone)}.`
                : null,
            ]
              .filter(Boolean)
              .join(' '),
            data: { contentRemoved: report.target_type, reportId, removalId },
          }),
        undefined,
      );
    }
    return {
      target,
      result: {
        status: 'actioned',
        reports,
        referencesCleared: cleared,
        fileRemoved,
        blocked: print !== null,
        removalId,
        ownerStrikes: strikes?.strikes ?? null,
        uploadsBlockedUntil: strikes?.uploadsBlockedUntil ?? null,
        accountReviewOpened,
      },
    };
  },
};
