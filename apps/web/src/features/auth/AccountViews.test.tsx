import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForgotPasswordView, ResetPasswordView, VerifyEmailView } from './AccountViews';

/**
 * As três telas públicas da conta (fora do app shell): pedir o link de redefinição, definir a
 * senha nova com o token do e-mail e confirmar o e-mail. O que cada uma manda para a API e o que
 * a pessoa lê em cada desfecho.
 */

const forgotPassword = vi.fn();
const resetPassword = vi.fn();
const verifyEmail = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    forgotPassword: (email: string) => forgotPassword(email),
    resetPassword: (token: string, password: string) => resetPassword(token, password),
    verifyEmail: (token: string) => verifyEmail(token),
  },
}));

/** A sessão que a tela enxerga: sem ninguém por padrão; cada teste troca o que precisa. */
const auth = {
  user: null as { id: number; email: string } | null,
  refreshUser: vi.fn(),
};
vi.mock('../../lib/auth', () => ({ useAuth: () => auth }));

/** /login de mentira, com um "voltar" para conferir o que ficou no histórico. */
function LoginProbe() {
  const navigate = useNavigate();
  return (
    <div>
      <p>tela de login</p>
      <button type="button" onClick={() => navigate(-1)}>
        voltar no histórico
      </button>
    </div>
  );
}

function renderAt(path: string, { before = [] as string[], strict = false } = {}) {
  const tree = (
    <MemoryRouter initialEntries={[...before, path]}>
      <Routes>
        <Route path="/esqueci-senha" element={<ForgotPasswordView />} />
        <Route path="/redefinir-senha" element={<ResetPasswordView />} />
        <Route path="/verificar-email" element={<VerifyEmailView />} />
        <Route path="/login" element={<LoginProbe />} />
        <Route path="/antes" element={<p>tela anterior</p>} />
      </Routes>
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

/** Promessa que o teste solta quando quiser: para ver a tela no meio do envio. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  forgotPassword.mockReset();
  forgotPassword.mockResolvedValue({ sent: true });
  resetPassword.mockReset();
  resetPassword.mockResolvedValue(undefined);
  verifyEmail.mockReset();
  verifyEmail.mockResolvedValue({ id: 1 });
  auth.user = null;
  auth.refreshUser.mockReset();
  auth.refreshUser.mockResolvedValue(undefined);
});

describe('ForgotPasswordView (/esqueci-senha)', () => {
  it('manda o e-mail digitado e responde igual exista ou não a conta, com a validade do link', async () => {
    const user = userEvent.setup();
    renderAt('/esqueci-senha');
    expect(screen.getByRole('heading', { name: 'Esqueci minha senha' })).toBeInTheDocument();
    expect(document.title).toBe('Esqueci minha senha · Escambo');

    await user.type(screen.getByLabelText('E-mail'), 'ana@escambo.test');
    await user.click(screen.getByRole('button', { name: 'Enviar link' }));

    expect(forgotPassword).toHaveBeenCalledTimes(1);
    expect(forgotPassword).toHaveBeenCalledWith('ana@escambo.test');
    const sent = await screen.findByText(/Se existir uma conta para/);
    expect(sent).toHaveTextContent(
      'Se existir uma conta para ana@escambo.test, enviamos um link para criar uma nova senha. Ele vale por 1 hora.',
    );
    // O formulário sai de cena: não dá para pedir de novo sem querer.
    expect(screen.queryByLabelText('E-mail')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enviar link' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Voltar para entrar' })).toHaveAttribute(
      'href',
      '/login',
    );
  });

  it('sem e-mail, ou com e-mail malformado, nada é enviado', async () => {
    const user = userEvent.setup();
    renderAt('/esqueci-senha');
    await user.click(screen.getByRole('button', { name: 'Enviar link' }));
    expect(forgotPassword).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('E-mail'), 'ana-sem-arroba');
    await user.click(screen.getByRole('button', { name: 'Enviar link' }));
    expect(forgotPassword).not.toHaveBeenCalled();
    expect(screen.getByLabelText('E-mail')).toBeInvalid();
  });

  it('enquanto envia, o botão fica desabilitado e não deixa pedir duas vezes', async () => {
    const user = userEvent.setup();
    const pending = deferred<{ sent: boolean }>();
    forgotPassword.mockReturnValue(pending.promise);
    renderAt('/esqueci-senha');
    await user.type(screen.getByLabelText('E-mail'), 'ana@escambo.test');
    await user.click(screen.getByRole('button', { name: 'Enviar link' }));

    const busy = screen.getByRole('button', { name: '…' });
    expect(busy).toBeDisabled();
    await user.click(busy);
    expect(forgotPassword).toHaveBeenCalledTimes(1);

    pending.resolve({ sent: true });
    expect(await screen.findByText(/Se existir uma conta para/)).toBeInTheDocument();
  });

  it('API recusa: mostra a mensagem dela, mantém o formulário e a nova tentativa limpa o erro', async () => {
    const user = userEvent.setup();
    forgotPassword.mockRejectedValueOnce(
      new Error('Muitas tentativas. Tente de novo em 1 minuto.'),
    );
    renderAt('/esqueci-senha');
    await user.type(screen.getByLabelText('E-mail'), 'ana@escambo.test');
    await user.click(screen.getByRole('button', { name: 'Enviar link' }));

    expect(
      await screen.findByText('Muitas tentativas. Tente de novo em 1 minuto.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Se existir uma conta para/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('E-mail')).toHaveValue('ana@escambo.test');
    const retry = screen.getByRole('button', { name: 'Enviar link' });
    expect(retry).toBeEnabled();

    // A segunda tentativa fica no ar: o erro antigo some já no envio, não só quando dá certo.
    const pending = deferred<{ sent: boolean }>();
    forgotPassword.mockReturnValueOnce(pending.promise);
    await user.click(retry);
    expect(screen.getByRole('button', { name: '…' })).toBeDisabled();
    expect(
      screen.queryByText('Muitas tentativas. Tente de novo em 1 minuto.'),
    ).not.toBeInTheDocument();
    expect(forgotPassword).toHaveBeenCalledTimes(2);
    expect(forgotPassword).toHaveBeenLastCalledWith('ana@escambo.test');

    pending.resolve({ sent: true });
    expect(await screen.findByText(/Se existir uma conta para/)).toBeInTheDocument();
    expect(
      screen.queryByText('Muitas tentativas. Tente de novo em 1 minuto.'),
    ).not.toBeInTheDocument();
  });

  it('Enter no campo de e-mail também envia', async () => {
    const user = userEvent.setup();
    renderAt('/esqueci-senha');
    await user.type(screen.getByLabelText('E-mail'), 'ana@escambo.test{Enter}');
    expect(forgotPassword).toHaveBeenCalledTimes(1);
    expect(forgotPassword).toHaveBeenCalledWith('ana@escambo.test');
    expect(await screen.findByText(/Se existir uma conta para/)).toBeInTheDocument();
  });

  it('o campo é de e-mail, obrigatório, e aceita o preenchimento automático do navegador', () => {
    renderAt('/esqueci-senha');
    const field = screen.getByLabelText('E-mail');
    expect(field).toBeRequired();
    expect(field).toHaveAttribute('type', 'email');
    expect(field).toHaveAttribute('autocomplete', 'email');
    expect(screen.getByPlaceholderText('voce@exemplo.com')).toBe(field);
    // Nada de erro nem de confirmação antes de a pessoa pedir.
    expect(screen.queryByText(/Se existir uma conta para/)).not.toBeInTheDocument();
    expect(screen.queryByText('Erro ao enviar')).not.toBeInTheDocument();
  });

  it('falha sem mensagem (não é um Error) cai no texto padrão', async () => {
    const user = userEvent.setup();
    forgotPassword.mockRejectedValue('rede caiu');
    renderAt('/esqueci-senha');
    await user.type(screen.getByLabelText('E-mail'), 'ana@escambo.test');
    await user.click(screen.getByRole('button', { name: 'Enviar link' }));
    expect(await screen.findByText('Erro ao enviar')).toBeInTheDocument();
  });

  it('a marca e o "Voltar para entrar" levam ao login', () => {
    renderAt('/esqueci-senha');
    expect(screen.getByRole('link', { name: 'Escambo' })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: 'Voltar para entrar' })).toHaveAttribute(
      'href',
      '/login',
    );
    expect(
      screen.getByText(
        'Informe o e-mail da sua conta. Você recebe um link para definir uma nova senha.',
      ),
    ).toBeInTheDocument();
  });
});

describe('ResetPasswordView (/redefinir-senha)', () => {
  afterEach(() => vi.useRealTimers());

  it('link sem token: não mostra o formulário e aponta para pedir outro', () => {
    renderAt('/redefinir-senha');
    expect(screen.getByRole('heading', { name: 'Redefinir senha' })).toBeInTheDocument();
    expect(document.title).toBe('Redefinir senha · Escambo');
    expect(
      screen.getByText('Link incompleto. Peça um novo em "Esqueci minha senha".'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pedir novo link' })).toHaveAttribute(
      'href',
      '/esqueci-senha',
    );
    expect(screen.queryByLabelText('Nova senha')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Salvar nova senha' })).not.toBeInTheDocument();
  });

  it('os dois campos são senha nova, obrigatórios, com mínimo de 8 caracteres', () => {
    renderAt('/redefinir-senha?token=tok-123');
    for (const label of ['Nova senha', 'Confirmar nova senha']) {
      const field = screen.getByLabelText(label);
      expect(field).toBeRequired();
      expect(field).toHaveAttribute('type', 'password');
      expect(field).toHaveAttribute('minlength', '8');
      expect(field).toHaveAttribute('autocomplete', 'new-password');
    }
    expect(screen.getByPlaceholderText('mínimo 8 caracteres')).toBe(
      screen.getByLabelText('Nova senha'),
    );
  });

  it('senhas diferentes: avisa e não chama a API', async () => {
    const user = userEvent.setup();
    renderAt('/redefinir-senha?token=tok-123');
    await user.type(screen.getByLabelText('Nova senha'), 'senhaNova1');
    await user.type(screen.getByLabelText('Confirmar nova senha'), 'senhaNova2');
    await user.click(screen.getByRole('button', { name: 'Salvar nova senha' }));

    expect(screen.getByText('As senhas não conferem')).toBeInTheDocument();
    expect(resetPassword).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Salvar nova senha' })).toBeEnabled();
  });

  it('campos vazios não enviam', async () => {
    const user = userEvent.setup();
    renderAt('/redefinir-senha?token=tok-123');
    await user.click(screen.getByRole('button', { name: 'Salvar nova senha' }));
    expect(resetPassword).not.toHaveBeenCalled();
    expect(screen.queryByText('As senhas não conferem')).not.toBeInTheDocument();
  });

  it('senhas iguais: manda o token do link e a senha, avisa das sessões encerradas e vai ao login aos 2,5 s (nem antes), sem deixar o link no histórico', async () => {
    const user = userEvent.setup();
    const pending = deferred<void>();
    resetPassword.mockReturnValue(pending.promise);
    renderAt('/redefinir-senha?token=tok-123', { before: ['/antes'] });
    await user.type(screen.getByLabelText('Nova senha'), 'senhaNova1');
    await user.type(screen.getByLabelText('Confirmar nova senha'), 'senhaNova1');
    await user.click(screen.getByRole('button', { name: 'Salvar nova senha' }));

    expect(resetPassword).toHaveBeenCalledTimes(1);
    expect(resetPassword).toHaveBeenCalledWith('tok-123', 'senhaNova1');
    expect(
      screen.queryByText(
        'Senha alterada. Todas as sessões anteriores foram encerradas; entre de novo.',
      ),
    ).not.toBeInTheDocument();

    // Só o relógio do redirecionamento é de mentira, e só daqui em diante: a API responde e o
    // teste decide quando os 2,5 s passam (sem depender do tempo real da máquina).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(
      screen.getByText(
        'Senha alterada. Todas as sessões anteriores foram encerradas; entre de novo.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Entrar' })).toHaveAttribute('href', '/login');
    expect(screen.queryByLabelText('Nova senha')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Salvar nova senha' })).not.toBeInTheDocument();

    // Dá tempo de ler o aviso: um instante antes dos 2,5 s a pessoa ainda está nele.
    act(() => {
      vi.advanceTimersByTime(2499);
    });
    expect(screen.queryByText('tela de login')).not.toBeInTheDocument();
    expect(screen.getByText(/^Senha alterada\./)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText('tela de login')).toBeInTheDocument();
    expect(screen.queryByText(/^Senha alterada\./)).not.toBeInTheDocument();

    // replace: voltar cai na tela de antes, não no link de redefinição (o token é de uso único).
    vi.useRealTimers();
    await user.click(screen.getByRole('button', { name: 'voltar no histórico' }));
    expect(screen.getByText('tela anterior')).toBeInTheDocument();
    expect(resetPassword).toHaveBeenCalledTimes(1);
  });

  it('enquanto salva, o botão fica desabilitado, não envia duas vezes e o aviso anterior já sumiu', async () => {
    const user = userEvent.setup();
    const pending = deferred<void>();
    resetPassword.mockReturnValue(pending.promise);
    renderAt('/redefinir-senha?token=tok-123');
    await user.type(screen.getByLabelText('Nova senha'), 'senhaNova1');
    await user.type(screen.getByLabelText('Confirmar nova senha'), 'senhaNova2');
    await user.click(screen.getByRole('button', { name: 'Salvar nova senha' }));
    expect(screen.getByText('As senhas não conferem')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Confirmar nova senha'));
    await user.type(screen.getByLabelText('Confirmar nova senha'), 'senhaNova1');
    await user.click(screen.getByRole('button', { name: 'Salvar nova senha' }));

    const busy = screen.getByRole('button', { name: '…' });
    expect(busy).toBeDisabled();
    // O aviso de senhas diferentes some no envio, sem esperar a resposta da API.
    expect(screen.queryByText('As senhas não conferem')).not.toBeInTheDocument();
    await user.click(busy);
    expect(resetPassword).toHaveBeenCalledTimes(1);

    pending.reject(new Error('Link inválido ou vencido'));
    expect(await screen.findByRole('button', { name: 'Salvar nova senha' })).toBeEnabled();
    expect(screen.getByText('Link inválido ou vencido')).toBeInTheDocument();
  });

  it('token vencido: mostra a mensagem da API no lugar do aviso anterior e continua no formulário', async () => {
    const user = userEvent.setup();
    resetPassword.mockRejectedValue(new Error('Link inválido ou vencido'));
    renderAt('/redefinir-senha?token=tok-velho');
    await user.type(screen.getByLabelText('Nova senha'), 'senhaNova1');
    await user.type(screen.getByLabelText('Confirmar nova senha'), 'outraSenha1');
    await user.click(screen.getByRole('button', { name: 'Salvar nova senha' }));
    expect(screen.getByText('As senhas não conferem')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Confirmar nova senha'));
    await user.type(screen.getByLabelText('Confirmar nova senha'), 'senhaNova1');
    await user.click(screen.getByRole('button', { name: 'Salvar nova senha' }));

    expect(await screen.findByText('Link inválido ou vencido')).toBeInTheDocument();
    expect(resetPassword).toHaveBeenCalledWith('tok-velho', 'senhaNova1');
    expect(screen.queryByText('As senhas não conferem')).not.toBeInTheDocument();
    expect(screen.queryByText(/Senha alterada/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Nova senha')).toHaveValue('senhaNova1');
  });

  it('falha sem mensagem (não é um Error) cai no texto padrão', async () => {
    const user = userEvent.setup();
    resetPassword.mockRejectedValue({ status: 500 });
    renderAt('/redefinir-senha?token=tok-123');
    await user.type(screen.getByLabelText('Nova senha'), 'senhaNova1');
    await user.type(screen.getByLabelText('Confirmar nova senha'), 'senhaNova1');
    await user.click(screen.getByRole('button', { name: 'Salvar nova senha' }));
    expect(await screen.findByText('Erro ao redefinir')).toBeInTheDocument();
  });
});

describe('VerifyEmailView (/verificar-email)', () => {
  it('link sem token: diz que está incompleto e não chama a API', () => {
    renderAt('/verificar-email');
    expect(screen.getByRole('heading', { name: 'Confirmação de e-mail' })).toBeInTheDocument();
    expect(document.title).toBe('Confirmar e-mail · Escambo');
    expect(screen.getByText('Link incompleto.')).toBeInTheDocument();
    expect(screen.queryByText('Confirmando…')).not.toBeInTheDocument();
    expect(verifyEmail).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Entrar' })).toHaveAttribute('href', '/login');
    expect(screen.queryByRole('link', { name: 'Reenviar pelo app' })).not.toBeInTheDocument();
    expect(auth.refreshUser).not.toHaveBeenCalled();
  });

  it('link sem token, com sessão aberta: o caminho é reenviar pelo Perfil, não entrar', () => {
    auth.user = { id: 1, email: 'ana@escambo.test' };
    renderAt('/verificar-email');
    expect(screen.getByText('Link incompleto.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Reenviar pelo app' })).toHaveAttribute(
      'href',
      '/perfil',
    );
    expect(screen.queryByRole('link', { name: 'Entrar' })).not.toBeInTheDocument();
    expect(verifyEmail).not.toHaveBeenCalled();
  });

  it('confirma assim que abre: mostra "Confirmando…", manda o token e recarrega a sessão', async () => {
    const pending = deferred<{ id: number }>();
    verifyEmail.mockReturnValue(pending.promise);
    renderAt('/verificar-email?token=tok-email');

    expect(screen.getByText('Confirmando…')).toBeInTheDocument();
    expect(verifyEmail).toHaveBeenCalledTimes(1);
    expect(verifyEmail).toHaveBeenCalledWith('tok-email');
    expect(auth.refreshUser).not.toHaveBeenCalled();
    // Ainda sem desfecho: nem sucesso nem erro, e nenhum caminho para clicar.
    expect(screen.queryByText('E-mail confirmado. Obrigado!')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Entrar' })).not.toBeInTheDocument();

    pending.resolve({ id: 1 });
    expect(await screen.findByText('E-mail confirmado. Obrigado!')).toBeInTheDocument();
    expect(screen.queryByText('Confirmando…')).not.toBeInTheDocument();
    await waitFor(() => expect(auth.refreshUser).toHaveBeenCalledTimes(1));
    expect(auth.refreshUser).toHaveBeenCalledWith();
    // Sem sessão neste aparelho (link aberto em outro navegador): o caminho é entrar.
    expect(screen.getByRole('link', { name: 'Entrar' })).toHaveAttribute('href', '/login');
  });

  it('o sucesso aparece assim que a API confirma, sem esperar a sessão recarregar', async () => {
    const reload = deferred<void>();
    auth.refreshUser.mockReturnValue(reload.promise);
    renderAt('/verificar-email?token=tok-email');

    expect(await screen.findByText('E-mail confirmado. Obrigado!')).toBeInTheDocument();
    expect(auth.refreshUser).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Confirmando…')).not.toBeInTheDocument();

    await act(async () => {
      reload.resolve();
      await reload.promise;
    });
    expect(screen.getByText('E-mail confirmado. Obrigado!')).toBeInTheDocument();
    expect(screen.queryByText('Link inválido ou vencido')).not.toBeInTheDocument();
  });

  it('com sessão aberta, o sucesso leva de volta ao app', async () => {
    auth.user = { id: 1, email: 'ana@escambo.test' };
    renderAt('/verificar-email?token=tok-email');
    expect(await screen.findByText('E-mail confirmado. Obrigado!')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ir para o app' })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('link', { name: 'Entrar' })).not.toBeInTheDocument();
  });

  it('o token é de uso único: mesmo montando duas vezes (StrictMode), confirma uma vez só', async () => {
    renderAt('/verificar-email?token=tok-email', { strict: true });
    expect(await screen.findByText('E-mail confirmado. Obrigado!')).toBeInTheDocument();
    expect(verifyEmail).toHaveBeenCalledTimes(1);
    expect(verifyEmail).toHaveBeenCalledWith('tok-email');
  });

  it('link vencido, sem sessão: mostra a mensagem da API e manda entrar', async () => {
    verifyEmail.mockRejectedValue(new Error('Este link já foi usado ou venceu.'));
    renderAt('/verificar-email?token=tok-velho');
    expect(await screen.findByText('Este link já foi usado ou venceu.')).toBeInTheDocument();
    expect(verifyEmail).toHaveBeenCalledWith('tok-velho');
    expect(screen.queryByText('E-mail confirmado. Obrigado!')).not.toBeInTheDocument();
    expect(screen.queryByText('Confirmando…')).not.toBeInTheDocument();
    expect(auth.refreshUser).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Entrar' })).toHaveAttribute('href', '/login');
  });

  it('link vencido, com sessão: oferece reenviar pelo Perfil', async () => {
    auth.user = { id: 1, email: 'ana@escambo.test' };
    verifyEmail.mockRejectedValue(new Error('Este link já foi usado ou venceu.'));
    renderAt('/verificar-email?token=tok-velho');
    expect(await screen.findByText('Este link já foi usado ou venceu.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Reenviar pelo app' })).toHaveAttribute(
      'href',
      '/perfil',
    );
  });

  it('falha sem mensagem (não é um Error) cai no texto padrão', async () => {
    verifyEmail.mockRejectedValue('timeout');
    renderAt('/verificar-email?token=tok-email');
    expect(await screen.findByText('Link inválido ou vencido')).toBeInTheDocument();
  });
});
