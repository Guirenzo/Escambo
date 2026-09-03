import { QueryClient } from '@tanstack/react-query';

/**
 * Camada de dados: cache + loading/erro/refetch padronizados para todas as telas.
 * staleTime evita refetch agressivo; retry curto para não mascarar erros reais.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
