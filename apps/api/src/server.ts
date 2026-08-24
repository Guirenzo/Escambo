import { createApp } from './app';
import { env } from './config/env';
import { pingDb } from './config/db';

/** Espera o banco ficar disponível antes de subir (resiliência a boot fora de ordem). */
async function waitForDb(retries = 10, delayMs = 1500): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pingDb();
      return;
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(
        `Banco indisponível (tentativa ${attempt}/${retries}); nova tentativa em ${delayMs}ms…`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function main(): Promise<void> {
  await waitForDb();
  const app = createApp();

  app.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`🚀 API Escambo em http://localhost:${env.PORT}/api  (env: ${env.NODE_ENV})`);
  });
}

main().catch((err) => {
  console.error('Falha ao iniciar a API:', err);
  process.exit(1);
});
