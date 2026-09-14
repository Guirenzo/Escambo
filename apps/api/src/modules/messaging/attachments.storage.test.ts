import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_MIMES,
  contentDisposition,
  detectType,
  safeFileName,
} from './attachments.storage';

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

  it('RIFF que não é WEBP (AVI/WAV) não passa por imagem', () => {
    const avi = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI LIST')]);
    expect(detectType(avi)).toBeNull();
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
});
