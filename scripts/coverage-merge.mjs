#!/usr/bin/env node
/**
 * Cobertura do backend (ADR 59): une a dos testes unitários com a dos de integração e confere a meta.
 *
 *   npm run -w @escambo/api test:cov        → apps/api/coverage/unit/coverage-final.json
 *   npm run -w @escambo/api test:int:cov    → apps/api/coverage/integration/coverage-final.json
 *   node scripts/coverage-merge.mjs         → apps/api/coverage/merged (lcov + json-summary)
 *
 * Os dois relatórios contam todo arquivo de apps/api/src (carregado ou não), então a união é sobre o
 * mesmo universo. Um relatório ausente é erro: a meta nunca é conferida pela metade.
 * A meta vem de COVERAGE_MIN (padrão 75, a do Playbook para o backend) e vale para linhas e instruções.
 *
 * Também grava coverage/sonar.lcov.info na raiz do repositório: a união do backend, com caminhos
 * relativos à raiz e barra normal — o SonarCloud resolve assim, venha de que job (ou sistema) vier.
 * O web fica de fora desse arquivo: o Sonar mostra um número só por projeto, e somar as duas
 * aplicações daria uma média que não é a meta de nenhuma (a do web é conferida pelo Vitest).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import libCoverage from 'istanbul-lib-coverage';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const api = join(root, 'apps/api');
const inputs = ['unit', 'integration'].map((kind) => ({
  kind,
  file: join(api, 'coverage', kind, 'coverage-final.json'),
}));
const outDir = join(api, 'coverage', 'merged');
const min = Number(process.env.COVERAGE_MIN || 75);
if (!Number.isFinite(min) || min <= 0 || min > 100) {
  console.error(`✗ COVERAGE_MIN inválido: ${process.env.COVERAGE_MIN}`);
  process.exit(1);
}

const map = libCoverage.createCoverageMap({});
const partial = {};
for (const { kind, file } of inputs) {
  if (!existsSync(file)) {
    console.error(`✗ Falta o relatório de ${kind}: ${file}`);
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(file, 'utf8'));
  partial[kind] = libCoverage.createCoverageMap(data).getCoverageSummary().lines.pct;
  map.merge(data);
}

mkdirSync(outDir, { recursive: true });
const context = libReport.createContext({
  dir: outDir,
  coverageMap: map,
  defaultSummarizer: 'nested',
});
for (const name of ['lcovonly', 'json-summary', 'text-summary']) {
  reports.create(name).execute(context);
}

const total = map.getCoverageSummary();
const lines = total.lines.pct;
const statements = total.statements.pct;
const summary = [
  '### Cobertura do backend (unitários + integração)',
  '',
  '| Relatório | Linhas |',
  '|---|---|',
  `| Só unitários | ${partial.unit}% |`,
  `| Só integração | ${partial.integration}% |`,
  `| **União** | **${lines}%** (instruções ${statements}%) |`,
  '',
  `Meta: ${min}%.`,
].join('\n');
writeFileSync(join(outDir, 'summary.md'), `${summary}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, { flag: 'a' });
}

// LCOV para o Sonar: um bloco por arquivo, caminho relativo à raiz do repositório.
function lcov(coverageMap) {
  const out = [];
  for (const file of coverageMap.files()) {
    const fc = coverageMap.fileCoverageFor(file);
    const hits = fc.getLineCoverage();
    out.push('TN:', `SF:${relative(root, file).split(sep).join('/')}`);
    for (const [line, count] of Object.entries(hits)) out.push(`DA:${line},${count}`);
    const found = Object.keys(hits).length;
    const hit = Object.values(hits).filter((c) => c > 0).length;
    out.push(`LF:${found}`, `LH:${hit}`, 'end_of_record');
  }
  return out.join('\n');
}
mkdirSync(join(root, 'coverage'), { recursive: true });
writeFileSync(join(root, 'coverage', 'sonar.lcov.info'), `${lcov(map)}\n`);

// `!(x >= min)`, e não `x < min`: relatório vazio dá "Unknown", e a comparação com ele é sempre falsa.
if (map.files().length === 0 || !(lines >= min) || !(statements >= min)) {
  console.error(
    `✗ Cobertura do backend abaixo da meta: linhas ${lines}%, instruções ${statements}% (meta ${min}%)`,
  );
  process.exit(1);
}
console.log(`✓ Cobertura do backend: linhas ${lines}%, instruções ${statements}% (meta ${min}%)`);
