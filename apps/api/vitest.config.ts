/**
 * Configuração do Vitest para os testes de unidade da API (infraestrutura de teste). Quem usa:
 * "npm test" e "npm run test:cov" (com cobertura), no dev e no job build-and-test do CI.
 *
 * Cobertura é a porcentagem do código que os testes executaram: linhas, instruções (statements),
 * funções e branches (cada caminho de um if). O provider v8 mede direto no motor do Node, e o
 * relatório sai em coverage/unit (o lcov-report/index.html abre no navegador).
 *
 * Meta da disciplina: 75% no backend e 25% no front, medida nos testes de unidade (ADR 59). O
 * piso deste arquivo é 90% de linhas, instruções e funções e 85% de branches: abaixo de qualquer
 * um, o vitest termina com erro e o CI fica vermelho.
 */
import { defineConfig } from 'vitest/config';

/**
 * Testes de UNIDADE (padrão de `npm test`): rápidos, sem banco — as
 * repositories são mockadas. Os testes de integração ficam num config à
 * parte (vitest.integration.config.ts) e não rodam aqui.
 */
export default defineConfig({
  test: {
    // Arquivos de teste: todo *.test.ts dentro de src, ao lado do código que testa.
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Roda antes de cada arquivo de teste: troca a consulta da conta atual (a que o authenticate
    // faz no banco) por uma versão falsa, sem MySQL.
    setupFiles: ['src/test-support/account-access.setup.ts'],
    // Suíte hermética: não depende de um .env local. O env.ts exige JWT_SECRET
    // (sem default) — injetamos um valor de teste para o parse não abortar.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      JWT_SECRET: 'unit-test-secret-0123456789abcdef',
      ADMIN_EMAILS: 'root@escambo.test,@admin.escambo.test',
      MAIL_PROVIDER: 'off',
      PUSH_PROVIDER: 'off',
      // Os relógios dos testes de job (resumo diário, relatório da moderação) contam com as 8h.
      DIGEST_HOUR: '8',
      // Banco inexistente de propósito: teste unitário que tocar no MySQL (repository sem mock)
      // falha aqui, na máquina de quem escreveu, e não só no CI — que não tem banco neste job.
      DB_HOST: '127.0.0.1',
      DB_PORT: '1',
    },
    // Cobertura (ADR 59): conta todo arquivo de src, carregado ou não pelos testes. A meta do
    // Playbook para os testes de unidade do backend é 75%; o piso aqui é mais alto, para a
    // cobertura que existe não se desfazer aos poucos. A união com a integração (que é onde o
    // SQL roda de verdade) é conferida por scripts/coverage-merge.mjs.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/test-support/**'],
      reporter: ['text-summary', 'json', 'lcov'],
      reportsDirectory: 'coverage/unit',
      // O piso: abaixo de um destes números a rodada com cobertura falha (meta da disciplina: 75%).
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
