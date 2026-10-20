#!/usr/bin/env node
/**
 * Grafo de dependências entre os módulos da API (RNF-021): quem importa o quê de quem.
 *
 *   node scripts/module-graph.mjs            → markdown no terminal
 *   node scripts/module-graph.mjs --json     → o mesmo grafo em JSON (para comparar versões)
 *   node scripts/module-graph.mjs --tests    → conta também os arquivos *.test.ts
 *
 * Lê os imports de apps/api/src com o parser do TypeScript (já é dependência da raiz), inclusive
 * `export … from` e `import()` dinâmico, e classifica o arquivo importado pelo sufixo do nome:
 * repository, service, controller, routes, schema ou outro (regras puras, helpers de SQL, tipos).
 * `import type` (ou só especificadores `type`) conta à parte: some na compilação e não acessa banco.
 * Também lista os ciclos de import em tempo de execução.
 *
 * A regra que protege as fronteiras está em apps/api/eslint.boundaries.mjs; este script só mede.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'apps/api/src');
const args = new Set(process.argv.slice(2));
const withTests = args.has('--tests');

/** Caminho relativo a apps/api/src, sempre com barra normal. */
const rel = (abs) => relative(src, abs).split(sep).join('/');

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(abs));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      if (withTests || !entry.name.endsWith('.test.ts')) out.push(abs);
    }
  }
  return out;
}

/** A que "nó" o arquivo pertence: o módulo (modules/<nome>) ou a pasta de fora (jobs, config…). */
function ownerOf(file) {
  const parts = file.split('/');
  if (parts[0] === 'modules' && parts.length > 2) return parts[1];
  if (parts.length === 1) return '(raiz)';
  return `(${parts[0]})`;
}

const isModule = (owner) => !owner.startsWith('(');

/** Camada pelo sufixo do nome: x.repository.ts, x.earnings.repository.ts, x.facade.ts… */
function layerOf(file) {
  const base = file.split('/').pop().replace(/\.ts$/, '');
  for (const layer of ['repository', 'facade', 'service', 'controller', 'routes', 'schema']) {
    if (base === layer || base.endsWith(`.${layer}`)) return layer;
  }
  return 'outro';
}

/** Os imports do arquivo: especificador e se é só de tipo. */
function importsOf(abs) {
  const code = readFileSync(abs, 'utf8');
  const sf = ts.createSourceFile(abs, code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const found = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      let typeOnly = Boolean(clause?.isTypeOnly);
      if (!typeOnly && clause && !clause.name && clause.namedBindings) {
        const nb = clause.namedBindings;
        typeOnly =
          ts.isNamedImports(nb) && nb.elements.length > 0 && nb.elements.every((e) => e.isTypeOnly);
      }
      found.push({ spec: node.moduleSpecifier.text, typeOnly });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push({ spec: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.push({ spec: node.arguments[0].text, typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const edges = [];
/** Grafo arquivo → arquivo dos imports de valor (o que existe em tempo de execução). */
const runtime = new Map();
for (const abs of listFiles(src)) {
  const from = rel(abs);
  runtime.set(from, []);
  for (const { spec, typeOnly } of importsOf(abs)) {
    if (!spec.startsWith('.')) continue; // pacote npm ou @escambo/types: fora do grafo
    const to = rel(resolve(dirname(abs), spec)) + '.ts';
    if (!typeOnly) runtime.get(from).push(to);
    const fromOwner = ownerOf(from);
    const toOwner = ownerOf(to);
    if (fromOwner === toOwner || !isModule(toOwner)) continue; // dentro do módulo, ou utilitário
    edges.push({
      from,
      to,
      fromOwner,
      toOwner,
      fromLayer: layerOf(from),
      toLayer: layerOf(to),
      typeOnly,
    });
  }
}

/** Violações de camada dentro do módulo: controller e routes não importam repository. */
const layerViolations = [];
for (const abs of listFiles(src)) {
  const from = rel(abs);
  const layer = layerOf(from);
  if (!isModule(ownerOf(from)) || (layer !== 'controller' && layer !== 'routes')) continue;
  for (const { spec, typeOnly } of importsOf(abs)) {
    if (!spec.startsWith('.') || typeOnly) continue;
    const to = rel(resolve(dirname(abs), spec)) + '.ts';
    if (layerOf(to) === 'repository') layerViolations.push({ from, to });
  }
}

/**
 * Ciclos de import em tempo de execução (componentes fortemente conexos, Tarjan). Uma chamada de
 * service para service entre módulos pode fechar um ciclo; a fachada, que só importa o próprio
 * repository, não fecha.
 */
function cyclesOf(graph) {
  let next = 0;
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const found = [];
  const visit = (v) => {
    index.set(v, next);
    low.set(v, next);
    next += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const scc = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) found.push(scc.sort());
    }
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return found;
}
const cycles = cyclesOf(runtime);

const foreignRepo = edges.filter((e) => isModule(e.fromOwner) && e.toLayer === 'repository');
const foreignRepoValue = foreignRepo.filter((e) => !e.typeOnly);

/** Por módulo: arestas (arquivo → repository alheio) e módulos distintos alcançados. */
function perModule(list) {
  const map = new Map();
  for (const e of list) {
    const m = map.get(e.fromOwner) ?? { edges: 0, targets: new Set() };
    m.edges += 1;
    m.targets.add(e.toOwner);
    map.set(e.fromOwner, m);
  }
  return [...map.entries()].sort((a, b) => b[1].edges - a[1].edges || a[0].localeCompare(b[0]));
}

if (args.has('--json')) {
  console.log(
    JSON.stringify(
      {
        totals: {
          crossModuleImports: edges.filter((e) => isModule(e.fromOwner)).length,
          foreignRepositoryImports: foreignRepoValue.length,
          foreignRepositoryTypeImports: foreignRepo.length - foreignRepoValue.length,
          layerViolations: layerViolations.length,
          cycles: cycles.length,
        },
        edges,
        layerViolations,
        cycles,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const lines = [];
const out = (s = '') => lines.push(s);
out('# Grafo de módulos da API');
out();
out(`Arquivos lidos: ${listFiles(src).length}${withTests ? ' (com testes)' : ' (sem *.test.ts)'}.`);
out();
out('## Repository de outro módulo (import de valor)');
out();
out('| Módulo | Arestas | Módulos alcançados |');
out('| --- | ---: | --- |');
for (const [mod, m] of perModule(foreignRepoValue)) {
  out(`| ${mod} | ${m.edges} | ${[...m.targets].sort().join(', ')} |`);
}
out(`| **total** | **${foreignRepoValue.length}** | |`);
out();
for (const e of foreignRepoValue) out(`- \`${e.from}\` → \`${e.to}\``);
const typeOnlyRepo = foreignRepo.filter((e) => e.typeOnly);
if (typeOnlyRepo.length) {
  out();
  out('Só de tipo (`import type`, some na compilação):');
  out();
  for (const e of typeOnlyRepo) out(`- \`${e.from}\` → \`${e.to}\``);
}
out();
out('## Controller ou routes importando repository');
out();
if (!layerViolations.length) out('Nenhum.');
for (const v of layerViolations) out(`- \`${v.from}\` → \`${v.to}\``);
out();
out('## Ciclos de import (em tempo de execução)');
out();
if (!cycles.length) out('Nenhum.');
for (const c of cycles) out(`- ${c.map((f) => `\`${f}\``).join(' ↔ ')}`);
out();
out('## Todas as arestas entre módulos, por camada do arquivo importado');
out();
out('| De | Para | repository | fachada | service | schema | outro | só tipo |');
out('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
const pairs = new Map();
for (const e of edges.filter((x) => isModule(x.fromOwner))) {
  const key = `${e.fromOwner} → ${e.toOwner}`;
  const p = pairs.get(key) ?? {
    repository: 0,
    facade: 0,
    service: 0,
    schema: 0,
    outro: 0,
    tipo: 0,
  };
  if (e.typeOnly) p.tipo += 1;
  else if (e.toLayer in p) p[e.toLayer] += 1;
  else p.outro += 1;
  pairs.set(key, p);
}
for (const [key, p] of [...pairs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const [de, para] = key.split(' → ');
  out(
    `| ${de} | ${para} | ${p.repository} | ${p.facade} | ${p.service} | ${p.schema} | ${p.outro} | ${p.tipo} |`,
  );
}
out();
out('## Fora dos módulos (jobs, scripts, middlewares…) usando repository de módulo');
out();
out('Orquestradores fora de `modules/`: não entram na regra de fronteira, ficam aqui para medida.');
out();
const outside = edges.filter((e) => !isModule(e.fromOwner) && e.toLayer === 'repository');
for (const [mod, m] of perModule(outside.filter((e) => !e.typeOnly))) {
  out(`- ${mod}: ${m.edges} (${[...m.targets].sort().join(', ')})`);
}
console.log(lines.join('\n'));
