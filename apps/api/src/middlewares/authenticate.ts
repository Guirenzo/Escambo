/**
 * Middleware de autenticação (camada de middleware): roda antes do controller nas rotas que
 * exigem login. Quem usa: o routes.ts de cada módulo (ex.: contractsRoutes.use(authenticate)).
 * O que chama: o jsonwebtoken (confere o token) e o account-access (lê a conta no banco).
 *
 * JWT (JSON Web Token) é o crachá que a API entrega no login: um texto com o id e o papel da
 * pessoa, assinado com o JWT_SECRET. Sem o segredo ninguém forja um, e a API confere a assinatura
 * sem ir ao banco. O web manda o token em todo pedido, no cabeçalho "Authorization: Bearer
 * <token>". Ele vale 1h; depois o web pede outro com o refresh token (ADR 6).
 *
 * Dentro: AuthPayload (o que o token carrega), optionalUserId (rota pública que quer saber quem é)
 * e authenticate (exige token válido e conta liberada; preenche req.user).
 */
import type { Request, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import {
  assertBusinessWrite,
  currentAccount,
  suspendedRequestAllowed,
  validateAccessIdentity,
} from '../modules/auth/account-access';
import { asyncHandler } from '../utils/async-handler';
import { HttpError } from '../utils/http-error';

export interface AuthPayload {
  sub: string; // ulid do usuário
  uid: number; // id numérico (users.id)
  role: string;
  status?: import('@escambo/types').UserStatus;
  /** E-mail confirmado, lido junto com o status (RF-006). */
  emailVerified?: boolean;
}

// Torna req.user tipado nas rotas protegidas.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

/**
 * Quem chama uma rota pública, se mandou um token válido (sem consultar a conta): serve só para a
 * rota tratar o dono de outro jeito (ex.: não contar a visualização do próprio serviço), nunca para
 * dar acesso. Sem token, ou com token inválido ou vencido, é anônimo.
 */
export function optionalUserId(req: Request): number | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  try {
    return validateAccessIdentity(jwt.verify(header.slice(7), env.JWT_SECRET)).uid;
  } catch {
    return undefined;
  }
}

// Por que ler a conta no banco a cada pedido, se o token já diz quem é? O token diz QUEM é; o
// banco diz o que a pessoa PODE agora. Banir ou suspender vale na hora, sem esperar o token de 1h
// vencer (ADR 7, atualizado pelo ADR 61). O custo é uma consulta por chave primária.
/** Exige um Bearer token JWT válido; injeta req.user. (RF-006, RNF-013) */
export const authenticate: RequestHandler = asyncHandler(async (req, res, next) => {
  // 1. O token vem no cabeçalho Authorization, no formato "Bearer <token>". Sem ele, 401.
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new HttpError(401, 'Token de autenticação ausente', 'missing_token');
  }

  // 2. slice(7) tira o "Bearer "; jwt.verify confere a assinatura e o vencimento, e o
  // validateAccessIdentity confere o formato dos dados (uid, sub e papel). Qualquer falha é 401.
  let payload: AuthPayload;
  try {
    payload = validateAccessIdentity(jwt.verify(header.slice(7), env.JWT_SECRET));
  } catch {
    throw new HttpError(401, 'Token inválido ou expirado', 'invalid_token');
  }
  // 3. Lê a conta atual no banco: excluída ou banida vira 403, e banco fora vira 503 (não deixa
  // passar sem conferir). O status vai no cabeçalho X-Account-Status para o web.
  const account = await currentAccount(payload);
  res.setHeader('X-Account-Status', account.status);
  // 4. Conta suspensa só consulta (RN-007): ação de negócio é recusada com 403, menos as exceções
  // do próprio titular (suporte, privacidade, segurança), listadas no suspendedRequestAllowed.
  if (account.status === 'suspended' && !suspendedRequestAllowed(req.method, req.originalUrl)) {
    assertBusinessWrite(account);
  }
  // 5. req.user leva a conta conferida (papel e status do banco, não os do token) ao controller.
  // É dele que sai o uid de quem pede, nunca do corpo nem da URL. O next() passa adiante.
  req.user = account;
  next();
});
