import type { RequestHandler } from 'express';
import multer from 'multer';
import { env } from '../config/env';
import { HttpError } from '../utils/http-error';

/** Limite padrão de um anexo, em bytes (UPLOAD_MAX_MB). O nginx do web aceita até 25 MB. */
export const MAX_UPLOAD_BYTES = env.UPLOAD_MAX_MB * 1024 * 1024;

const mb = (bytes: number): string =>
  `${Math.round((bytes / 1024 / 1024) * 10) / 10}`.replace('.', ',');

/**
 * Lê UM arquivo do campo `field` de um multipart/form-data (fica em req.file, em memória) e os
 * demais campos de texto em req.body, com limite de tamanho por rota (anexo do chat, imagem de
 * perfil). Erros do multer viram HttpError com código estável; requisição que não é multipart
 * passa direto (o controller decide se o arquivo era obrigatório).
 */
export function singleFile(field: string, maxBytes: number = MAX_UPLOAD_BYTES): RequestHandler {
  const parse = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 5, fieldSize: 4096 },
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
