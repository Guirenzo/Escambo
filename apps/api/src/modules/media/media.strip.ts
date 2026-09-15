/**
 * Remove metadados de imagens antes de publicar (ADR 36). Foto de celular carrega EXIF com GPS,
 * modelo do aparelho e data — num avatar público isso pode ser o endereço de casa. O app já
 * reencoda no navegador, mas a API não confia no cliente: remove de novo aqui, sem decodificar
 * pixels. JPEG: segmentos APP1 (EXIF/XMP), APP13 (IPTC) e COM. PNG: eXIf, tEXt, iTXt, zTXt e
 * tIME. WebP: chunks EXIF e XMP, com as flags do VP8X e o tamanho do RIFF refeitos. GIF passa
 * como está. Estrutura inesperada devolve os bytes como vieram (o tipo já foi validado).
 */

const JPEG_DROP = new Set([0xe1, 0xed, 0xfe]);

export function stripJpeg(b: Buffer): Buffer {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return b;
  const parts: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 2 <= b.length) {
    if (b[i] !== 0xff) return b;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++; // preenchimento entre marcadores
      continue;
    }
    // Início do scan (ou fim): daqui em diante são os dados da imagem, copiados inteiros.
    if (marker === 0xda || marker === 0xd9) {
      parts.push(b.subarray(i));
      return Buffer.concat(parts);
    }
    // Marcadores sem tamanho (TEM, RSTn).
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > b.length) return b;
    const end = i + 2 + b.readUInt16BE(i + 2);
    if (end > b.length || end < i + 4) return b;
    if (!JPEG_DROP.has(marker)) parts.push(b.subarray(i, end));
    i = end;
  }
  return Buffer.concat(parts);
}

const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

export function stripPng(b: Buffer): Buffer {
  if (b.length < 8) return b;
  const parts: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.subarray(i + 4, i + 8).toString('latin1');
    const end = i + 12 + len; // tamanho + tipo + dados + CRC
    if (end > b.length) return b;
    if (!PNG_DROP.has(type)) parts.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(parts);
}

const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

export function stripWebp(b: Buffer): Buffer {
  if (b.length < 12) return b;
  const chunks: Buffer[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const fourcc = b.subarray(i, i + 4).toString('latin1');
    const size = b.readUInt32LE(i + 4);
    if (i + 8 + size > b.length) return b;
    const end = Math.min(b.length, i + 8 + size + (size % 2)); // chunks têm tamanho par
    if (fourcc !== 'EXIF' && fourcc !== 'XMP ') {
      const chunk = Buffer.from(b.subarray(i, end));
      if (fourcc === 'VP8X' && chunk.length > 8) chunk[8] = chunk[8]! & ~(VP8X_EXIF | VP8X_XMP);
      chunks.push(chunk);
    }
    i = end;
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}

/** Escolhe pelo tipo real (detectType); tipos sem metadados conhecidos passam iguais. */
export function stripImageMetadata(bytes: Buffer, mime: string): Buffer {
  switch (mime) {
    case 'image/jpeg':
      return stripJpeg(bytes);
    case 'image/png':
      return stripPng(bytes);
    case 'image/webp':
      return stripWebp(bytes);
    default:
      return bytes;
  }
}
