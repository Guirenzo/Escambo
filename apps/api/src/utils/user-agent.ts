/** Tamanho da coluna user_agent (user_sessions, lgpd_consents e audit_logs). */
export const USER_AGENT_MAX = 512;

/**
 * User-Agent cortado no tamanho da coluna: o cabeçalho não tem limite, e com o sql_mode estrito
 * do MySQL um valor maior derrubaria a gravação (Data too long): o login, o refresh, o aceite de um
 * documento e a linha da auditoria.
 */
export const userAgentOf = (ua: string | null | undefined): string | null =>
  ua == null ? null : ua.slice(0, USER_AGENT_MAX);
