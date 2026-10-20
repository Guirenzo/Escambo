/**
 * Retenção da auditoria (RNF-037): cada linha do audit_logs fica no banco por no mínimo 90 dias.
 *
 * É a constante única do prazo. O trigger trg_audit_logs_retention (migration 0046) recusa no
 * banco o DELETE de linha mais nova que isso; o env.ts não aceita AUDIT_LOG_PURGE_DAYS menor; e o
 * audit.retention.test confere que nenhum código apaga a auditoria (ou os extratos) fora do
 * expurgo, e que o trigger usa este mesmo número.
 */
export const AUDIT_LOG_MIN_RETENTION_DAYS = 90;

/** Linhas por DELETE do expurgo: lotes curtos não seguram o índice de created_at por muito tempo. */
export const AUDIT_LOG_PURGE_BATCH = 1000;

/** Teto de lotes por rodada dos jobs; o que sobrar sai na rodada seguinte. */
export const AUDIT_LOG_PURGE_MAX_BATCHES = 50;
