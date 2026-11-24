/**
 * Rotas de autenticação (camada de rota). O routes.ts da API monta este Router em `/api/auth`.
 * Liga cada URL ao controller: cadastro, login (com e sem segundo fator), renovação do token,
 * saída, conta logada, confirmação de e-mail, senha, contato e verificação em duas etapas, além
 * das rotas do login com Google.
 * Middlewares usados: `loginRateLimiter` (limite de tentativas por IP, contra força bruta) e
 * `authenticate` (exige o JWT de acesso). Rota sem authenticate é pública de propósito: quem
 * chama ainda não tem sessão (cadastro, login, refresh) ou chega por um link de e-mail.
 * O que chama: auth.controller e google.controller, que chamam os services do módulo.
 */
import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { loginRateLimiter } from '../../middlewares/rate-limit';
import { asyncHandler } from '../../utils/async-handler';
import {
  cancelEmailChange,
  changeEmail,
  changePassword,
  confirmEmailChange,
  contact,
  forgotPassword,
  login,
  loginMfa,
  logout,
  logoutAll,
  me,
  mfaDisable,
  mfaEnable,
  mfaRecoveryCodes,
  mfaSetup,
  mfaStatus,
  refresh,
  register,
  resendVerification,
  resetPassword,
  updatePhone,
  verifyEmail,
} from './auth.controller';
import {
  googleCallback,
  googleExchange,
  googleOnly,
  googleSignup,
  googleStart,
  providers,
} from './google.controller';

export const authRoutes = Router();

// Login com Google (RF-002), desligado até o dono configurar o cliente OAuth: /providers diz se o
// botão aparece, e as rotas do Google respondem 404 enquanto isso. Ligado, as quatro têm o limite
// do login por IP; a volta e a troca do código são públicas (o navegador ainda não tem sessão).
authRoutes.get('/providers', asyncHandler(providers));
authRoutes.get('/google/start', googleOnly, loginRateLimiter, asyncHandler(googleStart));
authRoutes.get('/google/callback', googleOnly, loginRateLimiter, asyncHandler(googleCallback));
authRoutes.post('/google/exchange', googleOnly, loginRateLimiter, asyncHandler(googleExchange));
authRoutes.post('/google/signup', googleOnly, loginRateLimiter, asyncHandler(googleSignup));

// Rotas sensíveis com anti brute-force (RNF-005 / RN-002).
authRoutes.post('/register', loginRateLimiter, asyncHandler(register));
authRoutes.post('/login', loginRateLimiter, asyncHandler(login));
// Segundo passo do login com a verificação em duas etapas (ADR 66): além do limite por IP, a
// conta trava por 15 minutos depois de 5 códigos errados seguidos.
authRoutes.post('/login/mfa', loginRateLimiter, asyncHandler(loginMfa));
// Renovar e sair recebem o refresh token no corpo, sem authenticate: o access token de 1 hora
// pode já ter vencido, e é justamente para isso que o refresh existe.
authRoutes.post('/refresh', asyncHandler(refresh));
authRoutes.post('/logout', asyncHandler(logout));
// Sair de todos os aparelhos e "quem sou eu" exigem o JWT válido.
authRoutes.post('/logout-all', authenticate, asyncHandler(logoutAll));
authRoutes.get('/me', authenticate, asyncHandler(me));
// Confirmação de e-mail e recuperação de senha (links de uso único, anti brute-force).
authRoutes.post('/verify-email', loginRateLimiter, asyncHandler(verifyEmail));
authRoutes.post(
  '/resend-verification',
  authenticate,
  loginRateLimiter,
  asyncHandler(resendVerification),
);
authRoutes.post('/forgot-password', loginRateLimiter, asyncHandler(forgotPassword));
authRoutes.post('/reset-password', loginRateLimiter, asyncHandler(resetPassword));
// Troca com login (RF-017): o login é conferido antes, e errar a senha atual gasta tentativa.
authRoutes.post('/change-password', authenticate, loginRateLimiter, asyncHandler(changePassword));

// Contato da conta (RF-017), visível só ao titular. A troca de e-mail pede a senha atual (com o
// limite do login por IP, além do teto diário por conta) e só vale pelo link enviado ao endereço
// novo; a confirmação é pública porque o link pode abrir em outro aparelho.
authRoutes.get('/contact', authenticate, asyncHandler(contact));
authRoutes.put('/phone', authenticate, asyncHandler(updatePhone));
authRoutes.post('/change-email', authenticate, loginRateLimiter, asyncHandler(changeEmail));
authRoutes.delete('/change-email', authenticate, asyncHandler(cancelEmailChange));
authRoutes.post('/confirm-email-change', loginRateLimiter, asyncHandler(confirmEmailChange));

// Verificação em duas etapas da própria conta (RF-090, ADR 66). Tudo que confere senha ou código
// passa pelo limite do login por IP; o código errado ainda soma na trava da conta.
authRoutes.get('/mfa', authenticate, asyncHandler(mfaStatus));
authRoutes.post('/mfa/setup', authenticate, loginRateLimiter, asyncHandler(mfaSetup));
authRoutes.post('/mfa/enable', authenticate, loginRateLimiter, asyncHandler(mfaEnable));
authRoutes.post('/mfa/disable', authenticate, loginRateLimiter, asyncHandler(mfaDisable));
authRoutes.post(
  '/mfa/recovery-codes',
  authenticate,
  loginRateLimiter,
  asyncHandler(mfaRecoveryCodes),
);
