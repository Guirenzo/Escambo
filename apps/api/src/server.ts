import { createApp } from './app';
import { env } from './config/env';
import { pingDb } from './config/db';

async function main(): Promise<void> {
  await pingDb(); // falha cedo se o banco não estiver acessível
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
