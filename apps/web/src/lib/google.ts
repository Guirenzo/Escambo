import type { GoogleLoginFailure } from '@escambo/types';

/**
 * Login com Google (RF-002) no app: as frases de cada recusa da volta do Google e duas lembranças
 * curtas, desta aba só (sessionStorage), que não saem do navegador. Sem armazenamento (aba
 * privada, bloqueio), nada quebra: só não lembra.
 */

/** O que a pessoa lê no login quando a volta do Google não entrou (/login?google=motivo). */
const FAILURES: Record<GoogleLoginFailure, string> = {
  negado: 'O login com o Google foi cancelado. Entre com a senha ou tente de novo.',
  expirado: 'O login com o Google expirou ou foi aberto em outro navegador. Tente de novo.',
  email_nao_verificado:
    'O Google ainda não confirmou o e-mail dessa conta. Confirme no Google ou entre com a senha.',
  conta_banida: 'Conta banida. Fale com o suporte.',
  conta_excluida: 'Esta conta foi excluída a pedido do titular.',
  conta_vinculada:
    'Este e-mail já entra com outra conta Google. Use a mesma conta Google de antes ou a senha.',
  falhou: 'Não foi possível entrar com o Google agora. Tente de novo em instantes.',
};

/** A frase da recusa; motivo desconhecido (endereço mexido) vale como "falhou". */
export function googleFailureMessage(reason: string | null): string | null {
  if (!reason) return null;
  return FAILURES[reason as GoogleLoginFailure] ?? FAILURES.falhou;
}

const ROLE_KEY = 'escambo:google-papel';
const NAME_KEY = 'escambo:google-nome';

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* sem armazenamento: só não lembra */
  }
}

/** Saindo do cadastro para o Google: o "Eu sou" escolhido (null quando sai do login). */
export function rememberGoogleRole(role: 'client' | 'freelancer' | null): void {
  write(ROLE_KEY, role);
}

/**
 * O papel escolhido antes de ir ao Google. Só lê: quem usa esquece depois (forgetGoogleRole), num
 * efeito, porque o React pode chamar o inicializador do estado duas vezes (StrictMode).
 */
export function googleRole(): 'client' | 'freelancer' | null {
  const role = read(ROLE_KEY);
  return role === 'client' || role === 'freelancer' ? role : null;
}

/** Esquece o papel lembrado (já foi usado na tela de concluir o cadastro). */
export function forgetGoogleRole(): void {
  write(ROLE_KEY, null);
}

/** O nome da conta Google, sugestão para o perfil da conta nova. */
export function rememberSuggestedName(name: string | null): void {
  write(NAME_KEY, name && name.trim() ? name.trim().slice(0, 150) : null);
}

/** A sugestão de nome, se houver (o Perfil a usa só enquanto o perfil não tem nome). */
export function suggestedName(): string | null {
  return read(NAME_KEY);
}

/** Esquece a sugestão (o perfil foi salvo). */
export function forgetSuggestedName(): void {
  write(NAME_KEY, null);
}
