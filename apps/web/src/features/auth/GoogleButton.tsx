import { useQuery } from '@tanstack/react-query';
import { api, GOOGLE_START_URL } from '../../lib/api';
import { rememberGoogleRole } from '../../lib/google';
import { GoogleMark } from './GoogleMark';

/** Chave dos jeitos de entrar ligados no servidor (RF-002). */
export const AUTH_PROVIDERS_KEY = ['authProviders'] as const;

/**
 * O login com Google está ligado no servidor? Sem resposta (API fora, erro), fica desligado: o
 * botão some e o resto do formulário segue. A resposta só muda com a configuração do servidor.
 */
export function useGoogleEnabled(): boolean {
  const providers = useQuery({
    queryKey: AUTH_PROVIDERS_KEY,
    queryFn: () => api.authProviders(),
    staleTime: Infinity,
    retry: false,
  });
  return providers.data?.google === true;
}

/**
 * "Entrar com Google" (RF-002): um link de navegação para a API, que leva ao Google e volta pelo
 * servidor. Nada do Google roda no app (sem SDK nem script de terceiro). Só aparece com o login
 * com Google ligado no servidor. Vindo do cadastro, o "Eu sou" escolhido vai junto para a tela
 * de concluir o cadastro (se a conta Google ainda não tiver conta).
 */
export function GoogleButton({
  mode,
  role,
}: {
  mode: 'login' | 'register';
  role?: 'client' | 'freelancer';
}) {
  const enabled = useGoogleEnabled();
  if (!enabled) return null;
  return (
    <div className="au-google" data-testid="google-login">
      <p className="au-or" aria-hidden="true">
        <span>ou</span>
      </p>
      <a
        className="btn secondary au-google-btn"
        href={GOOGLE_START_URL}
        onClick={() => rememberGoogleRole(mode === 'register' ? (role ?? null) : null)}
      >
        <GoogleMark />
        <span>{mode === 'login' ? 'Entrar com Google' : 'Criar conta com Google'}</span>
      </a>
    </div>
  );
}
