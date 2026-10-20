/**
 * Verificação em duas etapas (RF-090, ADR 66): o que a tela confere e formata antes de mandar à
 * API. A regra de verdade (código certo, uso único, limite de tentativas) é toda do servidor; aqui
 * só se evita mandar o que com certeza está incompleto, com uma mensagem que diz o que falta.
 */

/** Chave base32 em grupos de 4 ("ABCD EFGH ..."): mais fácil de conferir e digitar no app. */
export function groupSecret(secret: string): string {
  return (secret.replace(/\s+/g, '').match(/.{1,4}/g) ?? []).join(' ');
}

/** Código do app: 6 dígitos, com ou sem espaço no meio (alguns apps mostram "123 456"). */
export function normalizeTotp(value: string): string | null {
  const digits = value.replace(/\s+/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;
}

/**
 * Código de recuperação: 8 letras ou números (XXXX-XXXX), com ou sem hífen e espaço. Vai como a
 * pessoa digitou, sem os espaços das pontas: a API normaliza maiúsculas e as letras parecidas.
 */
export function normalizeRecoveryCode(value: string): string | null {
  const compact = value.replace(/[\s-]+/g, '');
  return /^[0-9a-z]{8}$/i.test(compact) ? value.trim() : null;
}

/** Campo que aceita os dois (gerar códigos e desativar): o do app ou um de recuperação. */
export function normalizeSecondFactor(value: string): string | null {
  return normalizeTotp(value) ?? normalizeRecoveryCode(value);
}

/** Conteúdo do .txt dos códigos de recuperação. */
export function recoveryCodesText(codes: string[], email: string | undefined, now: Date): string {
  return [
    'Escambo: códigos de recuperação da verificação em duas etapas',
    ...(email ? [`Conta: ${email}`] : []),
    `Gerados em: ${now.toLocaleString('pt-BR')}`,
    '',
    'Cada código entra uma vez só no lugar do código do app autenticador.',
    'Gerar códigos novos no Perfil invalida estes.',
    '',
    ...codes.map((code, i) => `${String(i + 1).padStart(2, ' ')}. ${code}`),
    '',
  ].join('\n');
}
