import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ESLint } from 'eslint';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Fronteiras entre os módulos da API (RNF-021). A regra mora no ESLint
 * (apps/api/eslint.boundaries.mjs) e reprova o CI pelo `npm run lint`; aqui ela é posta à prova
 * com arquivos de exemplo, para uma mudança na configuração não a desligar em silêncio. Também
 * confere que cada exceção ainda existe no código (a lista não guarda sobra) e que o grafo de
 * imports da API não tem ciclo, que é o que deixa um módulo chamar a fachada do outro.
 */

const REPO_DIR = join(__dirname, '..', '..', '..', '..');
const SRC_DIR = join(__dirname, '..');
const RULE = 'no-restricted-imports';

interface RepositoryException {
  file: string;
  allow: string[];
  why: string;
}

/** Caminho relativo a apps/api/src, com barra normal (no Windows o separador é a contrabarra). */
const fromSrc = (abs: string): string => relative(SRC_DIR, abs).split(sep).join('/');

/** Os imports do arquivo que existem em tempo de execução (sem `import type`), como escritos. */
function runtimeImports(abs: string): string[] {
  // Sem os ponteiros de pai (último argumento): só os comandos do topo são lidos, e o parse fica
  // bem mais rápido, o que conta no teste do grafo, que lê a API inteira.
  const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.ES2022, false);
  const out: string[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const clause = st.importClause;
      const named = clause?.namedBindings;
      const typeOnly =
        clause?.isTypeOnly === true ||
        (!!clause &&
          !clause.name &&
          !!named &&
          ts.isNamedImports(named) &&
          named.elements.length > 0 &&
          named.elements.every((e) => e.isTypeOnly));
      if (!typeOnly) out.push(st.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(st) &&
      !st.isTypeOnly &&
      st.moduleSpecifier &&
      ts.isStringLiteral(st.moduleSpecifier)
    ) {
      out.push(st.moduleSpecifier.text);
    }
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(abs);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [abs] : [];
  });
}

describe('fronteiras entre módulos (ESLint)', { timeout: 60_000 }, () => {
  let eslint: ESLint;
  beforeAll(() => {
    eslint = new ESLint({ cwd: REPO_DIR });
  });

  /** Os erros da regra num arquivo de exemplo; o caminho decide qual bloco da configuração vale. */
  async function caught(file: string, code: string): Promise<string[]> {
    const [result] = await eslint.lintText(`${code}\n`, {
      filePath: join(SRC_DIR, ...file.split('/')),
    });
    return result!.messages.filter((m) => m.ruleId === RULE).map((m) => m.message);
  }

  it.each([
    [
      'service importa repository de outro módulo',
      'modules/foo/foo.service.ts',
      "import { barRepository } from '../bar/bar.repository';",
    ],
    [
      'repository importa repository de outro módulo',
      'modules/foo/foo.repository.ts',
      "import { barRepository } from '../bar/bar.repository';",
    ],
    [
      'arquivo de regra pura importa repository de outro módulo',
      'modules/foo/foo.ts',
      "import { barRepository } from '../bar/bar.repository';",
    ],
    [
      'caminho pela raiz até o repository de outro módulo',
      'modules/foo/foo.service.ts',
      "import { barRepository } from '../../modules/bar/bar.repository';",
    ],
    [
      're-export do repository de outro módulo',
      'modules/foo/foo.service.ts',
      "export { barRepository } from '../bar/bar.repository';",
    ],
    [
      'import de valor junto com tipo',
      'modules/foo/foo.service.ts',
      "import { barRepository, type BarRow } from '../bar/bar.repository';",
    ],
  ])('pega: %s', async (_, file, code) => {
    const messages = await caught(file, code);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('RNF-021: o repository é do módulo dono');
  });

  it.each([
    [
      'só o tipo do repository de outro módulo',
      'modules/foo/foo.service.ts',
      "import type { BarRow } from '../bar/bar.repository';",
    ],
    [
      'especificadores só de tipo',
      'modules/foo/foo.service.ts',
      "import { type BarRow } from '../bar/bar.repository';",
    ],
    [
      'fachada e service de outro módulo',
      'modules/foo/foo.service.ts',
      "import { barFacade } from '../bar/bar.facade';\nimport { barService } from '../bar/bar.service';",
    ],
    [
      'regra pura e schema de outro módulo',
      'modules/foo/foo.service.ts',
      "import { BAR_LIMIT } from '../bar/bar';\nimport { barSchema } from '../bar/bar.schema';",
    ],
    [
      'o próprio repository no service',
      'modules/foo/foo.service.ts',
      "import { fooRepository } from './foo.repository';",
    ],
    [
      'outro repository do próprio módulo',
      'modules/foo/foo.repository.ts',
      "import { fooItemsRepository } from './foo-items.repository';",
    ],
    [
      'teste, que mocka o repository de quem quiser',
      'modules/foo/foo.service.test.ts',
      "import { barRepository } from '../bar/bar.repository';",
    ],
  ])('deixa passar: %s', async (_, file, code) => {
    expect(await caught(file, code)).toEqual([]);
  });

  describe('camadas dentro do módulo', () => {
    it.each([
      [
        'controller',
        'modules/foo/foo.controller.ts',
        "import { fooRepository } from './foo.repository';",
      ],
      [
        'controller de outro nome',
        'modules/foo/foo.moderation.controller.ts',
        "import { fooRepository } from './foo.repository';",
      ],
      ['routes', 'modules/foo/foo.routes.ts', "import { fooRepository } from './foo.repository';"],
      [
        'controller, com o repository de outro módulo',
        'modules/foo/foo.controller.ts',
        "import { barRepository } from '../bar/bar.repository';",
      ],
    ])('%s não importa repository, nem o do próprio módulo', async (_, file, code) => {
      const messages = await caught(file, code);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('controller e routes não importam repository');
    });

    it('controller passa pelo service ou pela fachada; o tipo do repository é livre', async () => {
      const code = [
        "import { fooService } from './foo.service';",
        "import { barFacade } from '../bar/bar.facade';",
        "import type { FooRow } from './foo.repository';",
      ].join('\n');
      expect(await caught('modules/foo/foo.controller.ts', code)).toEqual([]);
    });
  });

  describe('a fachada é folha', () => {
    it('importa só os repositories do próprio módulo (e tipos)', async () => {
      const code = [
        "import { fooRepository } from './foo.repository';",
        "import { fooItemsRepository } from './foo-items.repository';",
        "import type { Foo } from '@escambo/types';",
      ].join('\n');
      expect(await caught('modules/foo/foo.facade.ts', code)).toEqual([]);
    });

    it.each([
      ['o service do próprio módulo', "import { fooService } from './foo.service';"],
      ['a fachada de outro módulo', "import { barFacade } from '../bar/bar.facade';"],
      ['o banco direto', "import { pool } from '../../config/db';"],
    ])('não importa %s', async (_, code) => {
      const messages = await caught('modules/foo/foo.facade.ts', code);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('a fachada só repassa ao repository do próprio módulo');
    });
  });

  describe('exceções (transações que cruzam domínios)', () => {
    it('a exceção vale para o alvo listado, só para ele e só naquele arquivo', async () => {
      const wallet = "import { walletRepository } from '../wallet/wallet.repository';";
      expect(await caught('modules/payments/payments.repository.ts', wallet)).toEqual([]);
      expect(
        await caught(
          'modules/payments/payments.repository.ts',
          "import { authRepository } from '../auth/auth.repository';",
        ),
      ).toHaveLength(1);
      expect(await caught('modules/payments/payments.service.ts', wallet)).toHaveLength(1);
    });
  });
});

describe('exceções da regra: a lista não guarda sobra', { timeout: 60_000 }, () => {
  it('cada arquivo listado existe, tem o motivo e ainda importa cada repository permitido', async () => {
    const config = join(REPO_DIR, 'apps', 'api', 'eslint.boundaries.mjs');
    const { REPOSITORY_EXCEPTIONS } = (await import(config)) as {
      REPOSITORY_EXCEPTIONS: RepositoryException[];
    };
    expect(REPOSITORY_EXCEPTIONS.length).toBeGreaterThan(0);
    for (const { file, allow, why } of REPOSITORY_EXCEPTIONS) {
      const abs = join(SRC_DIR, ...file.split('/'));
      expect(existsSync(abs), `${file} não existe mais: tire da lista`).toBe(true);
      expect(why.trim().length, `${file} sem motivo`).toBeGreaterThan(20);
      const imported = runtimeImports(abs);
      for (const target of allow) {
        expect(imported, `${file} não importa mais ${target}: tire da lista`).toContain(
          `../${target}`,
        );
      }
    }
  });
});

// Lê e analisa os ~280 arquivos da API: com a cobertura ligada e os outros testes em paralelo,
// passa dos 5 s do padrão.
describe('grafo de imports da API', { timeout: 60_000 }, () => {
  it('não tem ciclo em tempo de execução (o que deixa um módulo chamar a fachada do outro)', () => {
    const graph = new Map<string, string[]>();
    for (const abs of sourceFiles(SRC_DIR)) {
      graph.set(
        fromSrc(abs),
        runtimeImports(abs)
          .filter((spec) => spec.startsWith('.'))
          .map((spec) => `${fromSrc(resolve(dirname(abs), spec))}.ts`),
      );
    }
    // Busca em profundidade com três estados: aresta para um nó "na pilha" fecha um ciclo.
    const state = new Map<string, 'open' | 'done'>();
    const path: string[] = [];
    const cycles: string[] = [];
    const visit = (file: string): void => {
      state.set(file, 'open');
      path.push(file);
      for (const next of graph.get(file) ?? []) {
        if (!graph.has(next) || state.get(next) === 'done') continue;
        if (state.get(next) === 'open') {
          cycles.push([...path.slice(path.indexOf(next)), next].join(' → '));
        } else {
          visit(next);
        }
      }
      path.pop();
      state.set(file, 'done');
    };
    for (const file of graph.keys()) if (!state.has(file)) visit(file);
    expect(graph.size).toBeGreaterThan(100);
    expect(cycles).toEqual([]);
  });
});
