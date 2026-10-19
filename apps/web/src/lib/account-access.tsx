import { createContext, useContext, type ReactNode } from 'react';
import type { UserStatus } from '@escambo/types';

const AccountAccessContext = createContext(false);

/** A autorização continua na API; este contexto mantém os controles da tela coerentes. */
export function AccountAccessProvider({
  status,
  children,
}: {
  status: UserStatus | undefined;
  children: ReactNode;
}) {
  return (
    <AccountAccessContext.Provider value={status === 'suspended'}>
      {children}
    </AccountAccessContext.Provider>
  );
}

export const useReadOnlyAccount = (): boolean => useContext(AccountAccessContext);
