import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MfaStatus } from '@escambo/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dt } from '../../lib/format';
import { ToastProvider } from '../../lib/toast';
import { DoisFatoresCard } from './DoisFatoresCard';

/**
 * Verificação em duas etapas no Perfil (RF-090, ADR 66): cada situação da conta (carregando, erro,
 * indisponível, desativada, ativa), a ativação inteira (senha → QR e chave em texto → código →
 * códigos de recuperação mostrados uma vez), e gerar códigos novos ou desativar com a senha e um
 * código. Erros ficam junto do campo certo (aria-invalid + aria-describedby) e o foco acompanha a
 * troca de passo.
 */

vi.setConfig({ testTimeout: 20_000 });

const api = vi.hoisted(() => ({
  mfaStatus: vi.fn(),
  mfaSetup: vi.fn(),
  mfaEnable: vi.fn(),
  mfaDisable: vi.fn(),
  mfaRecoveryCodes: vi.fn(),
}));
vi.mock('../../lib/api', () => ({ api }));
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ user: { email: 'ana@escambo.test' } }) }));
const saveBlob = vi.hoisted(() => vi.fn());
vi.mock('../../lib/download', () => ({ saveBlob }));

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const SETUP = {
  secret: SECRET,
  otpauthUrl: `otpauth://totp/Escambo:ana%40escambo.test?secret=${SECRET}&issuer=Escambo&algorithm=SHA1&digits=6&period=30`,
};
const CODES = Array.from({ length: 10 }, (_, i) => `AAAA-${String(1000 + i)}`);

const statusOf = (o: Partial<MfaStatus> = {}): MfaStatus => ({
  enabled: false,
  confirmedAt: null,
  recoveryCodesLeft: 0,
  available: true,
  required: false,
  ...o,
});
const ACTIVE = statusOf({
  enabled: true,
  confirmedAt: '2026-10-01T15:00:00.000Z',
  recoveryCodesLeft: 8,
});

/** Erro da API como o cliente HTTP entrega: mensagem em português e o código. */
const apiError = (message: string, code: string) => Object.assign(new Error(message), { code });

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <DoisFatoresCard />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const card = () => screen.getByTestId('dois-fatores');
const toast = (text: string) => screen.findByText(text, { selector: '.toast-msg' });

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  saveBlob.mockReset();
  api.mfaStatus.mockResolvedValue(statusOf());
});
afterEach(() => vi.restoreAllMocks());

describe('DoisFatoresCard: situações da conta', () => {
  it('enquanto a situação chega, o cartão mostra o esqueleto', () => {
    api.mfaStatus.mockReturnValue(new Promise(() => undefined));
    renderCard();
    expect(
      screen.getByRole('heading', { level: 3, name: 'Verificação em duas etapas' }),
    ).toBeInTheDocument();
    expect(within(card()).getByRole('status', { name: 'Carregando' })).toBeInTheDocument();
    expect(card()).toHaveAttribute('id', 'dois-fatores');
  });

  it('falha ao ler: mostra o erro e tenta de novo', async () => {
    const user = userEvent.setup();
    api.mfaStatus.mockRejectedValueOnce(new Error('Serviço indisponível no momento.'));
    renderCard();

    expect(await within(card()).findByRole('alert')).toHaveTextContent(
      'Serviço indisponível no momento.',
    );
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('button', { name: /Ativar/ })).toBeInTheDocument();
    expect(api.mfaStatus).toHaveBeenCalledTimes(2);
  });

  it('servidor sem a chave de cifragem: explica e não oferece ativar', async () => {
    api.mfaStatus.mockResolvedValue(statusOf({ available: false }));
    renderCard();

    expect(await screen.findByTestId('mfa-indisponivel')).toHaveTextContent(
      'o servidor ainda não tem a chave de cifragem',
    );
    expect(screen.queryByRole('button', { name: /Ativar/ })).not.toBeInTheDocument();
  });

  it('desativada: explica o que muda e oferece "Ativar"', async () => {
    renderCard();

    expect(await screen.findByRole('button', { name: 'Ativar' })).toBeEnabled();
    expect(card()).toHaveTextContent('o login passa a pedir um código de 6 dígitos');
    expect(screen.queryByTestId('mfa-obrigatoria')).not.toBeInTheDocument();
  });

  it('conta admin num servidor que exige a 2FA: avisa que o painel depende dela', async () => {
    api.mfaStatus.mockResolvedValue(statusOf({ required: true }));
    renderCard();

    expect(await screen.findByTestId('mfa-obrigatoria')).toHaveTextContent(
      'o painel só abre com a verificação em duas etapas ativa',
    );
  });

  it('ativa: desde quando, quantos códigos restam e as duas ações', async () => {
    api.mfaStatus.mockResolvedValue(ACTIVE);
    renderCard();

    expect(await screen.findByTestId('mfa-ativa')).toHaveTextContent(
      `Ativa desde ${dt(ACTIVE.confirmedAt!)}. O login pede a senha e o código do app autenticador.`,
    );
    const left = screen.getByTestId('mfa-codigos-restantes');
    expect(left).toHaveTextContent(/^Códigos de recuperação restantes: 8\.$/);
    expect(left).not.toHaveClass('notice');
    expect(screen.getByRole('button', { name: 'Gerar novos códigos' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Desativar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ativar' })).not.toBeInTheDocument();
  });

  it('com 3 códigos ou menos, o aviso pede para gerar novos', async () => {
    api.mfaStatus.mockResolvedValue({ ...ACTIVE, recoveryCodesLeft: 3, confirmedAt: null });
    renderCard();

    const left = await screen.findByTestId('mfa-codigos-restantes');
    expect(left).toHaveClass('notice');
    expect(left).toHaveTextContent(
      'Códigos de recuperação restantes: 3. Restam poucos: gere códigos novos e guarde-os.',
    );
    expect(screen.getByTestId('mfa-ativa')).toHaveTextContent(/^Ativa\. /);
  });
});

describe('DoisFatoresCard: ativar', () => {
  async function openPassword(user: ReturnType<typeof userEvent.setup>) {
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Ativar' }));
    return screen.getByRole('form', { name: 'Ativar a verificação em duas etapas' });
  }

  async function toScan(user: ReturnType<typeof userEvent.setup>) {
    api.mfaSetup.mockResolvedValue(SETUP);
    const form = await openPassword(user);
    await user.type(within(form).getByLabelText('Senha atual'), 'senha-1');
    await user.click(within(form).getByRole('button', { name: 'Continuar' }));
    await screen.findByRole('heading', { name: 'Adicione a conta no app autenticador' });
  }

  it('"Ativar" pede a senha, com o foco no campo; "Cancelar" volta com o foco em "Ativar"', async () => {
    const user = userEvent.setup();
    const form = await openPassword(user);

    const password = within(form).getByLabelText('Senha atual');
    expect(password).toHaveFocus();
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autocomplete', 'current-password');
    expect(password).toHaveAttribute('aria-invalid', 'false');

    await user.click(within(form).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ativar' })).toHaveFocus());
    expect(api.mfaSetup).not.toHaveBeenCalled();
  });

  it('senha errada: o erro fica ligado ao campo da senha, que volta a ter o foco', async () => {
    const user = userEvent.setup();
    api.mfaSetup.mockRejectedValue(apiError('Senha atual incorreta', 'wrong_password'));
    const form = await openPassword(user);
    const password = within(form).getByLabelText('Senha atual');

    await user.type(password, 'errada');
    await user.click(within(form).getByRole('button', { name: 'Continuar' }));

    const alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent('Senha atual incorreta');
    expect(password).toHaveAttribute('aria-invalid', 'true');
    expect(password).toHaveAttribute('aria-describedby', alert.id);
    expect(password).toHaveFocus();
    expect(api.mfaSetup).toHaveBeenCalledWith('errada');
    expect(within(form).getByRole('button', { name: 'Continuar' })).toBeEnabled();
  });

  it('falha que não é da senha: a mensagem aparece, sem marcar o campo', async () => {
    const user = userEvent.setup();
    api.mfaSetup.mockRejectedValue(new TypeError('Failed to fetch'));
    const form = await openPassword(user);

    await user.type(within(form).getByLabelText('Senha atual'), 'senha-1');
    await user.click(within(form).getByRole('button', { name: 'Continuar' }));

    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'Não foi possível começar a ativação. Tente de novo.',
    );
    expect(within(form).getByLabelText('Senha atual')).toHaveAttribute('aria-invalid', 'false');
  });

  it('já ativa (outra aba) ou indisponível: avisa e relê a situação', async () => {
    const user = userEvent.setup();
    api.mfaSetup.mockRejectedValue(
      apiError('A verificação em duas etapas já está ativa.', 'mfa_already_enabled'),
    );
    const form = await openPassword(user);
    api.mfaStatus.mockResolvedValue(ACTIVE);

    await user.type(within(form).getByLabelText('Senha atual'), 'senha-1');
    await user.click(within(form).getByRole('button', { name: 'Continuar' }));

    expect(await toast('A verificação em duas etapas já está ativa.')).toBeInTheDocument();
    expect(await screen.findByTestId('mfa-ativa')).toBeInTheDocument();
    expect(api.mfaStatus).toHaveBeenCalledTimes(2);
  });

  it('o passo do QR: foco no título, QR com nome, a chave em grupos de 4 e "Copiar chave"', async () => {
    const user = userEvent.setup();
    await toScan(user);

    expect(api.mfaSetup).toHaveBeenCalledWith('senha-1');
    expect(
      screen.getByRole('heading', { name: 'Adicione a conta no app autenticador' }),
    ).toHaveFocus();
    expect(
      screen.getByRole('img', { name: 'QR code para o app autenticador' }),
    ).toBeInTheDocument();
    const secret = screen.getByTestId('mfa-secret');
    expect(secret).toHaveTextContent('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
    expect(secret).toHaveAccessibleName('Chave para digitar no app');
    const copy = vi.spyOn(navigator.clipboard, 'writeText');

    await user.click(screen.getByRole('button', { name: 'Copiar chave' }));

    expect(copy).toHaveBeenCalledWith(SECRET);
    expect(await toast('Chave copiada.')).toBeInTheDocument();
    const field = screen.getByLabelText('Código do app autenticador');
    expect(field).toHaveAttribute('inputmode', 'numeric');
    expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    expect(field).toHaveAccessibleDescription(
      'Os 6 dígitos que o app mostra agora para a conta Escambo (mudam a cada 30 segundos).',
    );
  });

  it('copiar a chave sem acesso à área de transferência: orienta a copiar à mão', async () => {
    const user = userEvent.setup();
    await toScan(user);
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('negado'));

    await user.click(screen.getByRole('button', { name: 'Copiar chave' }));

    expect(
      await toast('Não deu para copiar daqui: selecione a chave e copie.'),
    ).toBeInTheDocument();
  });

  it('código incompleto não vai à API; o recusado pela API marca o campo', async () => {
    const user = userEvent.setup();
    await toScan(user);
    const field = screen.getByLabelText('Código do app autenticador');

    await user.type(field, '12a');
    await user.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Digite os 6 dígitos que o app mostra agora.',
    );
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveFocus();
    expect(api.mfaEnable).not.toHaveBeenCalled();

    api.mfaEnable.mockRejectedValue(apiError('Código inválido.', 'invalid_mfa_code'));
    await user.clear(field);
    await user.type(field, '000 000');
    await user.click(screen.getByRole('button', { name: 'Confirmar' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Código inválido.'));
    expect(api.mfaEnable).toHaveBeenCalledWith('000000');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field.getAttribute('aria-describedby')).toContain(screen.getByRole('alert').id);
  });

  it('muitas tentativas: o aviso aparece, sem marcar o campo como errado', async () => {
    const user = userEvent.setup();
    await toScan(user);
    api.mfaEnable.mockRejectedValue(
      apiError('Muitas tentativas. Tente de novo em 15 minutos.', 'mfa_locked'),
    );

    await user.type(screen.getByLabelText('Código do app autenticador'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirmar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Muitas tentativas. Tente de novo em 15 minutos.',
    );
    expect(screen.getByLabelText('Código do app autenticador')).toHaveAttribute(
      'aria-invalid',
      'false',
    );
  });

  it('o segredo pendente sumiu: avisa e recomeça pela senha', async () => {
    const user = userEvent.setup();
    await toScan(user);
    api.mfaEnable.mockRejectedValue(apiError('Comece a ativação de novo.', 'mfa_not_started'));

    await user.type(screen.getByLabelText('Código do app autenticador'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirmar' }));

    expect(await toast('Comece a ativação de novo.')).toBeInTheDocument();
    expect(screen.getByLabelText('Senha atual')).toHaveFocus();
  });

  it('ativada em outra aba no meio do caminho: avisa e volta ao cartão relido', async () => {
    const user = userEvent.setup();
    await toScan(user);
    api.mfaEnable.mockRejectedValue(apiError('Já está ativa.', 'mfa_already_enabled'));
    api.mfaStatus.mockResolvedValue(ACTIVE);

    await user.type(screen.getByLabelText('Código do app autenticador'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirmar' }));

    expect(await toast('Já está ativa.')).toBeInTheDocument();
    expect(await screen.findByTestId('mfa-ativa')).toBeInTheDocument();
  });

  it('"Cancelar" no passo do QR volta ao cartão com o foco em "Ativar"', async () => {
    const user = userEvent.setup();
    await toScan(user);

    await user.click(screen.getByRole('button', { name: 'Cancelar' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Ativar' })).toHaveFocus());
  });

  it('código certo: os 10 códigos aparecem uma vez, com copiar, baixar e "Concluir" só depois de guardar', async () => {
    const user = userEvent.setup();
    await toScan(user);
    api.mfaEnable.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', recoveryCodes: CODES });

    await user.type(screen.getByLabelText('Código do app autenticador'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirmar' }));

    expect(
      await toast('Verificação em duas etapas ativada. As outras sessões foram encerradas.'),
    ).toBeInTheDocument();
    expect(api.mfaEnable).toHaveBeenCalledWith('123456');
    expect(screen.getByRole('heading', { name: 'Códigos de recuperação' })).toHaveFocus();
    const list = screen.getByRole('list', { name: 'Códigos de recuperação' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(CODES);

    const copy = vi.spyOn(navigator.clipboard, 'writeText');
    await user.click(screen.getByRole('button', { name: 'Copiar códigos' }));
    expect(copy).toHaveBeenCalledWith(CODES.join('\n'));
    expect(await toast('Códigos copiados.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Baixar .txt' }));
    expect(saveBlob).toHaveBeenCalledTimes(1);
    const [blob, name] = saveBlob.mock.calls[0] as [Blob, string];
    expect(name).toBe('escambo-codigos-de-recuperacao.txt');
    expect(blob.type).toBe('text/plain;charset=utf-8');
    const text = await blob.text();
    expect(text).toContain('Conta: ana@escambo.test');
    expect(text).toContain(' 1. AAAA-1000');
    expect(text).toContain('10. AAAA-1009');

    const done = screen.getByRole('button', { name: 'Concluir' });
    expect(done).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Guardei os códigos em lugar seguro' }));
    expect(done).toBeEnabled();

    api.mfaStatus.mockResolvedValue({ ...ACTIVE, recoveryCodesLeft: 10 });
    await user.click(done);

    const summary = await screen.findByTestId('mfa-ativa');
    await waitFor(() => expect(summary).toHaveFocus());
    expect(screen.getByTestId('mfa-codigos-restantes')).toHaveTextContent(
      'Códigos de recuperação restantes: 10.',
    );
    expect(screen.queryByRole('list', { name: 'Códigos de recuperação' })).not.toBeInTheDocument();
    await waitFor(() => expect(api.mfaStatus).toHaveBeenCalledTimes(2));
  });

  it('copiar os códigos sem acesso à área de transferência: sugere selecionar ou baixar', async () => {
    const user = userEvent.setup();
    await toScan(user);
    api.mfaEnable.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', recoveryCodes: CODES });
    await user.type(screen.getByLabelText('Código do app autenticador'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirmar' }));
    await screen.findByRole('list', { name: 'Códigos de recuperação' });
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('negado'));

    await user.click(screen.getByRole('button', { name: 'Copiar códigos' }));

    expect(
      await toast('Não deu para copiar daqui: selecione os códigos e copie, ou baixe o .txt.'),
    ).toBeInTheDocument();
  });
});

describe('DoisFatoresCard: ativa (gerar códigos novos e desativar)', () => {
  async function openModal(user: ReturnType<typeof userEvent.setup>, button: string) {
    api.mfaStatus.mockResolvedValue(ACTIVE);
    renderCard();
    await user.click(await screen.findByRole('button', { name: button }));
    return screen.getByRole('dialog');
  }

  it('gerar novos códigos: pede senha e código (do app ou de recuperação) e mostra os novos', async () => {
    const user = userEvent.setup();
    const dialog = await openModal(user, 'Gerar novos códigos');
    expect(dialog).toHaveAccessibleName('Gerar novos códigos');
    expect(dialog).toHaveTextContent('Os códigos que você tem hoje deixam de valer.');
    const code = within(dialog).getByLabelText('Código do app ou de recuperação');
    expect(code).toHaveAccessibleDescription(
      'Os 6 dígitos do app autenticador, ou um código de recuperação (XXXX-XXXX).',
    );
    api.mfaRecoveryCodes.mockResolvedValue({ recoveryCodes: CODES });

    await user.type(within(dialog).getByLabelText('Senha atual'), 'senha-1');
    await user.type(code, 'zz99-yy88');
    await user.click(within(dialog).getByRole('button', { name: 'Gerar códigos' }));

    expect(api.mfaRecoveryCodes).toHaveBeenCalledWith({ password: 'senha-1', code: 'zz99-yy88' });
    expect(
      await within(dialog).findByRole('heading', { name: 'Códigos de recuperação' }),
    ).toHaveFocus();
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(10);

    api.mfaStatus.mockResolvedValue({ ...ACTIVE, recoveryCodesLeft: 10 });
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Concluir' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('mfa-codigos-restantes')).toHaveTextContent(
        'Códigos de recuperação restantes: 10.',
      ),
    );
  });

  it('código em formato que não é nem do app nem de recuperação: erro no campo do código', async () => {
    const user = userEvent.setup();
    const dialog = await openModal(user, 'Gerar novos códigos');
    const code = within(dialog).getByLabelText('Código do app ou de recuperação');

    await user.type(within(dialog).getByLabelText('Senha atual'), 'senha-1');
    await user.type(code, '1234');
    await user.click(within(dialog).getByRole('button', { name: 'Gerar códigos' }));

    const alert = within(dialog).getByRole('alert');
    expect(alert).toHaveTextContent(
      'Digite os 6 dígitos do app ou um código de recuperação (XXXX-XXXX).',
    );
    expect(code).toHaveAttribute('aria-invalid', 'true');
    expect(code.getAttribute('aria-describedby')).toContain(alert.id);
    expect(code).toHaveFocus();
    expect(api.mfaRecoveryCodes).not.toHaveBeenCalled();
  });

  it('senha errada marca a senha; código errado marca o código; bloqueio não marca nenhum', async () => {
    const user = userEvent.setup();
    const dialog = await openModal(user, 'Gerar novos códigos');
    const password = within(dialog).getByLabelText('Senha atual');
    const code = within(dialog).getByLabelText('Código do app ou de recuperação');
    const submit = () => user.click(within(dialog).getByRole('button', { name: 'Gerar códigos' }));
    await user.type(password, 'errada');
    await user.type(code, '123456');

    api.mfaRecoveryCodes.mockRejectedValueOnce(apiError('Senha atual incorreta', 'wrong_password'));
    await submit();
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Senha atual incorreta'),
    );
    expect(password).toHaveAttribute('aria-invalid', 'true');
    expect(code).toHaveAttribute('aria-invalid', 'false');
    expect(password).toHaveFocus();

    api.mfaRecoveryCodes.mockRejectedValueOnce(apiError('Código inválido.', 'invalid_mfa_code'));
    await submit();
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Código inválido.'),
    );
    expect(password).toHaveAttribute('aria-invalid', 'false');
    expect(code).toHaveAttribute('aria-invalid', 'true');

    api.mfaRecoveryCodes.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await submit();
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'Não foi possível concluir. Tente de novo.',
      ),
    );
    expect(password).toHaveAttribute('aria-invalid', 'false');
    expect(code).toHaveAttribute('aria-invalid', 'false');
  });

  it('desativar: confirma com senha e código, avisa, e o cartão volta a oferecer "Ativar" (com o foco)', async () => {
    const user = userEvent.setup();
    const dialog = await openModal(user, 'Desativar');
    expect(dialog).toHaveAccessibleName('Desativar a verificação em duas etapas');
    expect(dialog).toHaveTextContent('Sem ela, só a senha protege sua conta.');
    api.mfaDisable.mockResolvedValue(undefined);
    api.mfaStatus.mockResolvedValue(statusOf());

    await user.type(within(dialog).getByLabelText('Senha atual'), 'senha-1');
    await user.type(within(dialog).getByLabelText('Código do app ou de recuperação'), '123 456');
    await user.click(within(dialog).getByRole('button', { name: 'Desativar' }));

    expect(
      await toast('Verificação em duas etapas desativada. Você recebe um aviso por e-mail.'),
    ).toBeInTheDocument();
    expect(api.mfaDisable).toHaveBeenCalledWith({ password: 'senha-1', code: '123456' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ativar' })).toHaveFocus());
  });

  it('desativada em outro lugar (outra aba, atendimento): avisa, fecha e o cartão relido mostra', async () => {
    const user = userEvent.setup();
    const dialog = await openModal(user, 'Gerar novos códigos');
    api.mfaRecoveryCodes.mockRejectedValue(
      apiError('A verificação em duas etapas não está ativa.', 'mfa_not_enabled'),
    );
    api.mfaStatus.mockResolvedValue(statusOf());

    await user.type(within(dialog).getByLabelText('Senha atual'), 'senha-1');
    await user.type(within(dialog).getByLabelText('Código do app ou de recuperação'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Gerar códigos' }));

    expect(await toast('A verificação em duas etapas não está ativa.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Ativar' })).toBeInTheDocument();
  });

  it('fechar o diálogo sem confirmar não muda nada (e relê a situação)', async () => {
    const user = userEvent.setup();
    const dialog = await openModal(user, 'Desativar');

    await user.click(within(dialog).getByRole('button', { name: 'Fechar' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.mfaDisable).not.toHaveBeenCalled();
    expect(screen.getByTestId('mfa-ativa')).toBeInTheDocument();
    await waitFor(() => expect(api.mfaStatus).toHaveBeenCalledTimes(2));
  });
});
