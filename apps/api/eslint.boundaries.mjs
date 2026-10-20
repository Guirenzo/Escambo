/**
 * Fronteiras entre os módulos da API (RNF-021), conferidas pelo ESLint no `npm run lint` da raiz,
 * que o CI roda: a violação é erro e reprova o build.
 *
 * 1. Um módulo não importa o `*.repository` de outro módulo. O repository é do módulo dono; quem é
 *    de fora chama o service dele ou a fachada (`<modulo>.facade.ts`), que só repassa ao repository
 *    e não importa mais nada (é folha no grafo de imports, então não cria ciclo).
 * 2. Dentro do módulo, controller e routes não importam repository: passam pelo service.
 * 3. A fachada só importa os repositories do próprio módulo.
 *
 * `import type` passa em todas: some na compilação e não acessa o banco. Os testes (`*.test.ts`)
 * ficam de fora, porque mockam o repository de quem quiserem. As transações de dinheiro cruzam os
 * domínios pelo `wallet.ledger` e pelo `wallet.locks` (a API transacional da carteira, ADRs 2, 3 e
 * 15), que não são repository e não entram aqui.
 *
 * O teste apps/api/src/modules/boundaries.test.ts roda o ESLint em arquivos de exemplo (a violação
 * nova é pega, a exceção vale só para o alvo listado) e confere que cada exceção abaixo ainda
 * existe no código, para a lista não guardar sobra. O grafo medido sai de scripts/module-graph.mjs.
 */

const MODULES = 'apps/api/src/modules';

/**
 * Exceções à regra 1: arquivo (relativo a apps/api/src) → repositories de outro módulo que ele pode
 * importar, e por quê. Só fica aqui o que precisa da mesma conexão ou da mesma transação de quem
 * chama, ou o que está dentro de uma transação de dinheiro que esta versão não reescreve. O resto
 * passou para a fachada do módulo dono.
 */
export const REPOSITORY_EXCEPTIONS = [
  // Transações de dinheiro (ADRs 3, 15 e 16). Todas chamam `walletRepository.ensure` (cria a linha
  // da carteira) no pool, antes de abrir a transação que trava e move o saldo pelo wallet.ledger. O
  // `ensure` não precisa da conexão, mas fica dentro da função da transação de dinheiro, que esta
  // versão não mexe: candidata a ir para uma fachada da carteira quando o fluxo for revisto.
  {
    file: 'modules/barter/barter.repository.ts',
    allow: ['wallet/wallet.repository'],
    why: 'ADR 16: a torna da troca é reservada e liquidada pela carteira na mesma transação do acordo.',
  },
  {
    file: 'modules/boosts/boosts.repository.ts',
    allow: ['wallet/wallet.repository'],
    why: 'ADR 3: o impulsionamento debita créditos com linha no ledger na mesma transação da compra.',
  },
  {
    file: 'modules/credits/credits.repository.ts',
    allow: ['wallet/wallet.repository'],
    why: 'ADR 3: o bônus de boas-vindas confere e credita sob a trava da carteira, numa transação.',
  },
  {
    file: 'modules/payments/payments.repository.ts',
    allow: ['wallet/wallet.repository'],
    why: 'ADR 15: o depósito pago credita a carteira e grava o extrato na mesma transação (RNF-038).',
  },
  {
    file: 'modules/withdrawal/withdrawal.repository.ts',
    allow: ['wallet/wallet.repository'],
    why: 'ADR 15: o saque reserva o saldo sob a trava da carteira na mesma transação do pedido.',
  },
  // Leitura com a conexão da transação de quem chama (a mesma trava, o mesmo instante).
  {
    file: 'modules/contracts/contracts.repository.ts',
    allow: ['dropouts/dropouts.repository'],
    why: 'ADRs 2 e 61: o cancelamento reconta as desistências com a conexão da transição, sob a trava da carteira, antes de devolver o dinheiro.',
  },
  {
    file: 'modules/disputes/disputes.repository.ts',
    allow: ['contracts/contracts.repository'],
    why: 'ADR 2: abrir e resolver a disputa lê a contratação com a conexão da transação que congela ou divide o escrow.',
  },
  {
    file: 'modules/dropouts/dropouts.repository.ts',
    allow: ['reports/reports.repository'],
    why: 'ADR 61: a revisão de conta por desistências é aberta na mesma transação que confere a contagem.',
  },
  {
    file: 'modules/contracts/delivery-files.ts',
    allow: ['messaging/messaging.repository'],
    why: 'ADR 63: os arquivos da entrega viram mensagens do chat na mesma transação que grava a entrega.',
  },
  // Moderação: a decisão e o efeito no conteúdo de outro módulo são uma transação só.
  {
    file: 'modules/reports/reports.repository.ts',
    allow: [
      'media/media.repository',
      'messaging/messaging.repository',
      'reviews/reviews.repository',
    ],
    why: 'ADRs 39 e 44: remover imagem, avaliação ou mensagem denunciada acontece na transação da decisão da denúncia.',
  },
  {
    file: 'modules/reports/content-removals.repository.ts',
    allow: [
      'media/media.repository',
      'messaging/messaging.repository',
      'reviews/reviews.repository',
    ],
    why: 'ADRs 41 e 44: a contestação aceita devolve o conteúdo na transação que fecha a contestação.',
  },
];

const EXT = '(?:\\.[cm]?[jt]s)?$';
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `../<qualquer coisa>.repository`: de dentro de modules/<m>/, é sempre o de outro módulo. */
function foreignRepository(allow = []) {
  const except = allow.length ? `(?!(?:${allow.map(escape).join('|')})${EXT})` : '';
  return `^\\.\\./${except}.*\\.repository${EXT}`;
}

const rule = (patterns) => ['error', { patterns }];

const CROSS_MESSAGE =
  'RNF-021: o repository é do módulo dono. De outro módulo, chame o service ou a fachada dele (<modulo>.facade.ts). Exceção só para transação que cruza domínios, listada em apps/api/eslint.boundaries.mjs.';

const crossModule = (allow) => ({
  regex: foreignRepository(allow),
  caseSensitive: true,
  allowTypeImports: true,
  message: CROSS_MESSAGE,
});

/** Blocos de configuração do ESLint (flat config), na ordem: o geral, as camadas e as exceções. */
export const apiBoundaries = [
  {
    files: [`${MODULES}/**/*.ts`],
    ignores: [`${MODULES}/**/*.test.ts`],
    rules: { 'no-restricted-imports': rule([crossModule([])]) },
  },
  {
    // Regra 2: vale para o repository do próprio módulo também (o de outro já é pego pela regra 1).
    files: [`${MODULES}/**/*.controller.ts`, `${MODULES}/**/*.routes.ts`],
    ignores: [`${MODULES}/**/*.test.ts`],
    rules: {
      'no-restricted-imports': rule([
        {
          regex: `\\.repository${EXT}`,
          caseSensitive: true,
          allowTypeImports: true,
          message:
            'RNF-021: controller e routes não importam repository, nem o do próprio módulo: passe pelo service (ou pela fachada do módulo).',
        },
      ]),
    },
  },
  {
    // Regra 3: a fachada é folha (só os repositories do próprio módulo), e por isso nunca fecha ciclo.
    files: [`${MODULES}/**/*.facade.ts`],
    rules: {
      'no-restricted-imports': rule([
        {
          regex: `^(?!\\./[^/]+\\.repository${EXT})`,
          caseSensitive: true,
          allowTypeImports: true,
          message:
            'RNF-021: a fachada só repassa ao repository do próprio módulo. Regra de negócio fica no service; importar mais que o repository tira da fachada a garantia de não criar ciclo.',
        },
      ]),
    },
  },
  ...REPOSITORY_EXCEPTIONS.map(({ file, allow }) => {
    if (/\.(controller|routes|facade)\.ts$/.test(file)) {
      throw new Error(
        `eslint.boundaries: ${file} não pode ser exceção (controller, routes e fachada)`,
      );
    }
    return {
      files: [`apps/api/src/${file}`],
      rules: { 'no-restricted-imports': rule([crossModule(allow)]) },
    };
  }),
];
