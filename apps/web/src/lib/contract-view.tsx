import { createContext, useContext, useState, type ReactNode } from 'react';

interface ContractViewValue {
  openId: number | null;
  open: (id: number | null) => void;
}

const ContractViewContext = createContext<ContractViewValue>({
  openId: null,
  open: () => undefined,
});

/** Controla qual contrato está aberto na "sala do contrato" (overlay). */
export function ContractViewProvider({ children }: { children: ReactNode }) {
  const [openId, setOpenId] = useState<number | null>(null);
  return (
    <ContractViewContext.Provider value={{ openId, open: setOpenId }}>
      {children}
    </ContractViewContext.Provider>
  );
}

export const useContractView = (): ContractViewValue => useContext(ContractViewContext);
