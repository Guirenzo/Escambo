/**
 * Texto em curvas para SVG, a partir das fontes que o app já empacota (@fontsource, WOFF com
 * contornos TrueType): o logotipo e a capa de compartilhamento ficam iguais em qualquer máquina,
 * sem depender das fontes do sistema na hora de gerar o PNG. Lê o cmap, os contornos (glyf, com
 * glifos compostos), as larguras (hmtx) e o kerning de pares (GPOS "kern", formatos 1 e 2).
 *
 *   const sora = loadFont('node_modules/@fontsource/sora/files/sora-latin-700-normal.woff');
 *   const { d, width } = textPath(sora, 'Escambo', 48, { x: 0, y: 40, tracking: -0.02 });
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

/** Tabelas de um WOFF 1.0, já descomprimidas. */
function woffTables(file) {
  const b = readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'wOFF') throw new Error(`${file}: não é WOFF 1.0`);
  const tables = {};
  for (let i = 0; i < b.readUInt16BE(12); i++) {
    const o = 44 + i * 20;
    const off = b.readUInt32BE(o + 4);
    const comp = b.readUInt32BE(o + 8);
    const raw = b.subarray(off, off + comp);
    tables[b.toString('ascii', o, o + 4)] = comp < b.readUInt32BE(o + 12) ? inflateSync(raw) : raw;
  }
  return tables;
}

/** Índice do glifo na cobertura (Coverage do OpenType), ou -1. */
function coverageIndex(t, off, glyph) {
  const format = t.readUInt16BE(off);
  const count = t.readUInt16BE(off + 2);
  for (let i = 0; i < count; i++) {
    if (format === 1) {
      if (t.readUInt16BE(off + 4 + i * 2) === glyph) return i;
    } else {
      const r = off + 4 + i * 6;
      const start = t.readUInt16BE(r);
      if (glyph >= start && glyph <= t.readUInt16BE(r + 2))
        return t.readUInt16BE(r + 4) + glyph - start;
    }
  }
  return -1;
}

/** Classe do glifo (ClassDef do OpenType); fora da tabela, 0. */
function classOf(t, off, glyph) {
  if (t.readUInt16BE(off) === 1) {
    const start = t.readUInt16BE(off + 2);
    const count = t.readUInt16BE(off + 4);
    return glyph >= start && glyph < start + count
      ? t.readUInt16BE(off + 6 + (glyph - start) * 2)
      : 0;
  }
  for (let i = 0; i < t.readUInt16BE(off + 2); i++) {
    const r = off + 4 + i * 6;
    if (glyph >= t.readUInt16BE(r) && glyph <= t.readUInt16BE(r + 2)) return t.readUInt16BE(r + 4);
  }
  return 0;
}

const VALUE_SIZE = (format) => [...Array(8).keys()].filter((b) => format & (1 << b)).length * 2;
/** O avanço extra (XAdvance) de um ValueRecord, se ele tiver. */
function xAdvance(t, off, format) {
  if (!(format & 4)) return 0;
  return t.readInt16BE(off + ((format & 1) + ((format & 2) >> 1)) * 2);
}

/** Subtabelas de PairPos (tipo 2, inclusive dentro de Extension) do recurso "kern". */
function kernSubtables(gpos) {
  if (!gpos) return [];
  const features = gpos.readUInt16BE(6);
  const lookups = gpos.readUInt16BE(8);
  const indices = new Set();
  for (let i = 0; i < gpos.readUInt16BE(features); i++) {
    const rec = features + 2 + i * 6;
    if (gpos.toString('ascii', rec, rec + 4) !== 'kern') continue;
    const f = features + gpos.readUInt16BE(rec + 4);
    for (let j = 0; j < gpos.readUInt16BE(f + 2); j++)
      indices.add(gpos.readUInt16BE(f + 4 + j * 2));
  }
  const out = [];
  for (const li of indices) {
    const l = lookups + gpos.readUInt16BE(lookups + 2 + li * 2);
    const type = gpos.readUInt16BE(l);
    for (let s = 0; s < gpos.readUInt16BE(l + 4); s++) {
      let sub = l + gpos.readUInt16BE(l + 6 + s * 2);
      if (type === 9) {
        if (gpos.readUInt16BE(sub + 2) !== 2) continue;
        sub += gpos.readUInt32BE(sub + 4);
      } else if (type !== 2) continue;
      out.push(sub);
    }
  }
  return out;
}

/** Ajuste de kerning entre dois glifos, em unidades da fonte. */
function pairKern(gpos, subtables, left, right) {
  for (const sub of subtables) {
    const ci = coverageIndex(gpos, sub + gpos.readUInt16BE(sub + 2), left);
    if (ci < 0) continue;
    const vf1 = gpos.readUInt16BE(sub + 4);
    const vf2 = gpos.readUInt16BE(sub + 6);
    const size = VALUE_SIZE(vf1) + VALUE_SIZE(vf2);
    if (gpos.readUInt16BE(sub) === 1) {
      const set = sub + gpos.readUInt16BE(sub + 10 + ci * 2);
      for (let i = 0; i < gpos.readUInt16BE(set); i++) {
        const rec = set + 2 + i * (2 + size);
        if (gpos.readUInt16BE(rec) === right) return xAdvance(gpos, rec + 2, vf1);
      }
    } else {
      const c1 = classOf(gpos, sub + gpos.readUInt16BE(sub + 8), left);
      const c2 = classOf(gpos, sub + gpos.readUInt16BE(sub + 10), right);
      const class2Count = gpos.readUInt16BE(sub + 14);
      const rec = sub + 16 + (c1 * class2Count + c2) * size;
      const v = xAdvance(gpos, rec, vf1);
      if (v !== 0) return v;
    }
  }
  return 0;
}

/** Fonte pronta para virar curvas: métricas, glifo por caractere, contornos e kerning. */
export function loadFont(file) {
  const t = woffTables(file);
  const upm = t.head.readUInt16BE(18);
  const longLoca = t.head.readInt16BE(50) === 1;
  const metrics = t.hhea.readUInt16BE(34);
  const loca = (g) => (longLoca ? t.loca.readUInt32BE(g * 4) : t.loca.readUInt16BE(g * 2) * 2);
  const advance = (g) => t.hmtx.readUInt16BE(4 * Math.min(g, metrics - 1));

  let cmap4 = -1;
  for (let i = 0; i < t.cmap.readUInt16BE(2); i++) {
    const off = t.cmap.readUInt32BE(8 + i * 8);
    if (t.cmap.readUInt16BE(off) === 4) cmap4 = off;
  }
  const glyphOf = (code) => {
    const c = t.cmap;
    const segX2 = c.readUInt16BE(cmap4 + 6);
    const ends = cmap4 + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    for (let i = 0; i < segX2 / 2; i++) {
      if (code > c.readUInt16BE(ends + i * 2)) continue;
      const start = c.readUInt16BE(starts + i * 2);
      if (code < start) return 0;
      const delta = c.readInt16BE(deltas + i * 2);
      const ro = c.readUInt16BE(ranges + i * 2);
      if (ro === 0) return (code + delta) & 0xffff;
      const g = c.readUInt16BE(ranges + i * 2 + ro + (code - start) * 2);
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  };

  /** Contornos do glifo: listas de pontos {x, y, on} em unidades da fonte (y para cima). */
  const contours = (g) => {
    const start = loca(g);
    if (loca(g + 1) === start) return [];
    const d = t.glyf.subarray(start, loca(g + 1));
    const count = d.readInt16BE(0);
    if (count < 0) {
      const out = [];
      let p = 10;
      for (;;) {
        const flags = d.readUInt16BE(p);
        const part = d.readUInt16BE(p + 2);
        p += 4;
        const words = flags & 1;
        const dx = words ? d.readInt16BE(p) : d.readInt8(p);
        const dy = words ? d.readInt16BE(p + 2) : d.readInt8(p + 1);
        p += words ? 4 : 2;
        let [a, b, c, e] = [1, 0, 0, 1];
        if (flags & 8) {
          a = e = d.readInt16BE(p) / 16384;
          p += 2;
        } else if (flags & 0x40) {
          [a, e] = [d.readInt16BE(p) / 16384, d.readInt16BE(p + 2) / 16384];
          p += 4;
        } else if (flags & 0x80) {
          [a, b, c, e] = [0, 2, 4, 6].map((k) => d.readInt16BE(p + k) / 16384);
          p += 8;
        }
        for (const ct of contours(part))
          out.push(
            ct.map((q) => ({ x: a * q.x + c * q.y + dx, y: b * q.x + e * q.y + dy, on: q.on })),
          );
        if (!(flags & 0x20)) return out;
      }
    }
    const ends = [...Array(count).keys()].map((i) => d.readUInt16BE(10 + i * 2));
    const points = ends[count - 1] + 1;
    let p = 12 + count * 2 + d.readUInt16BE(10 + count * 2);
    const flags = [];
    while (flags.length < points) {
      const f = d[p++];
      flags.push(f);
      if (f & 8) for (let r = d[p++]; r > 0; r--) flags.push(f);
    }
    const axis = (short, same) => {
      const out = [];
      let v = 0;
      for (const f of flags) {
        if (f & short) v += f & same ? d[p++] : -d[p++];
        else if (!(f & same)) {
          v += d.readInt16BE(p);
          p += 2;
        }
        out.push(v);
      }
      return out;
    };
    const xs = axis(2, 16);
    const ys = axis(4, 32);
    let first = 0;
    return ends.map((end) => {
      const ct = [];
      for (let i = first; i <= end; i++) ct.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) === 1 });
      first = end + 1;
      return ct;
    });
  };

  const subtables = kernSubtables(t.GPOS);
  const kern = (a, b) => (subtables.length ? pairKern(t.GPOS, subtables, a, b) : 0);
  return {
    upm,
    ascender: t.hhea.readInt16BE(4),
    descender: t.hhea.readInt16BE(6),
    glyphOf,
    advance,
    contours,
    kern,
  };
}

const r2 = (n) => Math.round(n * 100) / 100;

/** Um contorno quadrático (TrueType) como comandos M/L/Q/Z. */
function contourPath(pts) {
  const n = pts.length;
  let at = pts.findIndex((q) => q.on);
  const start = at < 0 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : pts[at];
  if (at < 0) at = 0;
  let d = `M${r2(start.x)} ${r2(start.y)}`;
  let ctrl = null;
  for (let i = 1; i <= n; i++) {
    const q = pts[(at + i) % n];
    if (q.on) {
      d += ctrl ? `Q${r2(ctrl.x)} ${r2(ctrl.y)} ${r2(q.x)} ${r2(q.y)}` : `L${r2(q.x)} ${r2(q.y)}`;
      ctrl = null;
    } else if (ctrl) {
      d += `Q${r2(ctrl.x)} ${r2(ctrl.y)} ${r2((ctrl.x + q.x) / 2)} ${r2((ctrl.y + q.y) / 2)}`;
      ctrl = q;
    } else ctrl = q;
  }
  if (ctrl) d += `Q${r2(ctrl.x)} ${r2(ctrl.y)} ${r2(start.x)} ${r2(start.y)}`;
  return `${d}Z`;
}

/** Largura do texto em px, com kerning e espaçamento (em, como o letter-spacing do CSS). */
export function textWidth(font, text, size, tracking = 0) {
  return textPath(font, text, size, { tracking }).width;
}

/**
 * O texto como "d" de um <path>: `x` é o começo da linha e `y` a linha de base, em px. Devolve
 * também a largura ocupada (sem o espaçamento depois da última letra).
 */
export function textPath(font, text, size, { x = 0, y = 0, tracking = 0 } = {}) {
  const k = size / font.upm;
  let pen = x;
  let d = '';
  let prev = -1;
  for (const ch of text) {
    const g = font.glyphOf(ch.codePointAt(0));
    if (prev >= 0) pen += font.kern(prev, g) * k;
    for (const ct of font.contours(g))
      d += contourPath(ct.map((q) => ({ x: pen + q.x * k, y: y - q.y * k, on: q.on })));
    pen += font.advance(g) * k + tracking * size;
    prev = g;
  }
  return { d, width: pen - x - (text.length ? tracking * size : 0) };
}
