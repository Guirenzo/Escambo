import type { ContentReport, ReportReason, ReportTargetType } from '@escambo/types';
import { HttpError } from '../../utils/http-error';
import { reportsRepository, type ContentReportRow } from './reports.repository';
import { isImageTarget, type CreateReportInput } from './reports.schema';

function toReport(r: ContentReportRow): ContentReport {
  return {
    id: r.id,
    targetType: r.target_type as ReportTargetType,
    targetId: r.target_id,
    reason: r.reason as ReportReason,
    status: r.status,
    imageUrl: r.image_url,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export const reportsService = {
  /**
   * Registra a denúncia. Para imagem (ADR 39), a API lê o alvo e guarda o endereço da imagem como
   * está agora, sem confiar no que o cliente mandou; recusa alvo sem imagem, a própria imagem e a
   * mesma denúncia repetida enquanto a primeira não foi analisada.
   */
  async create(reporterId: number, input: CreateReportInput): Promise<ContentReport> {
    let imageUrl: string | null = null;
    if (isImageTarget(input.targetType)) {
      const target = await reportsRepository.imageTarget(input.targetType, input.targetId);
      if (!target) throw new HttpError(404, 'Imagem não encontrada', 'report_target_not_found');
      if (!target.image_url) {
        throw new HttpError(
          422,
          'Este perfil ou trabalho não tem imagem para denunciar',
          'report_target_without_image',
        );
      }
      if (target.owner_id === reporterId) {
        throw new HttpError(
          422,
          'Você não pode denunciar a sua própria imagem',
          'cannot_report_own_content',
        );
      }
      const repeated = await reportsRepository.hasPending(
        reporterId,
        input.targetType,
        input.targetId,
        target.image_url,
      );
      if (repeated) {
        throw new HttpError(
          409,
          'Você já denunciou esta imagem; a moderação vai analisar',
          'already_reported',
        );
      }
      imageUrl = target.image_url;
    }
    const id = await reportsRepository.create({
      reporterId,
      targetType: input.targetType,
      targetId: input.targetId,
      imageUrl,
      reason: input.reason,
      description: input.description?.trim() || null,
    });
    return {
      id,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      status: 'pending',
      imageUrl,
      createdAt: new Date().toISOString(),
    };
  },

  async listMine(reporterId: number): Promise<ContentReport[]> {
    return (await reportsRepository.listForReporter(reporterId)).map(toReport);
  },
};
