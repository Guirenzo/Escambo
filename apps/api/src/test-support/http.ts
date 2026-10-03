import express, { type Express, type Router } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { errorHandler } from '../middlewares/error-handler';

/**
 * Apoio aos testes de unidade das rotas e dos controllers (sem banco): o router do módulo montado
 * como no app, com o `authenticate` e o error-handler de verdade. O service do módulo entra
 * mockado pelo teste (`vi.mock('./x.service')`), então o que se confere é a borda HTTP: quem pode
 * chamar, o que a validação recusa, o que chega ao service e o que volta como resposta.
 */

/** App mínimo: JSON, o router em `mount`, 404 padronizado e o tratamento global de erros. */
export function routerApp(mount: string, router: Router): Express {
  const app = express();
  app.use(express.json());
  app.use(mount, router);
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Rota não encontrada' });
  });
  app.use(errorHandler);
  return app;
}

/** Token de acesso como o do login (mesmo segredo e mesmo formato), para passar pelo `authenticate`. */
export function tokenFor(uid: number, role = 'client'): string {
  return jwt.sign({ sub: `ulid-${uid}`, uid, role }, env.JWT_SECRET, { expiresIn: '5m' });
}

/** Cabeçalho de autenticação para o supertest: `.set(bearer(7))`. */
export function bearer(uid: number, role = 'client'): { Authorization: string } {
  return { Authorization: `Bearer ${tokenFor(uid, role)}` };
}
