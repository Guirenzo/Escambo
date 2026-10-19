import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

/** Chave do contato da conta (RF-017) no cache: e-mail, troca pendente e telefone. */
export const ACCOUNT_CONTACT_KEY = ['accountContact'] as const;

/** Contato da conta: só o titular vê (o perfil público não traz e-mail nem telefone). */
export const useAccountContact = () =>
  useQuery({ queryKey: ACCOUNT_CONTACT_KEY, queryFn: () => api.accountContact() });

/**
 * Telefone em E.164 do Brasil (+55 DDD número) como as pessoas leem: "(47) 99999-1234" ou
 * "(47) 3433-1234". O que não tiver esse formato aparece como veio.
 */
export function formatPhone(e164: string): string {
  const m = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
