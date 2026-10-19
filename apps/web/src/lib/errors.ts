/**
 * Texto de erro para a tela (RNF-028): o da API (ApiRequestError, já em português e sem "Failed
 * to fetch") ou o de uma regra do próprio app (Error simples, escrito por nós). Erro técnico do
 * navegador ou do JavaScript (TypeError, DOMException, SyntaxError...) vem em inglês e não orienta
 * ninguém: vira o texto de reserva de quem chama.
 *
 * Fica fora do api.ts de propósito: os testes que trocam o cliente HTTP por um mock continuam
 * enxergando este módulo de verdade.
 */
export function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message.trim()) return fallback;
  return error.name === 'ApiRequestError' || error.name === 'Error' ? error.message : fallback;
}
