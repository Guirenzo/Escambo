import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from '../config/logger';
import { captureError } from '../config/sentry';
import { HttpError } from '../utils/http-error';

/**
 * Tratamento global de erros (RNF-039): nunca expõe stack trace; resposta sempre em JSON.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    const { fieldErrors } = err.flatten();
    // Regra do objeto inteiro (refine sem path) não tem campo para apontar: a mensagem dela é que
    // explica a recusa, e não o texto genérico. Só a regra escrita por nós (custom): os outros
    // erros da raiz (chave desconhecida no .strict(), corpo que é lista ou que falta) trazem o
    // texto padrão do zod, em inglês, e ficam com a mensagem genérica.
    const rule =
      Object.keys(fieldErrors).length === 0
        ? err.issues.find((i) => i.path.length === 0 && i.code === 'custom')
        : undefined;
    res.status(422).json({
      error: 'validation_error',
      message: rule?.message ?? 'Dados de entrada inválidos',
      details: fieldErrors,
    });
    return;
  }

  // Erros do body-parser (express.json): JSON malformado ou corpo grande demais.
  const parseErr = err as { type?: string; status?: number };
  if (err instanceof SyntaxError && 'body' in err) {
    res
      .status(400)
      .json({ error: 'invalid_json', message: 'Corpo da requisição não é um JSON válido' });
    return;
  }
  if (parseErr.type === 'entity.too.large') {
    res
      .status(413)
      .json({ error: 'payload_too_large', message: 'Corpo da requisição excede o limite' });
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.statusCode).json({
      error: err.code ?? 'error',
      message: err.message,
    });
    return;
  }

  // Erro do cliente levantado pela camada HTTP (URL mal codificada, charset ou encoding do corpo
  // que não existe, envio interrompido): responde o 4xx que ela indica. Não é falha do servidor.
  const fromHttpLayer = (err as { expose?: unknown }).expose === true || err instanceof URIError;
  const status = parseErr.status;
  if (fromHttpLayer && typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: 'bad_request', message: 'Requisição inválida' });
    return;
  }

  logger.error({ err }, 'erro não tratado');
  captureError(err);
  res.status(500).json({ error: 'internal_error', message: 'Erro interno do servidor' });
};
