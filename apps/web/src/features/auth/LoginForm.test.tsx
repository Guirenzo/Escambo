import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginForm } from './LoginForm';

/**
 * A porta de entrada: o mesmo formulário entra e cadastra. O que vai para o contexto de sessão em
 * cada modo, o consentimento obrigatório do cadastro (ADR 54) e o erro que o contexto devolve.
 */

const login = vi.fn();
const register = vi.fn();
/** O que o AuthProvider entrega à tela; `error` é o texto que ele guarda quando a API recusa. */
const auth = {
  login: (input: unknown) => login(input),
  register: (input: unknown) => register(input),
  error: null as string | null,
};
vi.mock('../../lib/auth', () => ({ useAuth: () => auth }));

const renderForm = () =>
  render(
    <MemoryRouter>
      <LoginForm />
    </MemoryRouter>,
  );

/** O botão que envia: "Entrar" e "Criar conta" também são nomes das abas e do link de baixo. */
function submitButton(): HTMLElement {
  const found = screen.getAllByRole('button').find((b) => b.getAttribute('type') === 'submit');
  if (!found) throw new Error('formulário sem botão de envio');
  return found;
}

/** As duas abas vêm primeiro no formulário; o link de alternar vem por último. */
function tab(name: 'Entrar' | 'Criar conta'): HTMLElement {
  const first = screen.getAllByRole('button', { name })[0];
  if (!first) throw new Error(`aba ${name} não encontrada`);
  return first;
}

const consentBox = () =>
  screen.getByRole('checkbox', {
    name: 'Li e aceito os Termos de Uso e a Política de Privacidade.',
  });

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  login.mockReset();
  login.mockResolvedValue(undefined);
  register.mockReset();
  register.mockResolvedValue(undefined);
  auth.error = null;
});

describe('LoginForm: entrar', () => {
  it('abre no modo entrar, sem os campos do cadastro e com o caminho para a senha esquecida', () => {
    renderForm();
    expect(document.title).toBe('Entrar · Escambo');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Troque. Contrate.Evolua.');
    expect(screen.getByRole('heading', { name: 'Bem-vindo de volta' })).toBeInTheDocument();
    expect(submitButton()).toHaveTextContent('Entrar');
    expect(submitButton()).toBeEnabled();
    expect(screen.queryByLabelText('Eu sou')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Esqueci minha senha' })).toHaveAttribute(
      'href',
      '/esqueci-senha',
    );
    // O gerenciador de senhas oferece a senha guardada, não uma nova.
    expect(screen.getByLabelText('Senha')).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByLabelText('Senha')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Senha')).toBeRequired();
    const email = screen.getByLabelText('E-mail');
    expect(email).toBeRequired();
    expect(email).toHaveAttribute('type', 'email');
    expect(email).toHaveAttribute('autocomplete', 'email');
    expect(screen.getByPlaceholderText('voce@exemplo.com')).toBe(email);
    expect(screen.getByText('Novo por aqui?')).toBeInTheDocument();
    expect(screen.queryByText('Já tem conta?')).not.toBeInTheDocument();
  });

  it('os três destaques da marca aparecem ao lado do formulário', () => {
    renderForm();
    expect(screen.getByText('Escambo')).toBeInTheDocument();
    expect(
      screen.getByText('O iFood dos serviços — do mecânico ao dev, com a confiança que faltava.'),
    ).toBeInTheDocument();
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual([
      'Troque serviço por serviçoO escambo que dá nome ao app — com torna justa e escrow.',
      'Créditos EscamboTrabalhe, ganhe créditos e gaste em qualquer serviço.',
      'Confiança de verdadeEscambo Score, pagamento protegido e chat em tempo real.',
    ]);
  });

  it('entrar manda só e-mail e senha para o login, e não cadastra', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('E-mail'), 'ana@escambo.test');
    await user.type(screen.getByLabelText('Senha'), 'segredo123');
    await user.click(submitButton());

    expect(login).toHaveBeenCalledTimes(1);
    expect(login).toHaveBeenCalledWith({ email: 'ana@escambo.test', password: 'segredo123' });
    expect(register).not.toHaveBeenCalled();
  });

  it('Enter no campo de senha também envia', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('E-mail'), 'ana@escambo.test');
    await user.type(screen.getByLabelText('Senha'), 'segredo123{Enter}');
    expect(login).toHaveBeenCalledWith({ email: 'ana@escambo.test', password: 'segredo123' });
  });

  it('sem e-mail ou sem senha nada é enviado', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(submitButton());
    expect(login).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('E-mail'), 'ana@escambo.test');
    await user.click(submitButton());
    expect(login).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Senha')).toBeInvalid();
    expect(screen.getByLabelText('E-mail')).toBeValid();
  });

  it('só com a senha, ou com e-mail malformado, nada é enviado', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('Senha'), 'segredo123');
    await user.click(submitButton());
    expect(login).not.toHaveBeenCalled();
    expect(screen.getByLabelText('E-mail')).toBeInvalid();

    await user.type(screen.getByLabelText('E-mail'), 'ana-sem-arroba');
    await user.click(submitButton());
    await user.type(screen.getByLabelText('Senha'), '{Enter}');
    expect(login).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(screen.getByLabelText('E-mail')).toBeInvalid();
  });

  it('enquanto entra, o botão mostra "…" desabilitado e volta ao normal no fim', async () => {
    const user = userEvent.setup();
    const pending = deferred();
    login.mockReturnValue(pending.promise);
    renderForm();
    await user.type(screen.getByLabelText('E-mail'), 'ana@escambo.test');
    await user.type(screen.getByLabelText('Senha'), 'segredo123');
    await user.click(submitButton());

    expect(submitButton()).toHaveTextContent('…');
    expect(submitButton()).toBeDisabled();
    await user.click(submitButton());
    expect(login).toHaveBeenCalledTimes(1);

    pending.resolve();
    expect(await screen.findByRole('heading', { name: 'Bem-vindo de volta' })).toBeInTheDocument();
    await waitFor(() => expect(submitButton()).toBeEnabled());
    expect(submitButton()).toHaveTextContent('Entrar');
  });

  it('login recusado: mostra o erro que o contexto guardou e libera o botão para tentar de novo', async () => {
    const user = userEvent.setup();
    login.mockImplementation(async () => {
      auth.error = 'E-mail ou senha incorretos';
      throw new Error('E-mail ou senha incorretos');
    });
    renderForm();
    expect(screen.queryByText('E-mail ou senha incorretos')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('E-mail'), 'ana@escambo.test');
    await user.type(screen.getByLabelText('Senha'), 'errada');
    await user.click(submitButton());

    expect(await screen.findByText('E-mail ou senha incorretos')).toBeInTheDocument();
    expect(submitButton()).toBeEnabled();
    expect(submitButton()).toHaveTextContent('Entrar');
    // O que foi digitado continua lá: é só corrigir a senha.
    expect(screen.getByLabelText('E-mail')).toHaveValue('ana@escambo.test');
  });
});

describe('LoginForm: criar conta', () => {
  it('a aba "Criar conta" troca o título, pede o papel e o consentimento, e tira a senha esquecida', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(tab('Criar conta'));

    expect(screen.getByRole('heading', { name: 'Crie sua conta' })).toBeInTheDocument();
    expect(submitButton()).toHaveTextContent('Criar conta');
    const role = screen.getByRole('combobox', { name: 'Eu sou' });
    expect(role).toHaveValue('client');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Cliente — quero contratar',
      'Freelancer — quero oferecer',
    ]);
    expect(screen.queryByRole('link', { name: 'Esqueci minha senha' })).not.toBeInTheDocument();
    // Senha nova: o gerenciador sugere uma em vez de preencher a guardada.
    expect(screen.getByLabelText('Senha')).toHaveAttribute('autocomplete', 'new-password');
  });

  it('o consentimento aponta para os dois documentos, em outra aba', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(tab('Criar conta'));

    expect(consentBox()).toBeRequired();
    expect(consentBox()).not.toBeChecked();
    const terms = screen.getByRole('link', { name: 'Termos de Uso' });
    expect(terms).toHaveAttribute('href', '/termos');
    expect(terms).toHaveAttribute('target', '_blank');
    // A aba nova não ganha acesso a esta (window.opener) nem recebe de onde veio.
    expect(terms).toHaveAttribute('rel', 'noreferrer');
    const privacy = screen.getByRole('link', { name: 'Política de Privacidade' });
    expect(privacy).toHaveAttribute('href', '/privacidade');
    expect(privacy).toHaveAttribute('target', '_blank');
    expect(privacy).toHaveAttribute('rel', 'noreferrer');
  });

  it('sem aceitar os termos o cadastro não sai: botão desabilitado, e Enter não envia', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(tab('Criar conta'));
    await user.type(screen.getByLabelText('E-mail'), 'novo@escambo.test');
    await user.type(screen.getByLabelText('Senha'), 'segredo123');

    expect(submitButton()).toBeDisabled();
    await user.click(submitButton());
    await user.type(screen.getByLabelText('Senha'), '{Enter}');
    expect(register).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();

    await user.click(consentBox());
    expect(consentBox()).toBeChecked();
    expect(submitButton()).toBeEnabled();

    // Desmarcar volta a bloquear.
    await user.click(consentBox());
    expect(submitButton()).toBeDisabled();
  });

  it('cadastro de cliente (o padrão) manda e-mail, senha, papel e o aceite', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(tab('Criar conta'));
    await user.type(screen.getByLabelText('E-mail'), 'novo@escambo.test');
    await user.type(screen.getByLabelText('Senha'), 'segredo123');
    await user.click(consentBox());
    await user.click(submitButton());

    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith({
      email: 'novo@escambo.test',
      password: 'segredo123',
      role: 'client',
      legalAccepted: true,
    });
    expect(login).not.toHaveBeenCalled();
  });

  it('escolher "Freelancer" manda o papel de freelancer', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(tab('Criar conta'));
    await user.type(screen.getByLabelText('E-mail'), 'dev@escambo.test');
    await user.type(screen.getByLabelText('Senha'), 'segredo123');
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Eu sou' }),
      'Freelancer — quero oferecer',
    );
    await user.click(consentBox());
    await user.click(submitButton());

    expect(register).toHaveBeenCalledWith({
      email: 'dev@escambo.test',
      password: 'segredo123',
      role: 'freelancer',
      legalAccepted: true,
    });
  });

  it('enquanto cadastra, o botão mostra "…" desabilitado e não cadastra duas vezes', async () => {
    const user = userEvent.setup();
    const pending = deferred();
    register.mockReturnValue(pending.promise);
    renderForm();
    await user.click(tab('Criar conta'));
    await user.type(screen.getByLabelText('E-mail'), 'novo@escambo.test');
    await user.type(screen.getByLabelText('Senha'), 'segredo123');
    await user.click(consentBox());
    await user.click(submitButton());

    // Aceite marcado não basta para liberar: durante o envio o botão trava do mesmo jeito.
    expect(submitButton()).toHaveTextContent('…');
    expect(submitButton()).toBeDisabled();
    await user.click(submitButton());
    await user.type(screen.getByLabelText('Senha'), '{Enter}');
    expect(register).toHaveBeenCalledTimes(1);

    pending.resolve();
    await waitFor(() => expect(submitButton()).toBeEnabled());
    expect(submitButton()).toHaveTextContent('Criar conta');
    expect(login).not.toHaveBeenCalled();
  });

  it('cadastro recusado (e-mail já usado): mostra o erro do contexto e libera o botão', async () => {
    const user = userEvent.setup();
    register.mockImplementation(async () => {
      auth.error = 'Este e-mail já tem conta';
      throw new Error('Este e-mail já tem conta');
    });
    renderForm();
    await user.click(tab('Criar conta'));
    await user.type(screen.getByLabelText('E-mail'), 'ana@escambo.test');
    await user.type(screen.getByLabelText('Senha'), 'segredo123');
    await user.click(consentBox());
    await user.click(submitButton());

    expect(await screen.findByText('Este e-mail já tem conta')).toBeInTheDocument();
    expect(submitButton()).toBeEnabled();
    expect(submitButton()).toHaveTextContent('Criar conta');
    expect(consentBox()).toBeChecked();
  });
});

describe('LoginForm: alternar entre entrar e criar conta', () => {
  it('o link de baixo leva ao cadastro e volta, sem apagar o que foi digitado', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('E-mail'), 'ana@escambo.test');
    expect(screen.getByText('Novo por aqui?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Crie sua conta' }));
    expect(screen.getByRole('heading', { name: 'Crie sua conta' })).toBeInTheDocument();
    expect(screen.getByText('Já tem conta?')).toBeInTheDocument();
    expect(screen.getByLabelText('E-mail')).toHaveValue('ana@escambo.test');

    // No cadastro, "Entrar" é a aba (primeiro) e o link de baixo (último).
    const back = screen.getAllByRole('button', { name: 'Entrar' }).at(-1);
    if (!back) throw new Error('link "Entrar" não encontrado');
    await user.click(back);
    expect(screen.getByRole('heading', { name: 'Bem-vindo de volta' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByLabelText('E-mail')).toHaveValue('ana@escambo.test');
  });

  it('a aba "Entrar" volta do cadastro, e aí o envio é login, não cadastro', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(tab('Criar conta'));
    await user.click(tab('Entrar'));
    expect(screen.getByRole('heading', { name: 'Bem-vindo de volta' })).toBeInTheDocument();

    await user.type(screen.getByLabelText('E-mail'), 'ana@escambo.test');
    await user.type(screen.getByLabelText('Senha'), 'segredo123');
    await user.click(submitButton());
    expect(login).toHaveBeenCalledWith({ email: 'ana@escambo.test', password: 'segredo123' });
    expect(register).not.toHaveBeenCalled();
  });

  it('clicar na aba que já está aberta não troca de modo (aba escolhe, não alterna)', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(tab('Entrar'));
    expect(screen.getByRole('heading', { name: 'Bem-vindo de volta' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

    await user.click(tab('Criar conta'));
    await user.click(tab('Criar conta'));
    expect(screen.getByRole('heading', { name: 'Crie sua conta' })).toBeInTheDocument();
    expect(consentBox()).toBeInTheDocument();
    expect(submitButton()).toHaveTextContent('Criar conta');
  });
});
