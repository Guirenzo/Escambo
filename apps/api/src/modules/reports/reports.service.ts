import type { ContentReport, ReportReason, ReportTargetType } from '@escambo/types';
import { reportsRepository, type ContentReportRow } from './reports.repository';
import type { CreateReportInput } from './reports.schema';

function toReport(r: ContentReportRow): ContentReport {
  return {
    id: r.id,
    targetType: r.target_type as ReportTargetType,
    targetId: r.target_id,
    reason: r.reason as ReportReason,
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export const reportsService = {
  async create(reporterId: number, input: CreateReportInput): Promise<ContentReport> {
    const id = await reportsRepository.create({
      reporterId,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      description: input.description ?? null,
    });
    return {
      id,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
  },

  async listMine(reporterId: number): Promise<ContentReport[]> {
    return (await reportsRepository.listForReporter(reporterId)).map(toReport);
  },
};
