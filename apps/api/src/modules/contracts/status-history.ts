/**
 * De onde vem cada linha de `contract_status_history` (coluna `source`, migration 0048).
 *
 * `changed_by` é a parte em nome de quem a mudança foi feita; `source` diz se foi ela mesma:
 * - `user`: a pessoa agiu (cliente, freelancer, ou o admin na mediação da disputa);
 * - `system`: a plataforma agiu sozinha em nome de alguém, por um job — aprovação tácita de entrega
 *   ou de marco (RN-024), proposta ou oferta expirada (RN-021/RN-030) e disputa aberta por prazo
 *   (RN-029).
 *
 * Toda função que grava no histórico recebe a origem como parâmetro obrigatório: quem chama (o
 * service da ação da pessoa ou do job) declara, e o TypeScript não deixa esquecer. O relatório de
 * uso (RF-081) conta como atividade só as linhas `user`.
 */
export type StatusChangeSource = 'user' | 'system';
