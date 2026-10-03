import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Deposit } from '@escambo/types';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWallet } from '../../lib/hooks';
import { ToastProvider } from '../../lib/toast';
import { DepositModal } from './DepositModal';

const createDeposit = vi.fn();
const depositStatus = vi.fn();
const simulateDeposit = vi.fn();
const wallet = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    createDeposit: (body: unknown) => createDeposit(body),
    deposit: (id: number) => depositStatus(id),
    simulateDeposit: (id: number) => simulateDeposit(id),
    wallet: () => wallet(),
  },
}));

/** O desenho do QR Code é da biblioteca (e o jsdom não tem canvas): aqui só importa o que ela recebe. */
const toCanvas = vi.fn();
vi.mock('qrcode', () => ({
  default: { toCanvas: (...args: unknown[]) => toCanvas(...args) },
}));

const PIX_CODE = '00020126580014br.gov.bcb.pix0136escambo-dep-42';

const deposit = (o: Partial<Deposit> = {}): Deposit => ({
  id: 42,
  amount: 100,
  status: 'pending',
  method: 'pix',
  gateway: 'mock',
  reference: 'DEP-42',
  pixCode: PIX_CODE,
  expiresAt: null,
  paidAt: null,
  createdAt: '2026-10-01T15:00:00.000Z',
  canSimulate: false,
  ...o,
});

const walletWith = (balance: number) => ({
  balance,
  balancePending: 0,
  currency: 'BRL',
  credits: 0,
  creditsPending: 0,
});

/** Uma tela qualquer que mostra o saldo: serve para ver que o depósito confirmado recarrega a carteira. */
function WalletProbe() {
  const w = useWallet();
  return <p>Saldo na carteira: {w.data ? w.data.balance : '…'}</p>;
}

type Props = ComponentProps<typeof DepositModal>;

function renderModal(props: Partial<Props> = {}) {
  const onClose = vi.fn();
  const onPaid = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <WalletProbe />
        <DepositModal onClose={onClose} onPaid={onPaid} {...props} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onClose, onPaid };
}

const amountField = () => screen.getByLabelText('Valor (R$)');
const generateButton = () => screen.getByRole('button', { name: /Gerar cobrança PIX de/ });

beforeEach(() => {
  createDeposit.mockReset();
  createDeposit.mockResolvedValue(deposit());
  depositStatus.mockReset();
  depositStatus.mockResolvedValue(deposit());
  simulateDeposit.mockReset();
  simulateDeposit.mockResolvedValue(
    deposit({ status: 'paid', paidAt: '2026-10-01T15:05:00.000Z' }),
  );
  wallet.mockReset();
  wallet.mockResolvedValue(walletWith(0));
  toCanvas.mockReset();
  toCanvas.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Depósito via PIX, passo 1: escolher o valor. */
describe('DepositModal: escolher o valor', () => {
  it('abre pedindo o valor, com R$ 100 de partida e os quatro atalhos', () => {
    renderModal();

    expect(screen.getByRole('dialog', { name: 'Depositar na carteira' })).toBeInTheDocument();
    expect(amountField()).toHaveValue(100);
    const presets = within(screen.getByRole('group', { name: 'Valores sugeridos' })).getAllByRole(
      'button',
    );
    // O "R$" vem com espaço duro; a troca deixa um espaço comum para comparar.
    expect(presets.map((b) => b.textContent?.replace(/\s/g, ' '))).toEqual([
      'R$ 50,00',
      'R$ 100,00',
      'R$ 200,00',
      'R$ 500,00',
    ]);
    expect(generateButton()).toHaveTextContent('Gerar cobrança PIX de R$ 100,00');
    expect(generateButton()).toBeEnabled();
    expect(createDeposit).not.toHaveBeenCalled();
  });

  it('o atalho troca o valor, o botão acompanha e a cobrança sai com esse valor em PIX', async () => {
    const user = userEvent.setup();
    createDeposit.mockResolvedValue(deposit({ amount: 200 }));
    renderModal();

    await user.click(screen.getByRole('button', { name: /^R\$\s200,00$/ }));
    expect(amountField()).toHaveValue(200);
    expect(generateButton()).toHaveTextContent('Gerar cobrança PIX de R$ 200,00');
    await user.click(generateButton());

    expect(createDeposit).toHaveBeenCalledTimes(1);
    expect(createDeposit).toHaveBeenCalledWith({ amount: 200, method: 'pix' });
  });

  it('valor digitado com centavos vai como número', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.clear(amountField());
    await user.type(amountField(), '75.5');
    expect(generateButton()).toHaveTextContent('Gerar cobrança PIX de R$ 75,50');
    await user.click(generateButton());

    expect(createDeposit).toHaveBeenCalledWith({ amount: 75.5, method: 'pix' });
  });

  it('abaixo do mínimo de R$ 10 (ou sem valor) não dá para gerar', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.clear(amountField());
    expect(generateButton()).toHaveTextContent('Gerar cobrança PIX de R$ 0,00');
    expect(generateButton()).toBeDisabled();

    await user.type(amountField(), '9.99');
    expect(generateButton()).toBeDisabled();
    await user.click(generateButton());
    expect(createDeposit).not.toHaveBeenCalled();

    await user.clear(amountField());
    await user.type(amountField(), '10');
    expect(generateButton()).toBeEnabled();
  });

  it('valor sugerido (o que falta numa contratação) vem arredondado para cima', () => {
    renderModal({ suggestedAmount: 150.5 });

    expect(amountField()).toHaveValue(151);
    expect(generateButton()).toHaveTextContent('Gerar cobrança PIX de R$ 151,00');
  });

  it('valor sugerido menor que o mínimo sobe para R$ 10', () => {
    renderModal({ suggestedAmount: 3.2 });

    expect(amountField()).toHaveValue(10);
    expect(generateButton()).toBeEnabled();
  });

  it('enquanto a cobrança é gerada o botão fica travado em "Gerando…"', async () => {
    const user = userEvent.setup();
    let release!: (d: Deposit) => void;
    createDeposit.mockImplementation(() => new Promise<Deposit>((r) => (release = r)));
    renderModal();

    await user.click(generateButton());
    expect(await screen.findByRole('button', { name: 'Gerando…' })).toBeDisabled();

    release(deposit());
    expect(await screen.findByLabelText('PIX copia e cola')).toBeInTheDocument();
  });

  it('API recusa a cobrança: mostra a mensagem dela e o formulário continua', async () => {
    const user = userEvent.setup();
    createDeposit.mockRejectedValue(new Error('Valor máximo por depósito: R$ 50.000,00.'));
    renderModal();

    await user.click(generateButton());

    expect(await screen.findByText('Valor máximo por depósito: R$ 50.000,00.')).toBeInTheDocument();
    expect(amountField()).toHaveValue(100);
    expect(generateButton()).toBeEnabled();
    expect(screen.queryByLabelText('PIX copia e cola')).not.toBeInTheDocument();
  });

  it('falha sem mensagem vira "Erro ao gerar a cobrança"', async () => {
    const user = userEvent.setup();
    createDeposit.mockRejectedValue('offline');
    renderModal();

    await user.click(generateButton());

    expect(await screen.findByText('Erro ao gerar a cobrança')).toBeInTheDocument();
  });

  it('o ✕ fecha sem gerar cobrança', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();

    await user.click(screen.getByRole('button', { name: 'Fechar' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(createDeposit).not.toHaveBeenCalled();
  });
});

/** Passo 2: a cobrança pendente, com QR Code e copia e cola, esperando o pagamento. */
describe('DepositModal: cobrança pendente', () => {
  it('gerada a cobrança, mostra o valor, o copia e cola e desenha o QR Code com o mesmo código', async () => {
    const user = userEvent.setup();
    const { onPaid } = renderModal();

    await user.click(generateButton());

    const code = await screen.findByLabelText('PIX copia e cola');
    expect(code).toHaveValue(PIX_CODE);
    expect(code).toHaveAttribute('readonly');
    expect(screen.getByText('R$ 100,00')).toBeInTheDocument();
    expect(screen.getByText('Cobrança PIX · ref. DEP-42')).toBeInTheDocument();
    expect(
      screen.getByText('Aguardando a confirmação do pagamento… esta tela atualiza sozinha.'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Valor (R$)')).not.toBeInTheDocument();
    expect(toCanvas).toHaveBeenCalledWith(
      screen.getByRole('img', { name: 'QR Code do PIX' }),
      PIX_CODE,
      { width: 176, margin: 1, color: { dark: '#0f1a14', light: '#ffffff' } },
    );
    // A situação da cobrança recém-criada passa a ser consultada na API.
    await waitFor(() => expect(depositStatus).toHaveBeenCalledWith(42));
    expect(onPaid).not.toHaveBeenCalled();
  });

  it('reabrir uma cobrança pendente vai direto para ela, sem gerar outra', async () => {
    renderModal({ initial: deposit({ amount: 250, reference: null }) });

    expect(screen.getByLabelText('PIX copia e cola')).toHaveValue(PIX_CODE);
    expect(screen.getByText('R$ 250,00')).toBeInTheDocument();
    // Sem validade nem referência, a linha fica só com "Cobrança PIX".
    expect(screen.getByText('Cobrança PIX')).toBeInTheDocument();
    expect(screen.queryByLabelText('Valor (R$)')).not.toBeInTheDocument();
    await waitFor(() => expect(depositStatus).toHaveBeenCalledWith(42));
    expect(createDeposit).not.toHaveBeenCalled();
  });

  it('se o QR Code não puder ser desenhado, o copia e cola continua na tela', async () => {
    toCanvas.mockImplementation(() => {
      throw new Error('sem canvas');
    });
    renderModal({ initial: deposit() });

    expect(screen.getByLabelText('PIX copia e cola')).toHaveValue(PIX_CODE);
    expect(screen.getByRole('button', { name: 'Copiar código' })).toBeEnabled();
    await waitFor(() => expect(depositStatus).toHaveBeenCalledWith(42));
  });

  it('QR Code que falha depois de começar a desenhar também não derruba a cobrança', async () => {
    // Sem tratamento, a promessa rejeitada viraria erro não tratado e derrubaria a suíte.
    toCanvas.mockRejectedValue(new Error('código longo demais'));
    renderModal({ initial: deposit() });

    await waitFor(() => expect(toCanvas).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(depositStatus).toHaveBeenCalledWith(42));
    expect(screen.getByLabelText('PIX copia e cola')).toHaveValue(PIX_CODE);
    expect(screen.getByText('R$ 100,00')).toBeInTheDocument();
  });

  it('a validade aparece em minutos e o relógio da tela anda sozinho', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T15:00:00.000Z'));
    const pending = deposit({ expiresAt: '2026-10-01T15:10:00.000Z' });
    depositStatus.mockResolvedValue(pending);
    renderModal({ initial: pending });

    expect(screen.getByText('Vence em 10 min · ref. DEP-42')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000 + 30_000);
    });
    expect(screen.getByText('Vence em 6 min · ref. DEP-42')).toBeInTheDocument();

    // Passada a validade, o contador para no zero (não fica negativo).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(screen.getByText('Vence em 0 min · ref. DEP-42')).toBeInTheDocument();
  });

  it('"Copiar código" põe o copia e cola na área de transferência e avisa', async () => {
    const user = userEvent.setup();
    renderModal({ initial: deposit() });

    await user.click(screen.getByRole('button', { name: 'Copiar código' }));

    expect(await screen.findByText('Código PIX copiado')).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe(PIX_CODE);
  });

  it('navegador que não deixa copiar: orienta a copiar na mão', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('NotAllowedError'));
    renderModal({ initial: deposit() });

    await user.click(screen.getByRole('button', { name: 'Copiar código' }));

    expect(await screen.findByText('Selecione o código e copie manualmente')).toBeInTheDocument();
    expect(screen.queryByText('Código PIX copiado')).not.toBeInTheDocument();
  });

  it('cobrança ainda sem código: não desenha QR Code e "Copiar código" não copia nem avisa nada', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    const noCode = deposit({ pixCode: null });
    depositStatus.mockResolvedValue(noCode);
    renderModal({ initial: noCode });
    await waitFor(() => expect(depositStatus).toHaveBeenCalledWith(42));

    expect(screen.getByLabelText('PIX copia e cola')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Copiar código' }));

    expect(writeText).not.toHaveBeenCalled();
    expect(toCanvas).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('ao receber o foco, o copia e cola seleciona o código inteiro', async () => {
    const user = userEvent.setup();
    renderModal({ initial: deposit() });

    const code = screen.getByLabelText<HTMLTextAreaElement>('PIX copia e cola');
    await user.tab(); // ✕
    await user.tab(); // copia e cola
    expect(code).toHaveFocus();
    expect(code.selectionStart).toBe(0);
    expect(code.selectionEnd).toBe(PIX_CODE.length);
  });

  it('fora da demonstração não existe "Simular pagamento"', () => {
    renderModal({ initial: deposit({ canSimulate: false }) });

    expect(screen.queryByRole('button', { name: 'Simular pagamento' })).not.toBeInTheDocument();
    expect(screen.queryByText('Ambiente de demonstração')).not.toBeInTheDocument();
  });

  it('a consulta automática vê o pagamento: confirma na tela, recarrega a carteira e avisa uma vez só', async () => {
    vi.useFakeTimers();
    const pending = deposit();
    const paid = deposit({ status: 'paid', paidAt: '2026-10-01T15:05:00.000Z' });
    depositStatus.mockResolvedValueOnce(pending).mockResolvedValue(paid);
    wallet.mockResolvedValueOnce(walletWith(0)).mockResolvedValue(walletWith(100));
    const { onPaid } = renderModal({ initial: pending });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByLabelText('PIX copia e cola')).toBeInTheDocument();
    expect(screen.getByText('Saldo na carteira: 0')).toBeInTheDocument();
    expect(onPaid).not.toHaveBeenCalled();

    // A cada 3 s a tela pergunta de novo; a segunda resposta já vem paga.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(depositStatus).toHaveBeenCalledTimes(2);
    expect(depositStatus).toHaveBeenLastCalledWith(42);
    expect(
      screen.getByRole('heading', { name: /Depósito de R\$\s100,00 confirmado/ }),
    ).toBeVisible();
    expect(screen.queryByLabelText('PIX copia e cola')).not.toBeInTheDocument();
    expect(onPaid).toHaveBeenCalledTimes(1);
    expect(onPaid).toHaveBeenCalledWith(paid);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByText('Saldo na carteira: 100')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(onPaid).toHaveBeenCalledTimes(1);
  });

  // Defeito de produção (DepositModal.tsx, useDeposit(..., deposit?.status === 'pending')): o
  // "continuar consultando" olha a cobrança guardada no estado, que só muda ao gerar ou simular;
  // quando é a consulta automática que vê o pagamento (ou a falha), a tela segue perguntando à API
  // a cada 3 s enquanto ficar aberta.
  it.todo(
    'depois que a consulta automática vê a cobrança paga ou falhada, para de consultar a API',
  );
});

/** Ambiente de demonstração: o gateway é simulado e a própria pessoa confirma o pagamento. */
describe('DepositModal: simular o pagamento', () => {
  const demo = () => deposit({ canSimulate: true });

  it('"Simular pagamento" confirma a cobrança certa, mostra o depósito confirmado e recarrega a carteira', async () => {
    const user = userEvent.setup();
    const paid = deposit({ status: 'paid', canSimulate: true, paidAt: '2026-10-01T15:05:00.000Z' });
    simulateDeposit.mockResolvedValue(paid);
    depositStatus.mockResolvedValue(demo());
    wallet.mockResolvedValueOnce(walletWith(20)).mockResolvedValue(walletWith(120));
    const { onPaid, onClose } = renderModal({ initial: demo() });
    expect(await screen.findByText('Saldo na carteira: 20')).toBeInTheDocument();
    expect(screen.getByText('Ambiente de demonstração')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Simular pagamento' }));

    expect(simulateDeposit).toHaveBeenCalledTimes(1);
    expect(simulateDeposit).toHaveBeenCalledWith(42);
    expect(
      await screen.findByRole('heading', { name: /^Depósito de R\$\s100,00 confirmado$/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('O saldo já está disponível na sua carteira.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Depósito de R$ 100,00 confirmado');
    expect(screen.queryByLabelText('PIX copia e cola')).not.toBeInTheDocument();
    expect(await screen.findByText('Saldo na carteira: 120')).toBeInTheDocument();
    expect(onPaid).toHaveBeenCalledTimes(1);
    expect(onPaid).toHaveBeenCalledWith(paid);

    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Concluir' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('enquanto confirma, o botão fica travado em "Confirmando…"', async () => {
    const user = userEvent.setup();
    let release!: (d: Deposit) => void;
    simulateDeposit.mockImplementation(() => new Promise<Deposit>((r) => (release = r)));
    depositStatus.mockResolvedValue(demo());
    renderModal({ initial: demo() });

    await user.click(screen.getByRole('button', { name: 'Simular pagamento' }));
    expect(await screen.findByRole('button', { name: 'Confirmando…' })).toBeDisabled();

    release(deposit({ status: 'paid', canSimulate: true }));
    expect(await screen.findByRole('button', { name: 'Concluir' })).toBeInTheDocument();
  });

  it('API recusa a simulação: mostra a mensagem e a cobrança continua pendente', async () => {
    const user = userEvent.setup();
    simulateDeposit.mockRejectedValue(new Error('Cobrança vencida.'));
    depositStatus.mockResolvedValue(demo());
    const { onPaid } = renderModal({ initial: demo() });

    await user.click(screen.getByRole('button', { name: 'Simular pagamento' }));

    expect(await screen.findByText('Cobrança vencida.')).toBeInTheDocument();
    expect(screen.getByLabelText('PIX copia e cola')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Simular pagamento' })).toBeEnabled();
    expect(onPaid).not.toHaveBeenCalled();
  });

  it('falha sem mensagem vira "Não foi possível confirmar"', async () => {
    const user = userEvent.setup();
    simulateDeposit.mockRejectedValue(null);
    depositStatus.mockResolvedValue(demo());
    renderModal({ initial: demo() });

    await user.click(screen.getByRole('button', { name: 'Simular pagamento' }));

    expect(await screen.findByText('Não foi possível confirmar')).toBeInTheDocument();
  });
});

/** Cobrança que não vale mais (falhou, venceu…): só resta gerar outra. */
describe('DepositModal: cobrança encerrada sem pagamento', () => {
  it('diz o que houve e "Gerar nova cobrança" volta ao formulário para gerar outra', async () => {
    const user = userEvent.setup();
    const failed = deposit({ status: 'failed' });
    depositStatus.mockResolvedValue(failed);
    const { onPaid } = renderModal({ initial: failed });

    expect(screen.getByText('Cobrança falhou. Gere uma nova para continuar.')).toBeInTheDocument();
    expect(screen.queryByLabelText('PIX copia e cola')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Concluir' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Gerar nova cobrança' }));
    expect(amountField()).toHaveValue(100);
    expect(screen.queryByText(/Gere uma nova para continuar/)).not.toBeInTheDocument();

    const fresh = deposit({ id: 43, reference: 'DEP-43', pixCode: 'NOVO-CODIGO-43' });
    createDeposit.mockResolvedValue(fresh);
    depositStatus.mockResolvedValue(fresh);
    await user.click(generateButton());

    expect(createDeposit).toHaveBeenCalledWith({ amount: 100, method: 'pix' });
    expect(await screen.findByLabelText('PIX copia e cola')).toHaveValue('NOVO-CODIGO-43');
    await waitFor(() => expect(depositStatus).toHaveBeenLastCalledWith(43));
    expect(onPaid).not.toHaveBeenCalled();
  });

  it('a consulta automática vê a cobrança falhar: troca o QR Code pelo aviso', async () => {
    vi.useFakeTimers();
    const pending = deposit();
    depositStatus.mockResolvedValueOnce(pending).mockResolvedValue(deposit({ status: 'failed' }));
    const { onPaid } = renderModal({ initial: pending });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });

    expect(screen.getByText('Cobrança falhou. Gere uma nova para continuar.')).toBeInTheDocument();
    expect(screen.queryByLabelText('PIX copia e cola')).not.toBeInTheDocument();
    expect(onPaid).not.toHaveBeenCalled();
  });
});
