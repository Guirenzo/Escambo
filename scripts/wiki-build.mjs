#!/usr/bin/env node
/**
 * Gera as páginas da Wiki do GitHub a partir do repositório (ADR 59): a Wiki nunca diverge dos arquivos.
 *
 *   node scripts/wiki-build.mjs [pasta-de-saída]     (padrão: .wiki-build)
 *
 * Entram as páginas escritas para a Wiki (docs/wiki/*.md) e os documentos do repositório listados em PAGES,
 * com os links relativos reescritos: .md mapeado vira link de página da Wiki; imagem vira raw.githubusercontent;
 * o resto vira link para o arquivo no GitHub. Um link relativo para arquivo inexistente é erro (a Wiki não
 * publica link quebrado), e um documento da lista que sumiu também. Código (bloco cercado ou trecho entre
 * crases) fica como está.
 *
 * A pasta de saída é apagada antes de gerar. Por isso só é aceita uma pasta `.wiki-*` na raiz do
 * repositório: qualquer outro caminho é recusado antes de apagar o que quer que seja.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, normalize, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, process.argv[2] ?? '.wiki-build');
const REPO = 'https://github.com/Guirenzo/Escambo';
const RAW = 'https://raw.githubusercontent.com/Guirenzo/Escambo/main';

/**
 * Documento do repositório → nome da página na Wiki (com hífens). O GitHub mostra o nome do arquivo
 * como título da página, então os nomes levam acento.
 */
const PAGES = {
  'docs/RFC.md': 'RFC',
  'docs/requisitos-funcionais.md': 'Requisitos-Funcionais',
  'docs/requisitos-nao-funcionais.md': 'Requisitos-Não-Funcionais',
  'docs/regras-de-negocio.md': 'Regras-de-Negócio',
  'docs/casos-de-uso.md': 'Casos-de-Uso',
  'docs/decisoes.md': 'Decisões-de-Arquitetura',
  'docs/modelagem-banco.md': 'Modelagem-do-Banco',
  'docs/personas.md': 'Personas',
  'docs/fluxo-navegacao.md': 'Fluxo-de-Navegação',
  'docs/wireframes.md': 'Wireframes',
  'docs/benchmarking.md': 'Benchmarking',
  'docs/trabalhos-relacionados.md': 'Trabalhos-Relacionados',
  'docs/evidencias-validacao.md': 'Evidências-de-Validação',
  'DEPLOY.md': 'Guia-de-Deploy',
  'CONTRIBUTING.md': 'Como-Contribuir',
  'CHANGELOG.md': 'Changelog',
};
for (const f of readdirSync(join(root, 'docs/wiki'))) {
  if (f.endsWith('.md')) PAGES[`docs/wiki/${f}`] = f.slice(0, -3);
}

const pageNames = new Set(Object.values(PAGES));
const IMAGE = /\.(png|jpe?g|gif|svg|webp)$/i;
const broken = [];

/** Reescreve um alvo relativo de link ou imagem, visto a partir de `from` (caminho no repositório). */
function rewrite(target, from) {
  if (/^([a-z]+:|#|\/\/)/i.test(target)) return target; // http(s), mailto, âncora
  const [path, anchor] = target.split('#');
  if (!path) return target;
  if (pageNames.has(decodeURI(path))) return target; // já é o nome de uma página da Wiki
  const repoPath = normalize(join(dirname(from), decodeURI(path)))
    .split('\\')
    .join('/');
  const hash = anchor ? `#${anchor}` : '';
  if (repoPath.startsWith('..')) {
    // Sai do repositório: é uma página do GitHub (ex.: ../../discussions, visto de /blob/main/).
    const web = posix.normalize(posix.join('Guirenzo/Escambo/blob/main', dirname(from), path));
    return `https://github.com/${web}${hash}`;
  }
  if (PAGES[repoPath]) return `${PAGES[repoPath]}${hash}`;
  const abs = join(root, repoPath);
  if (!existsSync(abs)) {
    broken.push(`${from} → ${target}`);
    return target;
  }
  if (IMAGE.test(repoPath)) return `${RAW}/${repoPath}`;
  const kind = statSync(abs).isDirectory() ? 'tree' : 'blob';
  return `${REPO}/${kind}/main/${repoPath}${hash}`;
}

/** Links e imagens de um trecho de texto corrido (sem código). */
function convertProse(text, from) {
  return (
    text
      .replace(
        /(!?\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g,
        (_m, a, t, b) => `${a}${rewrite(t, from)}${b}`,
      )
      // Imagem que é link: [![selo](imagem)](destino). A imagem já foi reescrita acima; falta o destino.
      .replace(
        /(\[!\[[^\]]*\]\([^)]*\)\]\()([^)\s]+)(\))/g,
        (_m, a, t, b) => `${a}${rewrite(t, from)}${b}`,
      )
      .replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/g, (_m, a, t, b) => `${a}${rewrite(t, from)}${b}`)
  );
}

/** Reescreve os links do documento, deixando o código (bloco cercado ou trecho entre crases) como está. */
function convert(text, from) {
  return text
    .split(/(^```[\s\S]*?^```[^\n]*$)/m)
    .map((block, i) =>
      i % 2 === 1
        ? block
        : block
            .split(/(`[^`\n]*`)/)
            .map((piece, j) => (j % 2 === 1 ? piece : convertProse(piece, from)))
            .join(''),
    )
    .join('');
}

// Só uma pasta `.wiki-*` na raiz do repositório pode ser apagada e recriada.
const outRel = relative(root, out);
if (!/^\.wiki[\w.-]*$/.test(outRel)) {
  console.error(`✗ Pasta de saída recusada: ${out}. Use uma pasta .wiki-* na raiz do repositório.`);
  process.exit(1);
}
const missing = Object.keys(PAGES).filter((from) => !existsSync(join(root, from)));
if (missing.length) {
  console.error(`✗ Documentos da lista PAGES que não existem:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
let count = 0;
for (const [from, page] of Object.entries(PAGES)) {
  const text = readFileSync(join(root, from), 'utf8');
  const source =
    from.startsWith('docs/wiki/') || page.startsWith('_')
      ? ''
      : `\n\n---\n_Página gerada de [\`${from}\`](${REPO}/blob/main/${from}); edite lá._\n`;
  writeFileSync(join(out, `${page}.md`), `${convert(text, from).trimEnd()}${source}\n`);
  count++;
}

if (broken.length) {
  console.error(`✗ Links relativos quebrados:\n  ${broken.join('\n  ')}`);
  process.exit(1);
}
console.log(`✓ ${count} páginas em ${relative(root, out)}/`);
