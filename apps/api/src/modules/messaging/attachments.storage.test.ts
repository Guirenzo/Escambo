import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../config/env';
import {
  ACCEPTED_MIMES,
  attachmentPath,
  attachmentSize,
  contentDisposition,
  dataDirUsage,
  detectType,
  listUploadedFiles,
  removeAttachment,
  safeFileName,
  saveAttachment,
  uploadsDir,
} from './attachments.storage';

// O ulid de verdade, mas observável: um teste fixa a chave para provar que nada é sobrescrito.
vi.mock('ulid', async (importOriginal) => {
  const real = await importOriginal<typeof import('ulid')>();
  return { ...real, ulid: vi.fn(real.ulid) };
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const GIF = Buffer.from('GIF89a\u0001\u0000', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const EMPTY_ZIP = Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0]);

describe('detectType — o tipo vem dos bytes, não do nome', () => {
  it('reconhece os seis tipos aceitos', () => {
    expect(detectType(PNG)).toMatchObject({ mime: 'image/png', ext: 'png', kind: 'image' });
    expect(detectType(JPEG)).toMatchObject({ mime: 'image/jpeg', ext: 'jpg', kind: 'image' });
    expect(detectType(GIF)).toMatchObject({ mime: 'image/gif', kind: 'image' });
    expect(detectType(WEBP)).toMatchObject({ mime: 'image/webp', kind: 'image' });
    expect(detectType(PDF)).toMatchObject({ mime: 'application/pdf', kind: 'file' });
    expect(detectType(ZIP)).toMatchObject({ mime: 'application/zip', kind: 'file' });
    expect(detectType(EMPTY_ZIP)?.mime).toBe('application/zip');
    expect(ACCEPTED_MIMES).toHaveLength(6);
  });

  it('recusa o que não é um dos tipos: HTML, SVG, texto, executável, vazio', () => {
    expect(detectType(Buffer.from('<!doctype html><script>alert(1)</script>'))).toBeNull();
    expect(detectType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(detectType(Buffer.from('só um texto qualquer'))).toBeNull();
    expect(detectType(Buffer.from([0x4d, 0x5a, 0x90, 0x00]))).toBeNull(); // MZ (exe)
    expect(detectType(Buffer.alloc(0))).toBeNull();
  });

  it('ZIP vale nas três aberturas (entrada, vazio, dividido); "PK" seguido de outra coisa não é ZIP', () => {
    const spanned = Buffer.from([0x50, 0x4b, 0x07, 0x08, 0, 0]);
    expect(detectType(spanned)).toMatchObject({ mime: 'application/zip', ext: 'zip' });
    // Assinatura de diretório central solta (PK 01 02), bytes trocados e arquivo curto demais.
    expect(detectType(Buffer.from([0x50, 0x4b, 0x01, 0x02, 0, 0]))).toBeNull();
    expect(detectType(Buffer.from([0x50, 0x4b, 0x03, 0x06, 0, 0]))).toBeNull();
    expect(detectType(Buffer.from([0x50, 0x4b, 0x05, 0x08, 0, 0]))).toBeNull();
    expect(detectType(Buffer.from([0x50, 0x4b, 0x03]))).toBeNull();
  });

  it('o nome de download aceita as extensões de documentos que são ZIP por dentro, e JPG/JPEG para a mesma foto', () => {
    expect(detectType(ZIP)!.names).toEqual(['zip', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp']);
    expect(detectType(JPEG)!.names).toEqual(['jpg', 'jpeg']);
    expect(ACCEPTED_MIMES).toEqual([
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'application/pdf',
      'application/zip',
    ]);
    // SVG fica de fora de propósito (roda script).
    expect(ACCEPTED_MIMES).not.toContain('image/svg+xml');
  });

  it('RIFF que não é WEBP (AVI/WAV) não passa por imagem', () => {
    const avi = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI LIST')]);
    expect(detectType(avi)).toBeNull();
    // "WEBP" na posição certa, mas sem o RIFF na frente, também não.
    const noRiff = Buffer.concat([Buffer.from('XXXX'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
    expect(detectType(noRiff)).toBeNull();
  });

  it('cada tipo diz como é guardado (extensão), como é mostrado (imagem abre, arquivo baixa) e que nomes aceita', () => {
    expect(detectType(PNG)).toEqual({
      mime: 'image/png',
      ext: 'png',
      kind: 'image',
      names: ['png'],
    });
    expect(detectType(GIF)).toEqual({
      mime: 'image/gif',
      ext: 'gif',
      kind: 'image',
      names: ['gif'],
    });
    expect(detectType(WEBP)).toEqual({
      mime: 'image/webp',
      ext: 'webp',
      kind: 'image',
      names: ['webp'],
    });
    expect(detectType(PDF)).toEqual({
      mime: 'application/pdf',
      ext: 'pdf',
      kind: 'file',
      names: ['pdf'],
    });
  });

  it('GIF vale nas duas versões (87a e 89a)', () => {
    expect(detectType(Buffer.from('GIF87a\u0001\u0000', 'latin1'))?.mime).toBe('image/gif');
    expect(detectType(Buffer.from('GIF88a\u0001\u0000', 'latin1'))).toBeNull();
  });

  it('assinatura pela metade não vale: o começo tem de bater inteiro', () => {
    // JPEG é FF D8 FF: os dois primeiros bytes sozinhos, ou com o terceiro errado, não bastam.
    expect(detectType(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(detectType(Buffer.from([0xff, 0xd8, 0x00, 0xe0]))).toBeNull();
    expect(detectType(Buffer.from([0xff, 0x00, 0xff, 0xe0]))).toBeNull();
    expect(detectType(Buffer.from([0x00, 0xd8, 0xff, 0xe0]))).toBeNull();
    // ZIP é "PK" + a abertura: com o P ou o K trocado, a abertura sozinha não vale.
    expect(detectType(Buffer.from([0x00, 0x4b, 0x03, 0x04, 0, 0]))).toBeNull();
    expect(detectType(Buffer.from([0x50, 0x00, 0x03, 0x04, 0, 0]))).toBeNull();
    // PNG cortado no sétimo byte, e PNG com o fim da assinatura trocado.
    expect(detectType(PNG.subarray(0, 7))).toBeNull();
    expect(detectType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00]))).toBeNull();
    // "%PDF" sem o traço, e a assinatura fora do começo do arquivo.
    expect(detectType(Buffer.from('%PDF1.7'))).toBeNull();
    expect(detectType(Buffer.from(' %PDF-1.7'))).toBeNull();
    expect(detectType(Buffer.concat([Buffer.from('<html>'), PNG]))).toBeNull();
  });
});

describe('safeFileName — nome de download sem surpresas', () => {
  const png = detectType(PNG)!;
  const zip = detectType(ZIP)!;

  it('mantém nome e extensão coerentes com o tipo', () => {
    expect(safeFileName('foto.png', png)).toBe('foto.png');
    expect(safeFileName('Foto Final.JPEG', detectType(JPEG)!)).toBe('Foto Final.JPEG');
    expect(safeFileName('proposta.docx', zip)).toBe('proposta.docx'); // docx é ZIP
  });

  it('acrescenta a extensão real quando o nome mente ou não tem', () => {
    expect(safeFileName('foto.exe', png)).toBe('foto.exe.png');
    expect(safeFileName('foto', png)).toBe('foto.png');
    expect(safeFileName(undefined, png)).toBe('arquivo.png');
    expect(safeFileName('   ', zip)).toBe('arquivo.zip');
  });

  it('tira caminho, caracteres de controle e aspas; normaliza espaços', () => {
    expect(safeFileName('../../etc/passwd.png', png)).toBe('passwd.png');
    expect(safeFileName('C:\\Users\\eu\\foto.png', png)).toBe('foto.png');
    expect(safeFileName('fo\u0000to\r\n "x".png', png)).toBe('foto x.png');
  });

  it('limita a 120 caracteres preservando a extensão', () => {
    const name = safeFileName(`${'a'.repeat(200)}.png`, png);
    expect(name).toHaveLength(120);
    expect(name.endsWith('.png')).toBe(true);
  });

  it('o corte é só acima de 120: com 120 fica como veio, com 121 perde um caractere do nome (não da extensão)', () => {
    const exact = `${'a'.repeat(116)}.png`;
    expect(safeFileName(exact, png)).toBe(exact);
    expect(safeFileName(`${'a'.repeat(116)}b.png`, png)).toBe(exact);
    // A extensão acrescentada pelo tipo real também cabe no limite.
    expect(safeFileName('c'.repeat(300), zip)).toBe(`${'c'.repeat(116)}.zip`);
    // Nome longo com ponto no meio: o que se preserva é a extensão (o ÚLTIMO ponto), não o resto.
    expect(safeFileName(`v1.${'a'.repeat(200)}.png`, png)).toBe(`v1.${'a'.repeat(113)}.png`);
  });

  it('caractere de controle fora do ASCII básico (DEL, C1) também sai, e caminho que termina em barra não deixa nome vazio', () => {
    expect(safeFileName('fo\u007fto\u0085\u009f.png', png)).toBe('foto.png');
    expect(safeFileName('minha pasta/', png)).toBe('arquivo.png');
    expect(safeFileName('pasta/sub\\foto.png', png)).toBe('foto.png');
  });

  it('vários espaços seguidos viram um só, e o nome não começa nem termina com espaço', () => {
    expect(safeFileName('  meu    arquivo   final.png  ', png)).toBe('meu arquivo final.png');
  });

  it('acento decomposto (como o macOS manda) é gravado na forma composta', () => {
    // "orçamento" com c + cedilha combinante (NFD) vira o "ç" de um caractere só (NFC).
    // Escrito com escapes de propósito: um editor que normalize o arquivo não desfaz o teste.
    const decomposed = 'orc\u0327amento.png';
    const composed = 'or\u00e7amento.png';
    expect(decomposed).not.toBe(composed);
    expect(safeFileName(decomposed, png)).toBe(composed);
    expect(safeFileName(decomposed, png)).toHaveLength(13);
  });

  it('a extensão é comparada sem diferenciar maiúsculas, e só a ÚLTIMA conta', () => {
    expect(safeFileName('FOTO.PNG', png)).toBe('FOTO.PNG');
    expect(safeFileName('relatorio.png.exe', png)).toBe('relatorio.png.exe.png');
    // Ponto no meio do nome não atrapalha: a extensão é o que vem depois do último.
    expect(safeFileName('foto.final.v2.png', png)).toBe('foto.final.v2.png');
    expect(safeFileName('planilha.XLSX', zip)).toBe('planilha.XLSX');
    // Extensão de outro tipo aceito não serve: um PNG chamado .pdf continua dizendo que é PNG.
    expect(safeFileName('contrato.pdf', png)).toBe('contrato.pdf.png');
  });
});

describe('contentDisposition', () => {
  it('imagem vai inline, arquivo vai como download, nome em ASCII e UTF-8', () => {
    expect(contentDisposition('image', 'foto.png')).toBe(
      `inline; filename="foto.png"; filename*=UTF-8''foto.png`,
    );
    expect(contentDisposition('file', 'orçamento (v2).pdf')).toBe(
      `attachment; filename="or_amento (v2).pdf"; filename*=UTF-8''or%C3%A7amento%20%28v2%29.pdf`,
    );
  });

  it("apóstrofo e asterisco vão codificados no nome UTF-8 (não fecham o filename*=UTF-8'')", () => {
    expect(contentDisposition('file', "it's*.pdf")).toBe(
      `attachment; filename="it's*.pdf"; filename*=UTF-8''it%27s%2A.pdf`,
    );
  });
});

/**
 * A parte de disco (ADR 29 e ADR 31), contra um DATA_DIR temporário de verdade: onde o arquivo vai
 * parar, o que acontece com chave que tenta sair da pasta e o inventário que o expurgo usa.
 */
describe('anexos no disco', () => {
  const realDataDir = env.DATA_DIR;
  let dataDir: string;
  let uploads: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'escambo-anexos-'));
    uploads = path.join(dataDir, 'uploads');
    env.DATA_DIR = dataDir;
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.mocked(ulid).mockClear();
    env.DATA_DIR = realDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Grava um arquivo em DATA_DIR (criando as pastas) e devolve o caminho absoluto. */
  async function put(relative: string, bytes: Buffer | string): Promise<string> {
    const abs = path.join(dataDir, ...relative.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, bytes);
    return abs;
  }

  const png = detectType(PNG)!;
  const pdf = detectType(PDF)!;

  describe('attachmentPath — a chave nunca sai da pasta de uploads', () => {
    it('a pasta é DATA_DIR/uploads, e a chave vira um caminho absoluto dentro dela', () => {
      expect(uploadsDir()).toBe(path.resolve(dataDir, 'uploads'));
      expect(attachmentPath('2026/09/01KEY.png')).toBe(
        path.join(uploads, '2026', '09', '01KEY.png'),
      );
    });

    it('chave que sobe de pasta, aponta para outro lugar ou para a própria pasta é recusada (null)', () => {
      expect(attachmentPath('../segredo.txt')).toBeNull();
      expect(attachmentPath('2026/../../segredo.txt')).toBeNull();
      expect(attachmentPath(path.join(dataDir, 'segredo.txt'))).toBeNull();
      // Pasta vizinha que só COMEÇA com o mesmo nome não é a pasta de uploads.
      expect(attachmentPath('../uploads-outra/a.png')).toBeNull();
      expect(attachmentPath('')).toBeNull();
      expect(attachmentPath('.')).toBeNull();
    });
  });

  describe('saveAttachment', () => {
    it('grava os bytes em uploads/AAAA/MM/<ulid>.<ext> e devolve a chave relativa, com barra normal', async () => {
      const key = await saveAttachment(PNG, png);

      expect(key).toMatch(/^\d{4}\/\d{2}\/[0-9A-HJKMNP-TV-Z]{26}\.png$/);
      const saved = await readFile(path.join(uploads, ...key.split('/')));
      expect(saved.equals(PNG)).toBe(true);
    });

    it('a pasta é o ano e o mês em UTC, com o mês em dois dígitos', async () => {
      // 23h30 de 31/12 em Brasília já é janeiro em UTC.
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2027-01-01T02:30:00Z') });

      const key = await saveAttachment(PDF, pdf);

      expect(key.startsWith('2027/01/')).toBe(true);
      expect(key.endsWith('.pdf')).toBe(true);
      expect(existsSync(path.join(uploads, '2027', '01'))).toBe(true);
    });

    it('cada envio ganha a própria chave, mesmo com o mesmo conteúdo (um arquivo por mensagem)', async () => {
      const first = await saveAttachment(PNG, png);
      const second = await saveAttachment(PNG, png);

      expect(first).not.toBe(second);
      expect(await listUploadedFiles()).toHaveLength(2);
    });

    it('nunca sobrescreve: se a chave já existe no disco, falha e o arquivo antigo fica intacto', async () => {
      vi.mocked(ulid).mockReturnValueOnce('01FIXEDKEY').mockReturnValueOnce('01FIXEDKEY');
      const key = await saveAttachment(PNG, png);
      expect(key.endsWith('/01FIXEDKEY.png')).toBe(true);

      await expect(saveAttachment(Buffer.from('outro conteúdo'), png)).rejects.toMatchObject({
        code: 'EEXIST',
      });

      const kept = await readFile(path.join(uploads, ...key.split('/')));
      expect(kept.equals(PNG)).toBe(true);
    });
  });

  describe('removeAttachment (melhor esforço)', () => {
    it('apaga o arquivo da chave', async () => {
      const key = await saveAttachment(PNG, png);
      const abs = attachmentPath(key)!;
      expect(existsSync(abs)).toBe(true);

      expect(await removeAttachment(key)).toBeUndefined();

      expect(existsSync(abs)).toBe(false);
    });

    it('arquivo que já não existe não é erro', async () => {
      await expect(removeAttachment('2026/09/nunca-existiu.png')).resolves.toBeUndefined();
    });

    it('chave que tenta sair da pasta não apaga nada fora dela', async () => {
      const outside = await put('segredo.txt', 'não mexa');

      await expect(removeAttachment('../segredo.txt')).resolves.toBeUndefined();

      expect(await readFile(outside, 'utf8')).toBe('não mexa');
    });
  });

  describe('attachmentSize', () => {
    it('devolve o tamanho em disco, em bytes', async () => {
      const key = await saveAttachment(PDF, pdf);
      expect(await attachmentSize(key)).toBe(PDF.length);
    });

    it('arquivo que sumiu do disco devolve null (não estoura)', async () => {
      expect(await attachmentSize('2026/09/sumiu.pdf')).toBeNull();
    });

    it('chave que tenta sair da pasta devolve null, mesmo que o arquivo exista lá fora', async () => {
      await put('segredo.txt', 'não mexa');
      expect(await attachmentSize('../segredo.txt')).toBeNull();
    });

    it('arquivo vazio no disco tem tamanho 0, que não é o mesmo que "sumiu"', async () => {
      await put('uploads/2026/09/vazio.pdf', '');
      expect(await attachmentSize('2026/09/vazio.pdf')).toBe(0);
    });
  });

  describe('listUploadedFiles (inventário do expurgo, ADR 31)', () => {
    it('sem a pasta de uploads (instalação nova), a lista é vazia', async () => {
      expect(await listUploadedFiles()).toEqual([]);
    });

    it('traz todos os arquivos das subpastas — só arquivos — com a chave como fica no banco, o caminho, o tamanho e a data', async () => {
      const a = await put('uploads/2026/03/a.png', PNG);
      const b = await put('uploads/2026/09/b.pdf', PDF);
      await mkdir(path.join(uploads, '2026', '10'), { recursive: true }); // pasta vazia não é arquivo
      await put('exports/fora.zip', ZIP); // fora de uploads: não entra
      // A data é a da última gravação do CONTEÚDO (é com ela que o expurgo conta as 24 h do órfão),
      // não a de criação nem a de mudança de metadados.
      const written = new Date('2026-03-18T15:00:00Z');
      await utimes(a, written, written);

      const files = (await listUploadedFiles()).sort((x, y) => x.key.localeCompare(y.key));

      expect(files.map((f) => f.key)).toEqual(['2026/03/a.png', '2026/09/b.pdf']);
      expect(files.map((f) => f.path)).toEqual([a, b]);
      expect(files.map((f) => f.size)).toEqual([PNG.length, PDF.length]);
      expect(files[0]!.mtimeMs).toBe(written.getTime());
      expect(files[0]!.mtimeMs).toBe((await stat(a)).mtimeMs);
      // A chave do inventário é a mesma que abre o arquivo.
      expect(attachmentPath(files[1]!.key)).toBe(b);
      expect(files[1]!.mtimeMs).toBe((await stat(b)).mtimeMs);
    });

    it('a chave do inventário é exatamente a que o envio devolveu (é ela que o expurgo compara com o banco)', async () => {
      const key = await saveAttachment(PNG, png);
      const loose = await put('uploads/solto.pdf', PDF); // arquivo direto na raiz: chave sem pasta

      const files = await listUploadedFiles();

      expect(files.map((f) => f.key).sort()).toEqual([key, 'solto.pdf'].sort());
      expect(files.find((f) => f.key === 'solto.pdf')!.path).toBe(loose);
      expect(files.find((f) => f.key === key)!.path).toBe(attachmentPath(key));
    });

    it('pasta de uploads que existe mas só tem pastas vazias: lista vazia', async () => {
      await mkdir(path.join(uploads, '2026', '10'), { recursive: true });
      expect(await listUploadedFiles()).toEqual([]);
      expect(await dataDirUsage('uploads')).toEqual({ files: 0, bytes: 0 });
    });
  });

  describe('dataDirUsage (painel de armazenamento)', () => {
    it('pasta que não existe conta zero', async () => {
      expect(await dataDirUsage('uploads')).toEqual({ files: 0, bytes: 0 });
      expect(await dataDirUsage('exports')).toEqual({ files: 0, bytes: 0 });
    });

    it('conta arquivos e bytes de cada subpasta separadamente, descendo nas pastas', async () => {
      await put('uploads/2026/03/a.png', PNG);
      await put('uploads/2026/09/b.pdf', PDF);
      await put('exports/dados-7.zip', ZIP);
      await mkdir(path.join(dataDir, 'exports', 'vazia'), { recursive: true });

      expect(await dataDirUsage('uploads')).toEqual({ files: 2, bytes: PNG.length + PDF.length });
      expect(await dataDirUsage('exports')).toEqual({ files: 1, bytes: ZIP.length });
    });
  });
});
