import type { RequestHandler } from 'express';
import multer from 'multer';
import { env } from '../config/env';
import { HttpError } from '../utils/http-error';

/** Limite de um anexo, em bytes (UPLOAD_MAX_MB). O nginx do web precisa aceitar pelo menos isso. */
export const MAX_UPLOAD_BYTES = env.UPLOAD_MAX_MB * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5, fieldSize: 4096 },
});

/**
 * Lê UM arquivo do campo `field` de um multipart/form-data (fica em req.file, em memória) e
 * os demais campos de texto em req.body. Erros do multer viram HttpError com código estável;
 * requisição que não é multipart passa direto (o controller decide se o arquivo era obrigatório).
 */
export function singleFile(field: string): RequestHandler {
  const parse = upload.single(field);
  return (req, res, next) => {
    parse(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(
            new HttpError(
              413,
              `Arquivo maior que o limite de ${env.UPLOAD_MAX_MB} MB`,
              'file_too_large',
            ),
          );
        }
        return next(
          new HttpError(
            422,
            `Envio inválido: esperado um único arquivo no campo "${field}"`,
            'invalid_upload',
          ),
        );
      }
      next(err);
    });
  };
}
