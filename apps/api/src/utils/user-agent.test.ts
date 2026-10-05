import { describe, expect, it } from 'vitest';
import { USER_AGENT_MAX, userAgentOf } from './user-agent';

describe('userAgentOf: o navegador no tamanho da coluna user_agent', () => {
  it('a coluna tem 512 caracteres', () => {
    expect(USER_AGENT_MAX).toBe(512);
  });

  it('até 512 caracteres fica inteiro; acima, ficam os 512 primeiros', () => {
    expect(userAgentOf('Mozilla/5.0')).toBe('Mozilla/5.0');
    expect(userAgentOf('a'.repeat(512))).toBe('a'.repeat(512));
    expect(userAgentOf('a'.repeat(511) + 'bc')).toBe('a'.repeat(511) + 'b');
  });

  it('sem navegador continua null, e vazio continua vazio', () => {
    expect(userAgentOf(null)).toBeNull();
    expect(userAgentOf(undefined)).toBeNull();
    expect(userAgentOf('')).toBe('');
  });
});
