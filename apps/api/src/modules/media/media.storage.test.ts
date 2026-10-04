import { existsSync, type PathLike, type Stats } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../config/env';
import type { DetectedType } from '../messaging/attachments.storage';
import { makeVariant } from './media.image';
import { MEDIA_URL_RE } from './media.paths';
import {
  deleteMediaImage,
  deleteQuarantined,
  MEDIA_MAX_BYTES,
  MEDIA_ORPHAN_GRACE_MS,
  mediaDir,
  mediaFilePath,
  mediaUsage,
  mediaVariantPath,
  quarantineDir,
  quarantineFilePath,
  quarantineMediaImage,
  readMediaFile,
  removeMediaOrphans,
  restoreQuarantined,
  saveMedia,
} from './media.storage';

const { listReferencedUrls } = vi.hoisted(() => ({ listReferencedUrls: vi.fn() }));
// Quem usa cada imagem vem do banco: aqui é uma lista dada pelo teste.
vi.mock('./media.repository', () => ({ mediaRepository: { listReferencedUrls } }));
// A sharp de verdade gera as miniaturas; o espião só conta as gerações e deixa simular a corrida.
vi.mock('./media.image', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./media.image')>();
  return { ...actual, makeVariant: vi.fn(actual.makeVariant) };
});
// Disco de verdade (pasta temporária); rename, stat e unlink passam direto, salvo quando o teste
// simula a falha que só acontece com dois pedidos ao mesmo tempo ou com um arquivo preso.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    stat: vi.fn(actual.stat),
    unlink: vi.fn(actual.unlink),
  };
});
// O ULID de verdade, salvo quando o teste precisa do nome exato.
vi.mock('ulid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ulid')>();
  return { ...actual, ulid: vi.fn(actual.ulid) };
});

const A = '01J8ZQ4K7M3VX5R2T9W6Y1B0CA';
const B = '01J8ZQ4K7M3VX5R2T9W6Y1B0CB';
const C = '01J8ZQ4K7M3VX5R2T9W6Y1B0CC';
const WEBP: DetectedType = { mime: 'image/webp', ext: 'webp', kind: 'image', names: ['webp'] };
const HOUR_MS = 3_600_000;

const originalDataDir = env.DATA_DIR;
let dir: string;

/** Caminho em disco de uma chave de mídia, montado sem passar pelo código testado. */
const inMedia = (key: string): string => path.join(dir, 'media', ...key.split('/'));
const inQuarantine = (name: string): string => path.join(dir, 'quarantine', name);

/** Grava um arquivo na pasta de mídia; `ageHours` envelhece a data de modificação. */
async function put(key: string, bytes: Buffer | string = 'x', ageHours = 0): Promise<string> {
  const abs = inMedia(key);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
  if (ageHours > 0) {
    const at = new Date(Date.now() - ageHours * HOUR_MS);
    await utimes(abs, at, at);
  }
  return abs;
}

/** Todos os arquivos sob DATA_DIR, em ordem, com barra normal. */
async function tree(): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .sort();
}

const png = (width: number, height: number): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background: '#0a6b3f' } })
    .png()
    .toBuffer();

const fsError = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: simulado`), { code });

/**
 * A cada miniatura apagada, anota se o original de `key` ainda estava no disco naquele instante (o
 * unlink de verdade acontece do mesmo jeito).
 */
function originalWhenVariantsGo(key: string): boolean[] {
  const seen: boolean[] = [];
  vi.mocked(unlink).mockImplementation((async (p: PathLike) => {
    if (/\.w\d+\.webp$/.test(String(p))) seen.push(existsSync(inMedia(key)));
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return actual.unlink(p);
  }) as typeof unlink);
  return seen;
}

/**
 * Armazenamento das imagens de perfil e portfólio (ADR 36, 38, 39 e 41) contra uma pasta temporária:
 * onde cada arquivo vai parar, o que nunca sai da pasta de mídia, como a miniatura nasce e o que o
 * expurgo apaga.
 */
describe('armazenamento de mídia', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    listReferencedUrls.mockResolvedValue([]);
    dir = await mkdtemp(path.join(os.tmpdir(), 'escambo-media-'));
    env.DATA_DIR = dir;
  });
  afterEach(async () => {
    vi.useRealTimers();
    env.DATA_DIR = originalDataDir;
    await rm(dir, { recursive: true, force: true });
  });

  it('os limites: 5 MB por imagem e um dia de tolerância para a órfã', () => {
    expect(MEDIA_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(MEDIA_ORPHAN_GRACE_MS).toBe(24 * HOUR_MS);
  });

  describe('caminhos', () => {
    it('mídia e quarentena são pastas separadas dentro de DATA_DIR', () => {
      expect(mediaDir()).toBe(path.join(dir, 'media'));
      expect(quarantineDir()).toBe(path.join(dir, 'quarantine'));
    });

    it('uma chave válida vira o caminho absoluto dentro da pasta de mídia', () => {
      expect(mediaFilePath(`2026/09/${A}.png`)).toBe(inMedia(`2026/09/${A}.png`));
    });

    it('chave que tenta sair da pasta de mídia não vira caminho nenhum', () => {
      for (const bad of [
        '../segredo.png',
        '../../etc/passwd',
        `2026/../../quarantine/7.png`,
        // Pasta vizinha com o mesmo começo de nome: "media-outra" não é "media".
        '../media-outra/foto.png',
        path.join(dir, 'fora.png'),
        '',
        '.',
      ]) {
        expect(mediaFilePath(bad), JSON.stringify(bad)).toBeNull();
      }
    });

    it('na quarentena só o nome do arquivo vale: subpasta e ponto-ponto são descartados', () => {
      expect(quarantineFilePath('77.png')).toBe(inQuarantine('77.png'));
      expect(quarantineFilePath('../../etc/passwd')).toBe(inQuarantine('passwd'));
      expect(quarantineFilePath('sub/pasta/77.png')).toBe(inQuarantine('77.png'));
      for (const bad of ['', '.', '..']) {
        expect(quarantineFilePath(bad), JSON.stringify(bad)).toBeNull();
      }
    });
  });

  describe('saveMedia', () => {
    it('grava em AAAA/MM (UTC, mês com zero à esquerda) com um ULID e a extensão do tipo, e devolve a URL pública', async () => {
      // 23h30 de 31/12/2025 em Brasília já é janeiro de 2026 em UTC: a pasta segue o UTC, no ano
      // e no mês.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T02:30:00.000Z'));
      vi.mocked(ulid).mockReturnValueOnce(A);
      const bytes = Buffer.from('imagem já processada');

      const url = await saveMedia(bytes, WEBP);

      expect(url).toBe(`/api/media/2026/01/${A}.webp`);
      expect(await tree()).toEqual([`media/2026/01/${A}.webp`]);
      expect(await readFile(inMedia(`2026/01/${A}.webp`))).toEqual(bytes);

      // Mês de dois dígitos fica como é (dezembro é 12, não 11 nem 012).
      vi.setSystemTime(new Date('2026-12-15T12:00:00.000Z'));
      vi.mocked(ulid).mockReturnValueOnce(B);
      expect(await saveMedia(bytes, WEBP)).toBe(`/api/media/2026/12/${B}.webp`);
      expect(await tree()).toEqual([`media/2026/01/${A}.webp`, `media/2026/12/${B}.webp`]);
    });

    it('cada envio ganha um endereço novo, no formato que o perfil aceita', async () => {
      const first = await saveMedia(Buffer.from('a'), WEBP);
      const second = await saveMedia(Buffer.from('b'), { ...WEBP, ext: 'png' });

      expect(first).toMatch(MEDIA_URL_RE);
      expect(second).toMatch(MEDIA_URL_RE);
      expect(first.endsWith('.webp')).toBe(true);
      expect(second.endsWith('.png')).toBe(true);
      expect(first.slice(0, -5)).not.toBe(second.slice(0, -4));
      expect(await tree()).toHaveLength(2);
    });

    it('nunca escreve por cima de uma imagem que já existe', async () => {
      vi.mocked(ulid).mockReturnValue(A);
      await saveMedia(Buffer.from('a primeira'), WEBP);

      await expect(saveMedia(Buffer.from('a segunda'), WEBP)).rejects.toMatchObject({
        code: 'EEXIST',
      });

      const [only] = await tree();
      expect(await readFile(path.join(dir, only!))).toEqual(Buffer.from('a primeira'));
    });
  });

  describe('readMediaFile', () => {
    it('devolve os bytes do original', async () => {
      await put(`2026/09/${A}.png`, 'bytes do original');
      expect(await readMediaFile(`2026/09/${A}.png`)).toEqual(Buffer.from('bytes do original'));
    });

    it('imagem que já não existe: null, sem erro', async () => {
      expect(await readMediaFile(`2026/09/${A}.png`)).toBeNull();
    });

    it('não lê nada fora da pasta de mídia, mesmo que o arquivo exista', async () => {
      await writeFile(path.join(dir, 'segredo.txt'), 'senha');
      expect(await readMediaFile('../segredo.txt')).toBeNull();
    });
  });

  describe('deleteMediaImage (ADR 39)', () => {
    it('apaga o original e todas as miniaturas dele, e deixa as outras imagens', async () => {
      await put(`2026/09/${A}.png`);
      await put(`2026/09/${A}.w128.webp`);
      await put(`2026/09/${A}.w480.webp`);
      await put(`2026/09/${A}.w960.webp`);
      await put(`2026/09/${B}.png`);
      await put(`2026/09/${B}.w128.webp`);

      expect(await deleteMediaImage(`2026/09/${A}.png`)).toBe(true);

      expect(await tree()).toEqual([`media/2026/09/${B}.png`, `media/2026/09/${B}.w128.webp`]);
    });

    it('original que já não existia: devolve false, mas a miniatura que sobrou sai', async () => {
      await put(`2026/09/${A}.w480.webp`);

      expect(await deleteMediaImage(`2026/09/${A}.png`)).toBe(false);

      expect(await tree()).toEqual([]);
    });

    it('chave fora da pasta de mídia: false, e nada é apagado', async () => {
      await writeFile(path.join(dir, 'segredo.png'), 'fica');
      expect(await deleteMediaImage('../segredo.png')).toBe(false);
      expect(await tree()).toEqual(['segredo.png']);
    });

    it('o original sai antes das miniaturas: enquanto elas saem, uma leitura com ?w= já não acha a imagem para gerar outra', async () => {
      const key = `2026/09/${A}.png`;
      await put(key);
      await put(`2026/09/${A}.w128.webp`);
      await put(`2026/09/${A}.w480.webp`);
      const originalAtVariantUnlink = originalWhenVariantsGo(key);

      expect(await deleteMediaImage(key)).toBe(true);

      expect(originalAtVariantUnlink).toEqual([false, false, false]);
      expect(await tree()).toEqual([]);
    });
  });

  describe('quarentena (ADR 41)', () => {
    it('tira a imagem do ar: o original vai para a quarentena como <remoção>.<ext> e as miniaturas somem', async () => {
      await put(`2026/09/${A}.png`, 'original');
      await put(`2026/09/${A}.w128.webp`);
      await put(`2026/09/${A}.w960.webp`);
      await put(`2026/09/${B}.webp`, 'outra imagem');

      expect(await quarantineMediaImage(`2026/09/${A}.png`, 77)).toBe('77.png');

      expect(await tree()).toEqual([`media/2026/09/${B}.webp`, 'quarantine/77.png']);
      expect(await readFile(inQuarantine('77.png'))).toEqual(Buffer.from('original'));
    });

    it('o original vai para a quarentena antes de as miniaturas saírem (nenhuma nasce de novo no meio)', async () => {
      const key = `2026/09/${A}.png`;
      await put(key, 'original');
      await put(`2026/09/${A}.w128.webp`);
      const originalAtVariantUnlink = originalWhenVariantsGo(key);

      expect(await quarantineMediaImage(key, 77)).toBe('77.png');

      expect(originalAtVariantUnlink).toEqual([false, false, false]);
      expect(await tree()).toEqual(['quarantine/77.png']);
    });

    it('o nome na quarentena leva a extensão do original', async () => {
      await put(`2026/09/${A}.webp`);
      expect(await quarantineMediaImage(`2026/09/${A}.webp`, 5)).toBe('5.webp');
      expect(await tree()).toEqual(['quarantine/5.webp']);
    });

    it('original que já não existia: null, e a miniatura que sobrou sai mesmo assim', async () => {
      await put(`2026/09/${A}.w128.webp`);

      expect(await quarantineMediaImage(`2026/09/${A}.png`, 77)).toBeNull();

      expect(await tree()).toEqual([]);
    });

    it('chave fora da pasta de mídia: null, e o arquivo de fora fica onde está', async () => {
      await writeFile(path.join(dir, 'segredo.png'), 'fica');
      expect(await quarantineMediaImage('../segredo.png', 1)).toBeNull();
      expect(await tree()).toEqual(['segredo.png']);
    });

    it('remoção revertida: o arquivo volta para o endereço original, recriando a pasta do mês', async () => {
      await put(`2026/09/${A}.png`, 'original');
      await quarantineMediaImage(`2026/09/${A}.png`, 77);
      await rm(path.join(dir, 'media'), { recursive: true });

      expect(await restoreQuarantined('77.png', `2026/09/${A}.png`)).toBe(true);

      expect(await tree()).toEqual([`media/2026/09/${A}.png`]);
      expect(await readFile(inMedia(`2026/09/${A}.png`))).toEqual(Buffer.from('original'));
    });

    it('restaurar o que não está na quarentena, ou para uma chave inválida, devolve false e não move nada', async () => {
      await mkdir(path.join(dir, 'quarantine'), { recursive: true });
      await writeFile(inQuarantine('77.png'), 'guardado');

      expect(await restoreQuarantined('78.png', `2026/09/${A}.png`)).toBe(false);
      expect(await restoreQuarantined('77.png', '../fora.png')).toBe(false);
      expect(await restoreQuarantined('', `2026/09/${A}.png`)).toBe(false);

      expect(await tree()).toEqual(['quarantine/77.png']);
    });

    it('apagar da quarentena: true quando o arquivo saiu, apagado agora ou que já não existia; false só para nome que não é da quarentena', async () => {
      await mkdir(path.join(dir, 'quarantine'), { recursive: true });
      await writeFile(inQuarantine('77.png'), 'guardado');

      expect(await deleteQuarantined('77.png')).toBe(true);
      // Já não existe: o arquivo está fora do disco, então pode ser marcado como expurgado.
      expect(await deleteQuarantined('77.png')).toBe(true);
      expect(await deleteQuarantined('')).toBe(false);
      expect(await tree()).toEqual([]);
    });

    it('arquivo da quarentena que não pôde ser apagado (preso, sem permissão, erro de disco): LANÇA e o arquivo fica, para não ser marcado como expurgado', async () => {
      await mkdir(path.join(dir, 'quarantine'), { recursive: true });
      await writeFile(inQuarantine('77.png'), 'guardado');

      for (const code of ['EBUSY', 'EPERM', 'EACCES', 'EIO']) {
        const err = fsError(code);
        vi.mocked(unlink).mockRejectedValueOnce(err);
        await expect(deleteQuarantined('77.png'), code).rejects.toBe(err);
      }

      expect(await tree()).toEqual(['quarantine/77.png']);
      // Na rodada seguinte, com o disco de volta, sai.
      expect(await deleteQuarantined('77.png')).toBe(true);
      expect(await tree()).toEqual([]);
    });

    it('apagar da quarentena nunca alcança a pasta de mídia', async () => {
      await put(`2026/09/${A}.png`);
      // Só o nome vale: na quarentena não há esse arquivo (true, nada a apagar) e a mídia fica.
      expect(await deleteQuarantined(`../media/2026/09/${A}.png`)).toBe(true);
      expect(await tree()).toEqual([`media/2026/09/${A}.png`]);
    });
  });

  describe('mediaVariantPath (miniatura na primeira leitura, ADR 38)', () => {
    const key = `2026/09/${A}.png`;
    const variantKey = `2026/09/${A}.w128.webp`;

    it('gera a miniatura em WebP ao lado do original, na largura pedida, e devolve o caminho dela', async () => {
      const original = await png(300, 200);
      await put(key, original);

      const abs = await mediaVariantPath(key, 128);

      expect(abs).toBe(inMedia(variantKey));
      expect(makeVariant).toHaveBeenCalledTimes(1);
      expect(makeVariant).toHaveBeenCalledWith(original, 128);
      const meta = await sharp(await readFile(abs!)).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['webp', 128, 85]);
      // Só o original e a miniatura: o temporário da gravação não fica para trás.
      expect(await tree()).toEqual([`media/${key}`, `media/${variantKey}`]);
    });

    it('a segunda leitura usa a miniatura que já está em disco, sem gerar de novo', async () => {
      await put(key, await png(300, 200));

      const first = await mediaVariantPath(key, 128);
      const second = await mediaVariantPath(key, 128);

      expect(second).toBe(first);
      expect(makeVariant).toHaveBeenCalledTimes(1);
    });

    it('cada largura tem a sua miniatura', async () => {
      await put(key, await png(300, 200));

      expect(await mediaVariantPath(key, 480)).toBe(inMedia(`2026/09/${A}.w480.webp`));
      expect(await mediaVariantPath(key, 960)).toBe(inMedia(`2026/09/${A}.w960.webp`));

      expect(vi.mocked(makeVariant).mock.calls.map((c) => c[1])).toEqual([480, 960]);
    });

    it('pedidos simultâneos da mesma miniatura esperam a mesma geração', async () => {
      await put(key, await png(300, 200));

      const paths = await Promise.all([
        mediaVariantPath(key, 128),
        mediaVariantPath(key, 128),
        mediaVariantPath(key, 128),
      ]);

      expect(paths).toEqual([inMedia(variantKey), inMedia(variantKey), inMedia(variantKey)]);
      expect(makeVariant).toHaveBeenCalledTimes(1);
      expect(await tree()).toEqual([`media/${key}`, `media/${variantKey}`]);
    });

    it('pedidos simultâneos de larguras ou de imagens diferentes não se misturam: cada um recebe a sua miniatura', async () => {
      const otherKey = `2026/09/${B}.png`;
      const mine = await png(300, 200);
      const other = await png(200, 300);
      await put(key, mine);
      await put(otherKey, other);

      const paths = await Promise.all([
        mediaVariantPath(key, 128),
        mediaVariantPath(key, 480),
        mediaVariantPath(otherKey, 128),
      ]);

      expect(paths).toEqual([
        inMedia(variantKey),
        inMedia(`2026/09/${A}.w480.webp`),
        inMedia(`2026/09/${B}.w128.webp`),
      ]);
      // Três gerações, cada uma a partir do original certo e na largura pedida.
      expect(makeVariant).toHaveBeenCalledTimes(3);
      expect(makeVariant).toHaveBeenCalledWith(mine, 128);
      expect(makeVariant).toHaveBeenCalledWith(mine, 480);
      expect(makeVariant).toHaveBeenCalledWith(other, 128);
      const sizes: number[][] = [];
      for (const abs of paths) {
        const meta = await sharp(await readFile(abs!)).metadata();
        sizes.push([meta.width, meta.height]);
      }
      expect(sizes).toEqual([
        [128, 85],
        // Nada é ampliado: o original de 300 px não vira 480.
        [300, 200],
        [85, 128],
      ]);
    });

    it('original que não existe: null (a leitura responde 404) e nada é gerado', async () => {
      expect(await mediaVariantPath(key, 128)).toBeNull();
      expect(makeVariant).not.toHaveBeenCalled();
      expect(await tree()).toEqual([]);
    });

    it('miniatura que ficou no disco sem o original (imagem removida pela moderação) não é servida: null, e nada é gerado', async () => {
      await put(variantKey, 'sobra gravada durante a remoção');

      expect(await mediaVariantPath(key, 128)).toBeNull();

      expect(makeVariant).not.toHaveBeenCalled();
    });

    it('geração em andamento quando a moderação tira o original: a miniatura gravada depois não é entregue e sai do disco (ADR 41)', async () => {
      await put(key, await png(300, 200));
      vi.mocked(makeVariant).mockImplementationOnce(async (original, width) => {
        // A remoção chega no meio da geração, com o original já lido.
        expect(await deleteMediaImage(key)).toBe(true);
        const actual = await vi.importActual<typeof import('./media.image')>('./media.image');
        return actual.makeVariant(original, width);
      });

      expect(await mediaVariantPath(key, 128)).toBeNull();

      expect(makeVariant).toHaveBeenCalledTimes(1);
      expect(await tree()).toEqual([]);
    });

    it('chave fora da pasta de mídia: null, sem ler nada', async () => {
      await writeFile(path.join(dir, `${A}.png`), await png(20, 20));
      expect(await mediaVariantPath(`../${A}.png`, 128)).toBeNull();
      expect(makeVariant).not.toHaveBeenCalled();
    });

    it('original que a sharp não lê: o erro sobe para quem chamou, e a próxima leitura tenta de novo', async () => {
      await put(key, 'isto não é uma imagem');

      await expect(mediaVariantPath(key, 128)).rejects.toThrow(/unsupported image format/);
      expect(await tree()).toEqual([`media/${key}`]);

      // A geração que falhou não fica presa na fila: com o original trocado, a miniatura nasce.
      await put(key, await png(300, 200));
      expect(await mediaVariantPath(key, 128)).toBe(inMedia(variantKey));
      expect(makeVariant).toHaveBeenCalledTimes(2);
    });

    it('depois da quarentena e da reversão, a miniatura nasce de novo na primeira leitura (ADR 41)', async () => {
      await put(key, await png(300, 200));
      expect(await mediaVariantPath(key, 128)).toBe(inMedia(variantKey));

      expect(await quarantineMediaImage(key, 77)).toBe('77.png');
      // Fora do ar: a geração que já terminou não fica guardada para responder por um arquivo
      // que saiu; pedir a miniatura agora é "não existe", sem gerar nada.
      expect(await mediaVariantPath(key, 128)).toBeNull();
      expect(await tree()).toEqual(['quarantine/77.png']);

      expect(await restoreQuarantined('77.png', key)).toBe(true);
      expect(await mediaVariantPath(key, 128)).toBe(inMedia(variantKey));

      // Duas gerações: a de antes da remoção e a de depois da reversão.
      expect(makeVariant).toHaveBeenCalledTimes(2);
      expect(await tree()).toEqual([`media/${key}`, `media/${variantKey}`]);
      const meta = await sharp(await readFile(inMedia(variantKey))).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['webp', 128, 85]);
    });

    it('se outro pedido gravou a mesma miniatura antes (o rename falha com o destino no lugar), vale a dele', async () => {
      await put(key, await png(300, 200));
      vi.mocked(makeVariant).mockImplementationOnce(async () => {
        await put(variantKey, 'miniatura do outro pedido');
        return Buffer.from('a minha');
      });
      vi.mocked(rename).mockRejectedValueOnce(fsError('EPERM'));

      expect(await mediaVariantPath(key, 128)).toBe(inMedia(variantKey));

      // Gravação atômica: primeiro um temporário ao lado, depois o rename para o nome final.
      const [from, to] = vi.mocked(rename).mock.calls[0]!;
      expect(String(from)).toMatch(/\.w128\.webp\.[0-9a-f]{12}\.tmp$/);
      expect(path.dirname(String(from))).toBe(path.dirname(inMedia(variantKey)));
      expect(to).toBe(inMedia(variantKey));
      expect(await readFile(inMedia(variantKey))).toEqual(Buffer.from('miniatura do outro pedido'));
      // O temporário desta tentativa é apagado.
      expect(await tree()).toEqual([`media/${key}`, `media/${variantKey}`]);
    });

    it('se a gravação falha e a miniatura não existe, o erro sobe e o temporário é apagado', async () => {
      await put(key, await png(300, 200));
      const boom = fsError('EPERM');
      vi.mocked(rename).mockRejectedValueOnce(boom);

      await expect(mediaVariantPath(key, 128)).rejects.toBe(boom);

      expect(await tree()).toEqual([`media/${key}`]);
    });

    it('se nem o temporário pôde ser apagado, o erro que sobe continua sendo o da gravação', async () => {
      await put(key, await png(300, 200));
      const boom = fsError('EPERM');
      vi.mocked(rename).mockRejectedValueOnce(boom);
      vi.mocked(unlink).mockRejectedValueOnce(fsError('EBUSY'));

      await expect(mediaVariantPath(key, 128)).rejects.toBe(boom);

      // O que se tentou apagar foi o temporário desta gravação, não o original nem a miniatura.
      expect(vi.mocked(unlink).mock.calls).toHaveLength(1);
      expect(String(vi.mocked(unlink).mock.calls[0]![0])).toBe(
        String(vi.mocked(rename).mock.calls[0]![0]),
      );
      // O temporário fica para o expurgo (sai depois de um dia); a miniatura não nasceu.
      const left = await tree();
      expect(left).toHaveLength(2);
      expect(left[0]).toBe(`media/${key}`);
      expect(left[1]).toMatch(/.w128.webp.[0-9a-f]{12}.tmp$/);
    });

    it('original que existe mas não pôde ser lido (não é "arquivo não existe"): o erro sobe, não vira 404', async () => {
      // Uma pasta com o nome do original: a leitura falha com EISDIR, não com ENOENT.
      await mkdir(inMedia(key), { recursive: true });

      await expect(mediaVariantPath(key, 128)).rejects.toMatchObject({ code: 'EISDIR' });
      expect(makeVariant).not.toHaveBeenCalled();
    });
  });

  describe('mediaUsage (painel admin)', () => {
    it('pasta de mídia que ainda não existe: tudo zero, sem consultar o banco', async () => {
      expect(await mediaUsage()).toEqual({ files: 0, variants: 0, bytes: 0, orphans: 0 });
      expect(listReferencedUrls).not.toHaveBeenCalled();
    });

    it('conta originais, miniaturas, o espaço de tudo e as imagens que ninguém usa', async () => {
      await put(`2026/09/${A}.png`, Buffer.alloc(100));
      await put(`2026/09/${A}.w128.webp`, Buffer.alloc(10));
      await put(`2026/09/${A}.w480.webp`, Buffer.alloc(20));
      await put(`2026/10/${B}.webp`, Buffer.alloc(50));
      await put(`2026/10/${B}.w128.webp`, Buffer.alloc(5));
      // Miniatura sem original e temporário largado: ocupam espaço, mas não são imagens.
      await put(`2026/10/${C}.w960.webp`, Buffer.alloc(7));
      await put(`2026/09/${A}.w128.webp.0a1b2c3d4e5f.tmp`, Buffer.alloc(3));
      listReferencedUrls.mockResolvedValue([
        `/api/media/2026/09/${A}.png`,
        // Avatar de fora e imagem em uso cujo arquivo sumiu não mudam a conta.
        'https://i.pravatar.cc/150',
        `/api/media/2026/11/${C}.jpg`,
      ]);

      expect(await mediaUsage()).toEqual({ files: 2, variants: 4, bytes: 195, orphans: 1 });
      expect(listReferencedUrls).toHaveBeenCalledTimes(1);
    });

    it('a identidade inclui a pasta: o mesmo nome em outro mês é outra imagem', async () => {
      await put(`2026/09/${A}.png`);
      await put(`2026/10/${A}.png`);
      listReferencedUrls.mockResolvedValue([`/api/media/2026/09/${A}.png`]);

      expect(await mediaUsage()).toMatchObject({ files: 2, orphans: 1 });
    });

    it('se a consulta de quem usa as imagens falha, o erro sobe: o painel não mostra tudo como órfão', async () => {
      await put(`2026/09/${A}.png`, Buffer.alloc(100));
      const boom = new Error('connect ECONNREFUSED 127.0.0.1:3306');
      listReferencedUrls.mockRejectedValue(boom);

      await expect(mediaUsage()).rejects.toBe(boom);
    });

    it('arquivo que some entre a listagem e a leitura do tamanho fica fora da conta', async () => {
      await put(`2026/09/${A}.png`, Buffer.alloc(100));
      await put(`2026/09/${B}.png`, Buffer.alloc(40));
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      const realStat = actual.stat as (p: PathLike) => Promise<Stats>;
      vi.mocked(stat).mockImplementation(((p: PathLike) =>
        String(p).endsWith(`${B}.png`)
          ? Promise.reject(fsError('ENOENT'))
          : realStat(p)) as typeof stat);

      expect(await mediaUsage()).toEqual({ files: 1, variants: 0, bytes: 100, orphans: 1 });
    });
  });

  describe('removeMediaOrphans (expurgo)', () => {
    it('pasta de mídia que ainda não existe: nada a apagar, sem consultar o banco', async () => {
      expect(await removeMediaOrphans()).toBe(0);
      expect(listReferencedUrls).not.toHaveBeenCalled();
    });

    it('imagem em uso fica, com as miniaturas, por mais velha que seja', async () => {
      await put(`2026/09/${A}.png`, 'x', 24 * 30);
      await put(`2026/09/${A}.w128.webp`, 'x', 24 * 30);
      listReferencedUrls.mockResolvedValue([`/api/media/2026/09/${A}.png`]);

      expect(await removeMediaOrphans()).toBe(0);

      expect(await tree()).toEqual([`media/2026/09/${A}.png`, `media/2026/09/${A}.w128.webp`]);
    });

    it('imagem que ninguém usa há mais de um dia sai com as miniaturas; devolve quantas imagens saíram', async () => {
      await put(`2026/09/${A}.png`, 'x', 25);
      await put(`2026/09/${A}.w128.webp`, 'x', 25);
      // A miniatura pode ser de agora há pouco: o prazo conta do envio do original.
      await put(`2026/09/${A}.w480.webp`);
      await put(`2026/10/${B}.webp`, 'x', 48);
      await put(`2026/10/${C}.jpg`, 'x', 72);
      listReferencedUrls.mockResolvedValue([`/api/media/2026/10/${C}.jpg`]);

      expect(await removeMediaOrphans()).toBe(2);

      expect(await tree()).toEqual([`media/2026/10/${C}.jpg`]);
    });

    it('imagem recém-enviada e ainda não usada (formulário aberto) fica, com as miniaturas', async () => {
      await put(`2026/09/${A}.png`, 'x', 23);
      await put(`2026/09/${A}.w128.webp`, 'x', 23);

      expect(await removeMediaOrphans()).toBe(0);

      expect(await tree()).toEqual([`media/2026/09/${A}.png`, `media/2026/09/${A}.w128.webp`]);
    });

    it('o prazo de um dia é contado a partir do instante informado, e vence no dia exato', async () => {
      const abs = await put(`2026/09/${A}.png`);
      const sentAt = new Date('2026-09-10T12:00:00.000Z');
      await utimes(abs, sentAt, sentAt);

      const almost = new Date(sentAt.getTime() + MEDIA_ORPHAN_GRACE_MS - 1000);
      expect(await removeMediaOrphans(almost)).toBe(0);
      expect(await tree()).toEqual([`media/2026/09/${A}.png`]);

      const due = new Date(sentAt.getTime() + MEDIA_ORPHAN_GRACE_MS);
      expect(await removeMediaOrphans(due)).toBe(1);
      expect(await tree()).toEqual([]);
    });

    it('miniatura sem original é sobra: sai na hora, mesmo recente, e não conta como imagem removida', async () => {
      await put(`2026/09/${A}.w128.webp`);
      await put(`2026/09/${A}.w480.webp`);
      await put(`2026/09/${B}.png`, 'x', 25);

      // Só a órfã B era uma imagem; as miniaturas de A eram sobra.
      expect(await removeMediaOrphans()).toBe(1);

      expect(await tree()).toEqual([]);
    });

    it('temporário de geração interrompida sai depois de um dia e não conta como imagem; o recente fica', async () => {
      await put(`2026/09/${A}.png`);
      await put(`2026/09/${A}.w128.webp.0a1b2c3d4e5f.tmp`, 'x', 25);
      await put(`2026/09/${A}.w480.webp.aabbccddeeff.tmp`);
      await put(`2026/09/anotacao.txt`, 'x', 25);
      listReferencedUrls.mockResolvedValue([`/api/media/2026/09/${A}.png`]);

      expect(await removeMediaOrphans()).toBe(0);

      expect(await tree()).toEqual([
        `media/2026/09/${A}.png`,
        `media/2026/09/${A}.w480.webp.aabbccddeeff.tmp`,
      ]);
    });

    it('referência que não é mídia própria (avatar de fora) não protege nem quebra o expurgo', async () => {
      await put(`2026/09/${A}.png`, 'x', 25);
      listReferencedUrls.mockResolvedValue([
        'https://i.pravatar.cc/150',
        `/api/media/2026/09/${A}.svg`,
        `/api/media/2026/10/${A}.png`,
      ]);

      expect(await removeMediaOrphans()).toBe(1);

      expect(await tree()).toEqual([]);
    });

    it('arquivo que não pôde ser apagado (preso por outro processo) não interrompe o expurgo dos outros', async () => {
      await put(`2026/09/${A}.png`, 'x', 25);
      await put(`2026/09/${A}.w128.webp`, 'x', 25);
      await put(`2026/09/${B}.png`, 'x', 25);
      await put(`2026/09/${B}.w128.webp.0a1b2c3d4e5f.tmp`, 'x', 25);
      await put(`2026/09/${C}.w128.webp.aabbccddeeff.tmp`, 'x', 25);
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      const realUnlink = actual.unlink as (p: PathLike) => Promise<void>;
      vi.mocked(unlink).mockImplementation(((p: PathLike) =>
        String(p).endsWith(`${A}.png`) || String(p).endsWith(`${B}.w128.webp.0a1b2c3d4e5f.tmp`)
          ? Promise.reject(fsError('EBUSY'))
          : realUnlink(p)) as typeof unlink);

      // Só B saiu de fato: o original de A ficou preso, então A não conta como removida.
      expect(await removeMediaOrphans()).toBe(1);

      // Só os dois presos ficam; a miniatura da imagem presa, a outra imagem e o outro temporário saem.
      expect(await tree()).toEqual([
        `media/2026/09/${A}.png`,
        `media/2026/09/${B}.w128.webp.0a1b2c3d4e5f.tmp`,
      ]);
    });

    it('se a consulta de quem usa as imagens falha, o expurgo para sem apagar nada: sem a lista, tudo pareceria órfão', async () => {
      await put(`2026/09/${A}.png`, 'x', 24 * 30);
      await put(`2026/09/${A}.w128.webp`, 'x', 24 * 30);
      await put(`2026/09/${B}.w480.webp`);
      await put(`2026/09/${C}.w128.webp.0a1b2c3d4e5f.tmp`, 'x', 25);
      const boom = new Error('connect ECONNREFUSED 127.0.0.1:3306');
      listReferencedUrls.mockRejectedValue(boom);

      await expect(removeMediaOrphans()).rejects.toBe(boom);

      expect(unlink).not.toHaveBeenCalled();
      expect(await tree()).toEqual([
        `media/2026/09/${A}.png`,
        `media/2026/09/${A}.w128.webp`,
        `media/2026/09/${B}.w480.webp`,
        `media/2026/09/${C}.w128.webp.0a1b2c3d4e5f.tmp`,
      ]);
    });

    it('arquivo que some entre a listagem e o expurgo (outro expurgo, rename) é ignorado', async () => {
      await put(`2026/09/${A}.png`, 'x', 25);
      vi.mocked(stat).mockRejectedValueOnce(fsError('ENOENT'));

      expect(await removeMediaOrphans()).toBe(0);
      expect(listReferencedUrls).not.toHaveBeenCalled();
    });
  });
});
