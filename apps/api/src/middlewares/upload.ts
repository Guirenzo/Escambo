import type { RequestHandler } from 'express';
import multer from 'multer';
import { env } from '../config/env';
import { HttpError } from '../utils/http-error';

/** Limite padrão de um anexo, em bytes (UPLOAD_MAX_MB). O nginx do web aceita até 25 MB. */
export const MAX_UPLOAD_BYTES = env.UPLOAD_MAX_MB * 1024 * 1024;

/** Campos de texto que acompanham o arquivo: quantos e de que tamanho (em bytes) cada um. */
const MAX_FIELDS = 5;
const MAX_FIELD_BYTES = 4096;

const mb = (bytes: number): string =>
  `${Math.round((bytes / 1024 / 1024) * 10) / 10}`.replace('.', ',');

/** Mensagem de cada recusa do multer: o que passou do limite, e não sempre "um único arquivo". */
function multerMessage(err: multer.MulterError, field: string): string {
  switch (err.code) {
    case 'LIMIT_FIELD_VALUE': // o multer sempre informa o campo nesta recusa
      return `Envio inválido: o campo "${err.field}" passa de ${MAX_FIELD_BYTES} bytes`;
    case 'LIMIT_FIELD_COUNT':
      return `Envio inválido: no máximo ${MAX_FIELDS} campos de texto junto do arquivo`;
    default:
      return `Envio inválido: esperado um único arquivo no campo "${field}"`;
  }
}

/**
 * Lê UM arquivo do campo `field` de um multipart/form-data (fica em req.file, em memória) e os
 * demais campos de texto em req.body, com limite de tamanho por rota (anexo do chat, imagem de
 * perfil). Erros do multer viram HttpError com código estável; requisição que não é multipart
 * passa direto (o controller decide se o arquivo era obrigatório).
 */
export function singleFile(field: string, maxBytes: number = MAX_UPLOAD_BYTES): RequestHandler {
  const parse = multer({
    storage: multer.memoryStorage(),
    // O busboy corta o campo ao ATINGIR o fieldSize: com +1, um campo de exatamente
    // MAX_FIELD_BYTES passa e o primeiro byte além dele é recusado.
    limits: { fileSize: maxBytes, files: 1, fields: MAX_FIELDS, fieldSize: MAX_FIELD_BYTES + 1 },
    // Nome de arquivo com acento chega em UTF-8 (navegadores); o padrão do busboy é latin1.
    defParamCharset: 'utf8',
  }).single(field);
  return (req, res, next) => {
    parse(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(
            new HttpError(
              413,
              `Arquivo maior que o limite de ${mb(maxBytes)} MB`,
              'file_too_large',
            ),
          );
        }
        return next(new HttpError(422, multerMessage(err, field), 'invalid_upload'));
      }
      // Fora do multer, o erro vem da leitura do corpo (busboy): multipart cortado no meio, sem
      // boundary, cabeçalho de parte malformado, envio interrompido. É do cliente, e não 500.
      // O armazenamento é em memória e não há filtro de arquivo, então não há falha do servidor aqui.
      next(
        new HttpError(
          400,
          'Envio inválido: o formulário multipart está malformado ou incompleto',
          'invalid_upload',
        ),
      );
    });
  };
}
