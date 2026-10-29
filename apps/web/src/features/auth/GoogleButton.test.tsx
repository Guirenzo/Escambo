import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleButton } from './GoogleButton';

/**
 * O botão "Entrar com Google" (RF-002): só com o login com Google ligado no servidor; é um link
 * para a API (sem SDK nem script do Google); vindo do cadastro, lembra o "Eu sou" escolhido.
 */

const api = vi.hoisted(() => ({ authProviders: vi.fn() }));
vi.mock('../../lib/api', () => ({ api, GOOGLE_START_URL: '/api/auth/google/start' }));

function renderButton(props: Parameters<typeof GoogleButton>[0]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <GoogleButton {...props} />
    </QueryClientProvider>,
  );
}

// Em bloco: devolver o mock faria o vitest chamá-lo como limpeza ao fim de cada teste.
beforeEach(() => {
  api.authProviders.mockReset();
});
afterEach(() => sessionStorage.clear());

describe('GoogleButton', () => {
  it('desligado no servidor: não aparece', async () => {
    api.authProviders.mockResolvedValue({ google: false });
    const { container } = renderButton({ mode: 'login' });
    await waitFor(() => expect(api.authProviders).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('sem resposta da API: não aparece (e não tenta de novo)', async () => {
    api.authProviders.mockRejectedValue(new Error('fora do ar'));
    const { container } = renderButton({ mode: 'login' });
    await waitFor(() => expect(api.authProviders).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
  });

  it('ligado: um link para a API, com o "G" só de enfeite', async () => {
    api.authProviders.mockResolvedValue({ google: true });
    renderButton({ mode: 'login' });
    const link = await screen.findByRole('link', { name: 'Entrar com Google' });
    expect(link).toHaveAttribute('href', '/api/auth/google/start');
    expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    // O "ou" entre o formulário e o botão é visual.
    expect(screen.getByText('ou').closest('p')).toHaveAttribute('aria-hidden', 'true');
  });

  it('no cadastro, o texto é "Criar conta com Google" e o papel escolhido vai junto', async () => {
    const user = userEvent.setup();
    api.authProviders.mockResolvedValue({ google: true });
    renderButton({ mode: 'register', role: 'freelancer' });
    const link = await screen.findByRole('link', { name: 'Criar conta com Google' });
    link.addEventListener('click', (e) => e.preventDefault());
    await user.click(link);
    expect(sessionStorage.getItem('escambo:google-papel')).toBe('freelancer');
  });

  it('no login, nenhum papel fica lembrado (um de antes é esquecido)', async () => {
    const user = userEvent.setup();
    sessionStorage.setItem('escambo:google-papel', 'freelancer');
    api.authProviders.mockResolvedValue({ google: true });
    renderButton({ mode: 'login' });
    const link = await screen.findByRole('link', { name: 'Entrar com Google' });
    link.addEventListener('click', (e) => e.preventDefault());
    await user.click(link);
    expect(sessionStorage.getItem('escambo:google-papel')).toBeNull();
  });
});
