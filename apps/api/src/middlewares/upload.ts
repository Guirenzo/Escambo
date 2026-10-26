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
function multerMessage(
  err: multer.MulterError,
  field: string,
  limits: { fields: number; fieldBytes: number; files?: number } = {
    fields: MAX_FIELDS,
    fieldBytes: MAX_FIELD_BYTES,
  },
): string {
  if (err.code === 'LIMIT_FIELD_VALUE') {
    // o multer sempre informa o campo nesta recusa
    return `Envio inválido: o campo "${err.field}" passa de ${limits.fieldBytes} bytes`;
  }
  if (err.code === 'LIMIT_FIELD_COUNT') {
    return `Envio inválido: no máximo ${limits.fields} campos de texto junto do arquivo`;
  }
  if (!limits.files) return `Envio inválido: esperado um único arquivo no campo "${field}"`;
  // Arquivo além do máximo: o busboy recusa pela contagem, ou o multer pelo máximo do campo.
  return err.code === 'LIMIT_FILE_COUNT' ||
    (err.code === 'LIMIT_UNEXPECTED_FILE' && err.field === field)
    ? `Envie no máximo ${limits.files} arquivos de uma vez`
    : `Envio inválido: os arquivos vão no campo "${field}"`;
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
    // O busboy corta o campo ao ATINGIR o fieldSize; desde a 2.5 o multer já passa +1 a ele,
    // então um campo de exatamente MAX_FIELD_BYTES passa e o primeiro byte além é recusado.
    limits: { fileSize: maxBytes, files: 1, fields: MAX_FIELDS, fieldSize: MAX_FIELD_BYTES },
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

/**
 * Vários arquivos do mesmo campo (a entrega com arquivos, RF-035), em memória em req.files, com as
 * recusas de singleFile e um teto para a soma: um Content-Length que já passa dele (com folga para
 * os campos de texto) é recusado sem guardar nada em memória, e a soma lida é conferida no fim, para
 * o envio sem Content-Length. Requisição que não é multipart passa direto, sem req.files.
 */
export function fileArray(
  field: string,
  opts: {
    maxCount: number;
    maxTotalBytes: number;
    maxBytes?: number;
    fields?: number;
    fieldBytes?: number;
  },
): RequestHandler {
  const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES;
  const limits = {
    fields: opts.fields ?? MAX_FIELDS,
    fieldBytes: opts.fieldBytes ?? MAX_FIELD_BYTES,
    files: opts.maxCount,
  };
  const parse = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: maxBytes,
      files: opts.maxCount,
      fields: limits.fields,
      fieldSize: limits.fieldBytes,
    },
    defParamCharset: 'utf8',
  }).array(field, opts.maxCount);
  const tooLarge = (): HttpError =>
    new HttpError(413, `Os arquivos somam mais de ${mb(opts.maxTotalBytes)} MB`, 'files_too_large');
  // Fronteiras do multipart e cabeçalhos de cada parte, além dos campos de texto.
  const slack = limits.fields * limits.fieldBytes + 64 * 1024;
  return (req, res, next) => {
    const declared = Number(req.headers['content-length']);
    if (req.is('multipart/form-data') && declared > opts.maxTotalBytes + slack) {
      // O corpo é lido e descartado antes da resposta: responder no meio do envio derruba a
      // conexão, e quem enviou veria um erro de rede em vez do 413 com o motivo.
      let answered = false;
      const answer = (): void => {
        if (answered) return;
        answered = true;
        next(tooLarge());
      };
      req.once('end', answer);
      req.once('close', answer);
      req.once('error', answer);
      req.resume();
      return;
    }
    parse(req, res, (err: unknown) => {
      if (!err) {
        const files = (req.files as Express.Multer.File[] | undefined) ?? [];
        return files.reduce((sum, f) => sum + f.size, 0) > opts.maxTotalBytes
          ? next(tooLarge())
          : next();
      }
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
        return next(new HttpError(422, multerMessage(err, field, limits), 'invalid_upload'));
      }
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
