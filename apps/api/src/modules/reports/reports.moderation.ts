import type {
  AdminReportActionResult,
  AdminReportGroup,
  ReportReason,
  ReportStatus,
  ReportTargetType,
  StrikeSummary,
} from '@escambo/types';
import { HttpError } from '../../utils/http-error';
import { fingerprint } from '../media/media.image';
import { mediaKeyFromUrl } from '../media/media.paths';
import { deleteMediaImage, quarantineMediaImage, readMediaFile } from '../media/media.storage';
import { messagingService } from '../messaging/messaging.service';
import { notificationsService } from '../notifications/notifications.service';
import { contentRemovalsRepository } from './content-removals.repository';
import { appealDeadline, brDateTime, strikePolicy, strikeSummary } from './moderation.strikes';
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
    const policy = await strikePolicy();
    const now = new Date();
    strikes = await strikeSummary(author.id, now, policy);
    accountReviewOpened = await openAccountReview(
      adminId,
      author.id,
      strikes,
      policy.reviewThreshold,
    );
    await notificationsService.notify(author.id, {
      type: 'content_removed',
      title:
        type === 'review' ? 'Sua avaliação foi removida' : 'Uma mensagem sua no chat foi removida',
      body: [
        `A moderação removeu ${type === 'review' ? 'a avaliação' : 'a mensagem'} por ${REASON_TEXT[report.reason] ?? REASON_TEXT.other}.`,
        group.note,
        `Se discordar, conteste pelo seu perfil até ${brDateTime(appealDeadline(now, policy.appealWindowDays))}.`,
      ]
        .filter(Boolean)
        .join(' '),
      data: { contentRemoved: type, reportId, removalId },
    });
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

    // Com registro, o arquivo vai para a quarentena enquanto cabe contestação; sem dono, sai de vez.
    let fileRemoved = false;
    if (key && removalId !== null) {
      const quarantined = await quarantineMediaImage(key, removalId);
      if (quarantined) await contentRemovalsRepository.setQuarantineFile(removalId, quarantined);
      fileRemoved = quarantined !== null;
    } else if (key) {
      fileRemoved = await deleteMediaImage(key);
    }

    let strikes: StrikeSummary | null = null;
    let accountReviewOpened = false;
    if (owner && removalId !== null) {
      const policy = await strikePolicy();
      const now = new Date();
      strikes = await strikeSummary(owner.owner_id, now, policy);
      accountReviewOpened = await openAccountReview(
        adminId,
        owner.owner_id,
        strikes,
        policy.reviewThreshold,
      );
      await notificationsService.notify(owner.owner_id, {
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
          `Se discordar, conteste pelo seu perfil até ${brDateTime(appealDeadline(now, policy.appealWindowDays))}.`,
          strikes.uploadsBlockedUntil
            ? `Como é a ${strikes.imageStrikes}ª imagem removida nos últimos ${strikes.windowDays} dias, o envio de imagens fica bloqueado até ${brDateTime(new Date(strikes.uploadsBlockedUntil))}.`
            : null,
        ]
          .filter(Boolean)
          .join(' '),
        data: { contentRemoved: report.target_type, reportId, removalId },
      });
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
