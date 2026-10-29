import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PublicUser } from '@escambo/types';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { api, getToken, setSession } from '../../lib/api';
import { AuthProvider } from '../../lib/auth';
import { GoogleReturnView } from './GoogleReturnView';

/**
 * A volta do Google no app (RF-002), com a sessão de verdade e só o HTTP de mentira: o código sai
 * do endereço na hora e é trocado uma vez; conta que existe entra; com 2FA, o passo do código;
 * conta nova, "Concluir cadastro" (papel e aceite); e cada erro com o caminho de volta.
 */

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...actual,
    api: {
      me: vi.fn(),
      googleExchange: vi.fn(),
      googleSignup: vi.fn(),
      loginMfa: vi.fn(),
      logout: vi.fn(),
      pushUnsubscribe: vi.fn(),
    },
  };
});
vi.mock('../../lib/socket', () => ({
  disconnectSocket: vi.fn(),
  getSocket: () => ({ on: vi.fn(), off: vi.fn() }),
}));
vi.mock('../../lib/timezones', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/timezones')>()),
  browserBrazilZone: () => null,
}));

const http = api as unknown as Record<'googleExchange' | 'googleSignup' | 'loginMfa', Mock>;
const ana = {
  id: 1,
  ulid: 'u1',
  email: 'ana@gmail.com',
  role: 'client',
  status: 'active',
} as PublicUser;
const session = { accessToken: 'acesso-1', refreshToken: 'refresh-1', user: ana };
const signup = {
  signupRequired: true as const,
  signupToken: 'cadastro-1',
  expiresInSeconds: 900,
  email: 'ana@gmail.com',
  name: 'Ana Souza',
};

/** Onde o navegador está (o código não pode ficar no endereço). */
function Where() {
  const location = useLocation();
  return <output data-testid="onde">{`${location.pathname}${location.hash}`}</output>;
}

function renderAt(hash: string) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/entrar/google', hash }]}>
      <AuthProvider>
        <Routes>
          <Route path="/entrar/google" element={<GoogleReturnView />} />
          <Route path="/" element={<p>Início</p>} />
          <Route path="/login" element={<p>Tela de entrar</p>} />
          <Route path="/cadastro" element={<p>Tela de cadastro</p>} />
        </Routes>
        <Where />
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  setSession(null);
});
afterEach(() => {
  setSession(null);
  sessionStorage.clear();
});

describe('GoogleReturnView', () => {
  it('conta que já existe: troca o código uma vez, tira-o do endereço e vai para o Início', async () => {
    http.googleExchange.mockResolvedValue(session);
    renderAt('#codigo=abc123');
    expect(await screen.findByText('Início')).toBeInTheDocument();
    expect(http.googleExchange).toHaveBeenCalledTimes(1);
    expect(http.googleExchange).toHaveBeenCalledWith('abc123');
    expect(screen.getByTestId('onde')).toHaveTextContent(/^\/$/);
    expect(getToken()).toBe('acesso-1');
  });

  it('quem já está com a sessão aberta não troca o código (de outra pessoa): vai para o Início', async () => {
    setSession({ accessToken: 'acesso-0', refreshToken: 'refresh-0' });
    (api as unknown as Record<'me', Mock>).me.mockResolvedValue(ana);
    renderAt('#codigo=de-outra-pessoa');
    expect(await screen.findByText('Início')).toBeInTheDocument();
    expect(http.googleExchange).not.toHaveBeenCalled();
    expect(getToken()).toBe('acesso-0');
  });

  it('enquanto troca, diz que está entrando; o código já saiu do endereço', async () => {
    http.googleExchange.mockReturnValue(new Promise(() => undefined));
    renderAt('#codigo=abc123');
    expect(screen.getByRole('status', { name: 'Entrando com o Google…' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('onde')).toHaveTextContent(/^\/entrar\/google$/));
    expect(document.title).toBe('Entrar com Google · Escambo');
  });

  it('sem código no endereço: o erro, o caminho de volta e nenhuma troca', async () => {
    renderAt('');
    expect(
      await screen.findByRole('heading', { name: 'Não foi possível entrar com o Google' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('não trouxe um código válido');
    expect(screen.getByRole('link', { name: 'Tentar de novo com o Google' })).toHaveAttribute(
      'href',
      '/api/auth/google/start',
    );
    expect(screen.getByRole('link', { name: 'Voltar para entrar' })).toHaveAttribute(
      'href',
      '/login',
    );
    expect(http.googleExchange).not.toHaveBeenCalled();
  });

  it('código vencido ou usado: a mensagem da API', async () => {
    http.googleExchange.mockRejectedValue(
      new Error('O login com o Google expirou. Volte e tente de novo.'),
    );
    renderAt('#codigo=velho');
    expect(await screen.findByRole('alert')).toHaveTextContent('O login com o Google expirou.');
  });

  it('com 2FA: o passo do código, que abre a sessão e vai para o Início', async () => {
    const user = userEvent.setup();
    http.googleExchange.mockResolvedValue({
      mfaRequired: true,
      mfaToken: 'mfa-1',
      expiresInSeconds: 300,
    });
    http.loginMfa.mockResolvedValue(session);
    renderAt('#codigo=abc123');
    expect(
      await screen.findByRole('heading', { name: 'Verificação em duas etapas' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Entrando com a sua conta Google.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Código do app autenticador'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(await screen.findByText('Início')).toBeInTheDocument();
    expect(http.loginMfa).toHaveBeenCalledWith({ mfaToken: 'mfa-1', code: '123456' });
  });

  it('com 2FA, voltar leva ao login; o código vencido mostra o erro', async () => {
    const user = userEvent.setup();
    http.googleExchange.mockResolvedValue({
      mfaRequired: true,
      mfaToken: 'mfa-1',
      expiresInSeconds: 300,
    });
    http.loginMfa.mockRejectedValue(
      Object.assign(new Error('A verificação expirou.'), { code: 'invalid_mfa_token' }),
    );
    renderAt('#codigo=abc123');
    await user.type(await screen.findByLabelText('Código do app autenticador'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'O tempo para digitar o código acabou',
    );

    http.googleExchange.mockResolvedValue({
      mfaRequired: true,
      mfaToken: 'mfa-2',
      expiresInSeconds: 300,
    });
    renderAt('#codigo=outro');
    const back = await screen.findAllByRole('button', { name: 'Voltar' });
    await user.click(back[back.length - 1]!);
    expect(await screen.findByText('Tela de entrar')).toBeInTheDocument();
  });

  describe('conta nova: Concluir cadastro', () => {
    it('cumprimenta pelo nome, pede o papel e o aceite; cria a conta e entra', async () => {
      const user = userEvent.setup();
      http.googleExchange.mockResolvedValue(signup);
      http.googleSignup.mockResolvedValue(session);
      renderAt('#codigo=abc123');

      const heading = await screen.findByRole('heading', { name: 'Concluir cadastro' });
      expect(heading).toHaveFocus();
      expect(document.title).toBe('Concluir cadastro · Escambo');
      expect(screen.getByText(/Falta pouco, Ana\./)).toBeInTheDocument();
      expect(screen.getByText('ana@gmail.com')).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'Eu sou' })).toHaveValue('client');
      expect(screen.getByRole('link', { name: 'Cadastre com o CNPJ' })).toHaveAttribute(
        'href',
        '/cadastro?perfil=empresa',
      );
      const create = screen.getByRole('button', { name: 'Criar conta' });
      expect(create).toBeDisabled();

      await user.selectOptions(screen.getByRole('combobox', { name: 'Eu sou' }), 'freelancer');
      await user.click(
        screen.getByRole('checkbox', {
          name: 'Li e aceito os Termos de Uso e a Política de Privacidade.',
        }),
      );
      await user.click(create);

      expect(await screen.findByText('Início')).toBeInTheDocument();
      expect(http.googleSignup).toHaveBeenCalledWith({
        signupToken: 'cadastro-1',
        role: 'freelancer',
        legalAccepted: true,
      });
      // O nome da conta Google fica de sugestão para o Perfil.
      expect(sessionStorage.getItem('escambo:google-nome')).toBe('Ana Souza');
    });

    it('vindo do cadastro como freelancer, o papel já vem escolhido; sem nome, cumprimento neutro', async () => {
      sessionStorage.setItem('escambo:google-papel', 'freelancer');
      http.googleExchange.mockResolvedValue({ ...signup, name: null });
      renderAt('#codigo=abc123');
      expect(await screen.findByRole('combobox', { name: 'Eu sou' })).toHaveValue('freelancer');
      expect(sessionStorage.getItem('escambo:google-papel')).toBeNull();
      expect(screen.getByText(/^Falta pouco\. A conta vai entrar/)).toBeInTheDocument();
    });

    it('erro comum fica no formulário; passe vencido ou e-mail que ganhou conta vira a tela de erro', async () => {
      const user = userEvent.setup();
      http.googleExchange.mockResolvedValue(signup);
      http.googleSignup
        .mockRejectedValueOnce(new Error('Muitas tentativas. Tente novamente em alguns minutos.'))
        .mockRejectedValueOnce(
          Object.assign(new Error('O tempo para concluir o cadastro acabou.'), {
            code: 'invalid_signup_token',
          }),
        );
      renderAt('#codigo=abc123');
      await user.click(await screen.findByRole('checkbox'));
      await user.click(screen.getByRole('button', { name: 'Criar conta' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Muitas tentativas');
      expect(screen.getByRole('button', { name: 'Criar conta' })).toBeEnabled();

      await user.click(screen.getByRole('button', { name: 'Criar conta' }));
      expect(
        await screen.findByRole('heading', { name: 'Não foi possível entrar com o Google' }),
      ).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent(
        'O tempo para concluir o cadastro acabou.',
      );
    });
  });
});
