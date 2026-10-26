/**
 * Gera a marca em arquivos a partir do símbolo (o mesmo de apps/web/src/components/BrandMark.tsx)
 * e do logotipo em curvas (Sora 700, scripts/text-outline.mjs), com o sharp que a API já usa
 * (nenhuma dependência nova):
 *
 *   node scripts/gen-icons.mjs
 *
 * Saída em apps/web/public: favicon.svg; marca/escambo-simbolo.svg, marca/escambo-logo.svg (sobre
 * o claro) e marca/escambo-logo-negativo.svg (sobre o escuro); os PNGs icon-192, icon-512,
 * icon-maskable-512 (com a margem de segurança do Android), apple-touch-icon (180) e og-cover
 * (1200x630, prévia de link). Os arquivos são versionados: rode de novo só quando a marca mudar.
 */
import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFont, textPath, textWidth } from './text-outline.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'apps', 'web', 'public');
const FONTS = join(ROOT, 'node_modules', '@fontsource');
const sharp = createRequire(join(ROOT, 'apps', 'api', 'package.json'))('sharp');

// Cores da marca (tokens de apps/web/src/styles.css).
const DEEP = '#062a1b';
const GREEN = '#0d5c3a';
const AMBER_BRIGHT = '#f6b73c';
const AMBER_ON_LIGHT = '#c47f0a';
const TEXT = '#0f1a14';
const ON_DARK_MUTED = '#c2d6cb';

// O símbolo na grade de 32: a moeda em duas peças iguais (uma é a outra girada 180°).
const PIECE_A = 'M18.625 3.268A13 13 0 0 0 10.625 27.837V14.625H18.625Z';
const PIECE_B = 'M13.375 28.732A13 13 0 0 0 21.375 4.163V17.375H13.375Z';
/** O símbolo em `size` px com o canto em (x, y). */
const mark = (x, y, size, a, b) =>
  `<g transform="translate(${x} ${y}) scale(${size / 32})"><path fill="${a}" d="${PIECE_A}"/><path fill="${b}" d="${PIECE_B}"/></g>`;

const sora = loadFont(join(FONTS, 'sora', 'files', 'sora-latin-700-normal.woff'));
const inter = loadFont(join(FONTS, 'inter', 'files', 'inter-latin-500-normal.woff'));
const TRACKING = -0.02; // o mesmo letter-spacing do .brand-name

/** Ladrilho do ícone: o símbolo sobre o verde-escuro, com `inset` de margem (maskable). */
const tile = (size, { inset = 0, radius = 0 } = {}) => {
  const coin = (size - inset * 2) * 0.92;
  const at = Math.round(((size - coin) / 2) * 100) / 100;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${radius}" fill="${DEEP}"/>${mark(at, at, coin, '#ffffff', AMBER_BRIGHT)}</svg>`;
};

/** Símbolo + logotipo numa linha; `dark` usa as cores de sobre o escuro. */
function logo(dark) {
  const size = 64;
  const font = 44;
  const gap = 18;
  const word = textPath(sora, 'Escambo', font, { x: size + gap, y: 47, tracking: TRACKING });
  const w = Math.ceil(size + gap + word.width + 2);
  const [a, b, ink] = dark ? ['#ffffff', AMBER_BRIGHT, '#ffffff'] : [GREEN, AMBER_ON_LIGHT, TEXT];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${size}" viewBox="0 0 ${w} ${size}" role="img" aria-label="Escambo">${mark(0, 0, size, a, b)}<path fill="${ink}" d="${word.d}"/></svg>\n`;
}

/** Quebra o texto em linhas de até `max` px na fonte dada. */
function wrap(font, text, size, max, tracking = 0) {
  const lines = [];
  let line = '';
  for (const w of text.split(' ')) {
    const next = line ? `${line} ${w}` : w;
    if (line && textWidth(font, next, size, tracking) > max) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  return [...lines, line];
}

/**
 * Capa de compartilhamento: fundo verde-escuro sólido (todo texto sobre cor sólida), a marca, a
 * chamada da página inicial e a moeda grande à direita, cortada pela borda.
 */
function cover() {
  const W = 1200;
  const H = 630;
  const left = 88;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${DEEP}"/>`;
  svg += mark(760, 95, 520, '#0b3a26', '#0e4630');
  svg += mark(left, 84, 56, '#ffffff', AMBER_BRIGHT);
  const brand = textPath(sora, 'Escambo', 40, { x: left + 72, y: 126, tracking: TRACKING });
  svg += `<path fill="#ffffff" d="${brand.d}"/>`;
  const head = ['Troque o que você sabe', 'fazer pelo que você', 'precisa.'];
  head.forEach((line, i) => {
    const y = 268 + i * 76;
    if (i === 0) {
      const first = textPath(sora, 'Troque', 66, { x: left, y, tracking: -0.03 });
      const rest = textPath(sora, line.slice(6), 66, {
        x: left + first.width + 66 * -0.03,
        y,
        tracking: -0.03,
      });
      svg += `<path fill="${AMBER_BRIGHT}" d="${first.d}"/><path fill="#ffffff" d="${rest.d}"/>`;
    } else {
      svg += `<path fill="#ffffff" d="${textPath(sora, line, 66, { x: left, y, tracking: -0.03 }).d}"/>`;
    }
  });
  const sub = wrap(
    inter,
    'Contrate com o pagamento guardado até aprovar a entrega, ou troque serviço por serviço.',
    28,
    660,
  );
  sub.forEach((line, i) => {
    svg += `<path fill="${ON_DARK_MUTED}" d="${textPath(inter, line, 28, { x: left, y: 488 + i * 40 }).d}"/>`;
  });
  return `${svg}</svg>`;
}

mkdirSync(join(PUBLIC_DIR, 'marca'), { recursive: true });
writeFileSync(
  join(PUBLIC_DIR, 'favicon.svg'),
  tile(32, { radius: 8 }).replace('<svg ', '<svg role="img" aria-label="Escambo" ') + '\n',
);
writeFileSync(
  join(PUBLIC_DIR, 'marca', 'escambo-simbolo.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Escambo"><path fill="${GREEN}" d="${PIECE_A}"/><path fill="${AMBER_ON_LIGHT}" d="${PIECE_B}"/></svg>\n`,
);
writeFileSync(join(PUBLIC_DIR, 'marca', 'escambo-logo.svg'), logo(false));
writeFileSync(join(PUBLIC_DIR, 'marca', 'escambo-logo-negativo.svg'), logo(true));
console.log('✓ favicon.svg e marca/*.svg');

for (const [file, size, inset] of [
  ['icon-192.png', 192, 0],
  ['icon-512.png', 512, 0],
  ['icon-maskable-512.png', 512, 72],
  ['apple-touch-icon.png', 180, 0],
]) {
  await sharp(Buffer.from(tile(size, { inset })))
    .png({ compressionLevel: 9 })
    .toFile(join(PUBLIC_DIR, file));
  console.log(`✓ ${file} (${size}px${inset ? `, margem ${inset}px` : ''})`);
}
await sharp(Buffer.from(cover()))
  .png({ compressionLevel: 9 })
  .toFile(join(PUBLIC_DIR, 'og-cover.png'));
console.log('✓ og-cover.png (1200x630)');
