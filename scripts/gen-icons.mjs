/**
 * Gera os PNGs de ícone e a capa de compartilhamento a partir do SVG da marca, usando o
 * Chromium que os testes e2e já instalam (nenhuma dependência nova):
 *
 *   node scripts/gen-icons.mjs
 *
 * Saída em apps/web/public: icon-192, icon-512, icon-maskable-512 (com a margem de segurança
 * exigida pelo Android), apple-touch-icon (180) e og-cover (1200x630, prévia de link).
 * Os arquivos são versionados — rode de novo só quando a marca mudar.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'public');
const GREEN = '#0d5c3a';
const svg = readFileSync(join(PUBLIC_DIR, 'favicon.svg'), 'utf8');

/** O ícone em qualquer tamanho; `inset` deixa a margem de segurança do formato maskable. */
const iconPage = (size, inset = 0) => `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0}
  body{width:${size}px;height:${size}px;background:${GREEN};display:grid;place-items:center}
  svg{width:${size - inset * 2}px;height:${size - inset * 2}px}
  svg rect{fill:none}
</style>${svg}`;

const coverPage = () => `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0}
  body{width:1200px;height:630px;background:${GREEN};color:#fff;display:flex;flex-direction:column;
       justify-content:center;gap:18px;padding:0 96px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
  .mark{width:104px;height:104px}
  h1{font-size:76px;margin:0;letter-spacing:-.02em}
  p{font-size:34px;margin:0;opacity:.92;line-height:1.35}
  .tags{display:flex;gap:14px;margin-top:14px}
  .tag{font-size:24px;border:2px solid rgba(255,255,255,.55);border-radius:999px;padding:8px 20px}
</style>
<div class="mark">${svg}</div>
<h1>Escambo</h1>
<p>Contrate com pagamento protegido, troque serviço por serviço<br />e use créditos de tempo.</p>
<div class="tags"><span class="tag">Escrow</span><span class="tag">Trocas</span><span class="tag">Créditos</span><span class="tag">Score</span></div>`;

const browser = await chromium.launch();
try {
  for (const [file, size, inset] of [
    ['icon-192.png', 192, 0],
    ['icon-512.png', 512, 0],
    ['icon-maskable-512.png', 512, 96],
    ['apple-touch-icon.png', 180, 0],
  ]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(iconPage(size, inset));
    writeFileSync(join(PUBLIC_DIR, file), await page.screenshot());
    await page.close();
    console.log(`✓ ${file} (${size}px${inset ? `, margem ${inset}px` : ''})`);
  }

  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(coverPage());
  writeFileSync(join(PUBLIC_DIR, 'og-cover.png'), await page.screenshot());
  await page.close();
  console.log('✓ og-cover.png (1200x630)');
} finally {
  await browser.close();
}
