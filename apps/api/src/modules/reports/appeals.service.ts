import type {
  AdminAppeal,
  AdminAppealDecisionResult,
  AppealDecision,
  ContentRemoval,
  MyModeration,
  ReportReason,
} from '@escambo/types';
import { logger } from '../../config/logger';
import { HttpError } from '../../utils/http-error';
import type { ImageRef } from '../media/media.repository';
import { mediaKeyFromUrl } from '../media/media.paths';
import { messagingService } from '../messaging/messaging.service';
import {
  deleteQuarantined,
  quarantineFilePath,
  quarantineMediaImage,
  restoreQuarantined,
} from '../media/media.storage';
import { notificationsService } from '../notifications/notifications.service';
import { contentRemovalsRepository, type ContentRemovalRow } from './content-removals.repository';
import { appealDeadline, DAY_MS, strikePolicy, strikeSummary } from './moderation.strikes';
import { isTextTarget } from './reports.schema';

/**
 * Contestação de remoção (ADR 41 e 44). O dono contesta uma vez, dentro do prazo, pelo perfil;
 * o admin mantém ou reverte. Avaliação e mensagem revertidas voltam ao ar (a avaliação à nota
 * média), e a mensagem avisa o chat. Para imagem, reverter devolve o arquivo da quarentena,
 * recoloca a imagem onde ela estava (se o lugar continua vazio) e a tira da lista de bloqueio. Em
 * todo caso, a remoção revertida deixa de contar como ocorrência. Manter apaga o arquivo da
 * quarentena.
 */

export const APPEAL_MIN_CHARS = 20;
const QUARANTINE_BATCH = 500;

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

export function removalLabel(r: { target_type: string; work_title: string | null }): string {
  switch (r.target_type) {
    case 'avatar':
      return 'Foto de perfil';
    case 'review':
      return 'Avaliação';
    case 'message':
      return 'Mensagem no chat';
    default:
      return r.work_title ? `Imagem do trabalho “${r.work_title}”` : 'Imagem do portfólio';
  }
}

function parseRefs(value: unknown): ImageRef[] {
  if (Array.isArray(value)) return value as ImageRef[];
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as ImageRef[]) : [];
  } catch {
    return [];
  }
}

/**
 * Apaga o arquivo da quarentena e só então marca a remoção como expurgada. Devolve se o arquivo
 * saiu (apagado agora ou já fora do disco). Erro de disco fica no log e a linha continua na lista
 * do expurgo para a próxima rodada: o banco nunca diz que saiu um arquivo que continua lá.
 */
async function purgeFile(id: number, file: string): Promise<boolean> {
  let gone: boolean;
  try {
    gone = await deleteQuarantined(file);
  } catch (err) {
    logger.warn(
      { err, removalId: id, file },
      'quarentena: arquivo não apagado, fica para a próxima rodada',
    );
    return false;
  }
  if (gone) await contentRemovalsRepository.markFilePurged(id);
  return gone;
}

/**
 * Reversão que falhou depois de o arquivo voltar para a pasta pública: ele volta para a quarentena,
 * com o mesmo nome (<id da remoção>.<ext>), e a remoção segue contestada como estava. Se nem isso
 * der certo, fica no log.
 */
async function requarantine(id: number, key: string): Promise<void> {
  let name: string | null = null;
  let error: unknown;
  try {
    name = await quarantineMediaImage(key, id);
  } catch (err) {
    error = err;
  }
  if (!name) {
    logger.error(
      { err: error, removalId: id, key },
      'reversão não gravada e o arquivo não voltou para a quarentena',
    );
  }
}

function toRemoval(r: ContentRemovalRow, appealWindowDays: number, now: Date): ContentRemoval {
  const deadline = appealDeadline(r.removed_at, appealWindowDays);
  return {
    id: r.id,
    targetType: r.target_type,
    label: removalLabel(r),
    excerpt: r.content_snapshot,
    reason: r.reason as ReportReason,
    note: r.note,
    removedAt: iso(r.removed_at)!,
    status: r.status,
    appealDeadline: deadline.toISOString(),
    canAppeal: r.status === 'removed' && now.getTime() <= deadline.getTime(),
    appealText: r.appeal_text,
    appealedAt: iso(r.appealed_at),
    decidedAt: iso(r.decided_at),
    decisionNote: r.decision_note,
  };
}

export const appealsService = {
  /** O que o dono vê no perfil: as remoções dele e a situação de reincidência. */
  async mine(ownerId: number, now: Date = new Date()): Promise<MyModeration> {
    const policy = await strikePolicy();
    const [rows, strikes] = await Promise.all([
      contentRemovalsRepository.listForOwner(ownerId),
      strikeSummary(ownerId, now, policy),
    ]);
    return {
      removals: rows.map((r) => toRemoval(r, policy.appealWindowDays, now)),
      strikes,
    };
  },

  async appeal(
    ownerId: number,
    id: number,
    text: string,
    now: Date = new Date(),
  ): Promise<ContentRemoval> {
    const row = await contentRemovalsRepository.findById(id);
    if (!row || row.owner_id !== ownerId) {
      throw new HttpError(404, 'Remoção não encontrada', 'removal_not_found');
    }
    if (row.status !== 'removed') {
      throw new HttpError(409, 'Esta remoção já foi contestada', 'appeal_exists');
    }
    const { appealWindowDays } = await strikePolicy();
    if (now.getTime() > appealDeadline(row.removed_at, appealWindowDays).getTime()) {
      throw new HttpError(
        410,
        'O prazo para contestar esta remoção terminou',
        'appeal_window_closed',
      );
    }
    if (!(await contentRemovalsRepository.appeal(id, ownerId, text))) {
      throw new HttpError(409, 'Esta remoção já foi contestada', 'appeal_exists');
    }
    return toRemoval((await contentRemovalsRepository.findById(id))!, appealWindowDays, now);
  },

  async listForAdmin(scope: 'pending' | 'decided'): Promise<AdminAppeal[]> {
    const policy = await strikePolicy();
    const rows = await contentRemovalsRepository.listAppeals(scope, 200);
    const strikes = new Map<number, number>();
    for (const ownerId of new Set(rows.map((r) => r.owner_id))) {
      strikes.set(ownerId, (await strikeSummary(ownerId, new Date(), policy)).strikes);
    }
    return rows.map((r) => ({
      id: r.id,
      owner: { id: r.owner_id, ulid: r.owner_ulid, name: r.owner_name },
      targetType: r.target_type,
      label: removalLabel(r),
      excerpt: r.content_snapshot,
      reason: r.reason as ReportReason,
      note: r.note,
      removedAt: iso(r.removed_at)!,
      imageUrl: r.image_url,
      appealText: r.appeal_text ?? '',
      appealedAt: iso(r.appealed_at)!,
      status: r.status as AdminAppeal['status'],
      decidedAt: iso(r.decided_at),
      decisionNote: r.decision_note,
      hasImage: r.quarantine_file !== null && r.file_purged_at === null,
      ownerStrikes: strikes.get(r.owner_id) ?? 0,
    }));
  },

  /** Caminho do arquivo em quarentena, para o admin ver a imagem antes de decidir. */
  async quarantineImage(id: number): Promise<string> {
    const row = await contentRemovalsRepository.findById(id);
    const abs =
      row?.quarantine_file && !row.file_purged_at ? quarantineFilePath(row.quarantine_file) : null;
    if (!abs) throw new HttpError(404, 'Imagem não disponível', 'removal_image_not_found');
    return abs;
  },

  async decide(
    adminId: number,
    id: number,
    decision: AppealDecision,
    note: string | null,
  ): Promise<AdminAppealDecisionResult> {
    const row = await contentRemovalsRepository.findById(id);
    if (!row) throw new HttpError(404, 'Remoção não encontrada', 'removal_not_found');
    if (row.status !== 'appealed') {
      throw new HttpError(409, 'Esta contestação não está esperando decisão', 'appeal_not_pending');
    }
    const label = removalLabel(row);

    if (decision === 'uphold') {
      if (!(await contentRemovalsRepository.uphold(id, adminId, note))) {
        throw new HttpError(
          409,
          'Esta contestação não está esperando decisão',
          'appeal_not_pending',
        );
      }
      const fileDeleted =
        row.quarantine_file && !row.file_purged_at
          ? await purgeFile(id, row.quarantine_file)
          : false;
      await notificationsService.notify(row.owner_id, {
        type: 'appeal_decided',
        title: 'Contestação analisada: a remoção foi mantida',
        body: [`${label} continua fora do ar.`, note].filter(Boolean).join(' '),
        data: { removalId: id, decision: 'upheld' },
      });
      return {
        status: 'upheld',
        restoredReferences: 0,
        imageRestored: false,
        contentRestored: false,
        fileDeleted,
      };
    }

    if (isTextTarget(row.target_type)) {
      const { decided, restored } = await contentRemovalsRepository.overturnContent({
        id,
        adminId,
        note,
        targetType: row.target_type,
        targetId: row.target_id,
      });
      if (!decided) {
        throw new HttpError(
          409,
          'Esta contestação não está esperando decisão',
          'appeal_not_pending',
        );
      }
      const back = restored > 0;
      const where =
        row.target_type === 'review'
          ? 'Sua avaliação voltou ao perfil do freelancer'
          : 'Sua mensagem voltou ao chat';
      await notificationsService.notify(row.owner_id, {
        type: 'appeal_decided',
        title: back ? 'Contestação aceita: seu conteúdo voltou' : 'Contestação aceita',
        body: [
          back
            ? `${where} e a remoção deixou de contar como ocorrência.`
            : 'A remoção foi revertida e deixou de contar como ocorrência.',
          note,
        ]
          .filter(Boolean)
          .join(' '),
        data: { removalId: id, decision: 'overturned' },
      });
      if (row.target_type === 'message' && back) {
        await messagingService.announceChange(row.target_id).catch(() => undefined);
      }
      return {
        status: 'overturned',
        restoredReferences: restored,
        imageRestored: false,
        contentRestored: back,
        fileDeleted: false,
      };
    }

    // O arquivo volta antes: a imagem nunca é recolocada apontando para um arquivo que não existe.
    const url = row.image_url ?? '';
    const key = mediaKeyFromUrl(url);
    const external = key === null;
    const fileBack =
      !external && row.quarantine_file !== null && row.file_purged_at === null
        ? await restoreQuarantined(row.quarantine_file, key)
        : false;
    let overturned: { decided: boolean; restored: number };
    try {
      overturned = await contentRemovalsRepository.overturn({
        id,
        adminId,
        note,
        url,
        refs: parseRefs(row.cleared_refs),
        blocklistId: row.blocklist_id,
        restoreRefs: fileBack || external,
        fileBack,
      });
    } catch (err) {
      // A reversão não foi gravada: o arquivo volta para a quarentena. Senão a imagem removida
      // ficaria no ar pela URL antiga, e a nova tentativa já não acharia o arquivo para devolver.
      if (fileBack) await requarantine(id, key!);
      throw err;
    }
    const { decided, restored } = overturned;
    // Outra decisão chegou antes: o arquivo devolvido fica sem uso e sai no expurgo de órfãos.
    if (!decided) {
      throw new HttpError(409, 'Esta contestação não está esperando decisão', 'appeal_not_pending');
    }
    const imageRestored = restored > 0;
    const outcome = imageRestored
      ? `${label} voltou ao seu perfil e a remoção deixou de contar como ocorrência.`
      : fileBack || external
        ? 'A remoção foi revertida e deixou de contar como ocorrência. Como você já tinha colocado outra imagem no lugar, a antiga não foi recolocada.'
        : 'A remoção foi revertida e deixou de contar como ocorrência. A imagem não pôde ser recuperada; envie de novo pelo perfil.';
    await notificationsService.notify(row.owner_id, {
      type: 'appeal_decided',
      title: imageRestored ? 'Contestação aceita: sua imagem voltou' : 'Contestação aceita',
      body: [outcome, note].filter(Boolean).join(' '),
      data: { removalId: id, decision: 'overturned' },
    });
    return {
      status: 'overturned',
      restoredReferences: restored,
      imageRestored,
      contentRestored: imageRestored,
      fileDeleted: false,
    };
  },

  /** Apaga da quarentena o que já não pode voltar: remoção mantida ou prazo vencido sem contestação. */
  async purgeQuarantine(now: Date = new Date()): Promise<number> {
    const { appealWindowDays } = await strikePolicy();
    const cutoff = new Date(now.getTime() - appealWindowDays * DAY_MS);
    const rows = await contentRemovalsRepository.listQuarantineToPurge(cutoff, QUARANTINE_BATCH);
    let purged = 0;
    for (const r of rows) if (await purgeFile(r.id, r.quarantine_file!)) purged++;
    return purged;
  },

  /** Titular anonimizado (LGPD): os arquivos dele saem da quarentena na hora. */
  async purgeForOwner(ownerId: number): Promise<number> {
    const rows = await contentRemovalsRepository.listQuarantinedForOwner(ownerId);
    let purged = 0;
    for (const r of rows) if (await purgeFile(r.id, r.quarantine_file!)) purged++;
    return purged;
  },
};
