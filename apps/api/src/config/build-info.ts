import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from './env';

/** Versão do package.json da API (src/config e dist/config têm a mesma profundidade). */
function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Identidade do build, exposta em GET /api/health e no log de subida: versão (package.json)
 * e commit (GIT_SHA, gravado na imagem pelo CI; "dev" fora dela). Permite conferir, num
 * ambiente, exatamente qual código está no ar.
 */
export const buildInfo = Object.freeze({
  version: packageVersion(),
  commit: env.GIT_SHA,
});
