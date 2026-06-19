/**
 * Erro de domínio com status HTTP. O error-handler converte em resposta JSON padronizada.
 */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
