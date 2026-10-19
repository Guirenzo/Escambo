export interface HttpErrorPublicData {
  opensAt?: string | null;
  contractId?: number;
}

/**
 * Erro de domínio com status HTTP. O error-handler converte em resposta JSON padronizada.
 */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
    /** A borda HTTP valida e publica somente os campos explicitamente permitidos. */
    public readonly publicData?: HttpErrorPublicData,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
