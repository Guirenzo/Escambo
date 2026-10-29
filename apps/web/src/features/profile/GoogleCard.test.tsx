import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { AccountContact } from '@escambo/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleCard } from './GoogleCard';

/** "Entrar com Google" no Perfil (RF-002): só para a conta vinculada, e diz se há senha. */

const api = vi.hoisted(() => ({ accountContact: vi.fn() }));
vi.mock('../../lib/api', () => ({ api }));

const contact = (o: Partial<AccountContact> = {}): AccountContact => ({
  email: 'ana@gmail.com',
  emailVerified: true,
  phone: null,
  pendingEmail: null,
  hasPassword: true,
  googleLinked: true,
  ...o,
});

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <GoogleCard />
    </QueryClientProvider>,
  );
}

// Em bloco: devolver o mock faria o vitest chamá-lo como limpeza ao fim de cada teste.
beforeEach(() => {
  api.accountContact.mockReset();
});

describe('GoogleCard', () => {
  it('conta sem Google: nada aparece', async () => {
    api.accountContact.mockResolvedValue(contact({ googleLinked: false }));
    const { container } = renderCard();
    await waitFor(() => expect(api.accountContact).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('vinculada e com senha: o título, o selo e que a senha continua valendo', async () => {
    api.accountContact.mockResolvedValue(contact());
    renderCard();
    const card = await screen.findByRole('region', { name: 'Entrar com Google' });
    expect(card).toHaveTextContent('Vinculado');
    expect(card).toHaveTextContent('A senha continua valendo.');
  });

  it('vinculada e sem senha: aponta para o cartão Senha', async () => {
    api.accountContact.mockResolvedValue(contact({ hasPassword: false }));
    renderCard();
    expect(await screen.findByTestId('google-card')).toHaveTextContent(
      'Ela ainda não tem senha (veja o cartão Senha).',
    );
  });
});
