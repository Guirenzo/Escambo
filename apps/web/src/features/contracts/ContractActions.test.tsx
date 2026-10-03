import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Contract, ContractStatus } from '@escambo/types';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ToastProvider } from '../../lib/toast';
import { ContractActions } from './ContractActions';

/**
 * Os botões de uma contratação (tabela do Início e Sala): cada um só aparece para o papel e o
 * estado em que a API aceita a ação, e manda para a API exatamente o que a pessoa confirmou.
 */

const contractAction = vi.fn();
const deliverContract = vi.fn();
const requestRevision = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    contractAction: (id: number, action: string) => contractAction(id, action),
    deliverContract: (id: number, message: string) => deliverContract(id, message),
    requestRevision: (id: number, note: string) => requestRevision(id, note),
  },
}));

const CLIENT = 1;
const FREELANCER = 2;
const auth: { user: { id: number } | null } = { user: { id: CLIENT } };
vi.mock('../../lib/auth', () => ({ useAuth: () => auth }));

/** Onde o app está: os botões que só existem na Sala levam para /contratos/:id. */
function Where() {
  const { pathname } = useLocation();
  return <p>rota: {pathname}</p>;
}

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/inicio']}>
          {ui}
          <Where />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

const contract = (status: ContractStatus, o: Partial<Contract> = {}): Contract =>
  ({
    id: 7,
    clientId: CLIENT,
    freelancerId: FREELANCER,
    title: 'Vídeo',
    status,
    hasReview: false,
    hasMilestones: false,
    deadlineAt: null,
    ...o,
  }) as Contract;

/** Os botões na ordem em que aparecem, pelo nome acessível. */
const buttons = (): string[] =>
  screen.queryAllByRole('button').map((b) => (b.textContent ?? '').trim());

const as = (id: number | null): void => {
  auth.user = id === null ? null : { id };
};

let prompt: MockInstance<typeof window.prompt>;

beforeEach(() => {
  contractAction.mockReset();
  contractAction.mockResolvedValue({});
  deliverContract.mockReset();
  deliverContract.mockResolvedValue({});
  requestRevision.mockReset();
  requestRevision.mockResolvedValue({});
  as(CLIENT);
  prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);
});
afterEach(() => prompt.mockRestore());

describe('ContractActions: quem vê qual botão', () => {
  it.each<[string, ContractStatus, Partial<Contract>, number, string[]]>([
    ['proposta, freelancer', 'pending', {}, FREELANCER, ['Aceitar', 'Recusar']],
    ['proposta, cliente', 'pending', {}, CLIENT, ['Cancelar proposta']],
    [
      'em andamento, freelancer',
      'accepted',
      {},
      FREELANCER,
      ['Registrar entrega', 'Desistir', 'Abrir disputa'],
    ],
    ['em andamento, cliente', 'in_progress', {}, CLIENT, ['Cancelar', 'Abrir disputa']],
    [
      'por marcos, freelancer (a entrega é marco a marco)',
      'accepted',
      { hasMilestones: true },
      FREELANCER,
      ['Desistir', 'Abrir disputa'],
    ],
    [
      'entregue, cliente',
      'delivered',
      {},
      CLIENT,
      ['Aprovar entrega', 'Pedir revisão', 'Abrir disputa'],
    ],
    ['entregue, freelancer', 'delivered', {}, FREELANCER, ['Abrir disputa']],
    [
      'em revisão, freelancer',
      'revision_requested',
      {},
      FREELANCER,
      ['Entregar revisão', 'Abrir disputa'],
    ],
    ['em revisão, cliente', 'revision_requested', {}, CLIENT, ['Abrir disputa']],
    ['concluída sem avaliação, cliente', 'completed', {}, CLIENT, ['Avaliar']],
  ])('%s', (_name, status, extra, userId, expected) => {
    as(userId);
    render(wrap(<ContractActions contract={contract(status, extra)} />));
    expect(buttons()).toEqual(expected);
  });

  it.each<[string, ContractStatus, Partial<Contract>, number | null]>([
    ['concluída já avaliada, cliente', 'completed', { hasReview: true }, CLIENT],
    ['concluída, freelancer', 'completed', {}, FREELANCER],
    ['cancelada, cliente', 'cancelled', {}, CLIENT],
    ['em disputa, freelancer', 'disputed', {}, FREELANCER],
    ['quem não é parte da contratação', 'accepted', {}, 99],
    ['sem sessão', 'accepted', {}, null],
  ])('nenhum botão: %s', (_name, status, extra, userId) => {
    as(userId);
    render(wrap(<ContractActions contract={contract(status, extra)} />));
    expect(buttons()).toEqual([]);
  });

  it('proposta com o prazo de entrega já vencido: o freelancer só pode recusar', () => {
    as(FREELANCER);
    render(
      wrap(
        <ContractActions contract={contract('pending', { deadlineAt: '2020-01-01T00:00:00Z' })} />,
      ),
    );
    expect(buttons()).toEqual(['Recusar']);
  });

  it('"exclude" tira da lista as ações que a tela já oferece em outro lugar', () => {
    as(FREELANCER);
    render(
      wrap(<ContractActions contract={contract('accepted')} exclude={['cancel', 'dispute']} />),
    );
    expect(buttons()).toEqual(['Registrar entrega']);
  });

  it('na tabela (tamanho mini) os botões são compactos e a ação de perigo continua marcada', () => {
    as(FREELANCER);
    const { unmount } = render(
      wrap(<ContractActions contract={contract('pending')} size="mini" />),
    );
    expect(buttons()).toEqual(['Aceitar', 'Recusar']);
    expect(screen.getByRole('button', { name: 'Aceitar' })).toHaveClass('mini');
    expect(screen.getByRole('button', { name: 'Aceitar' })).not.toHaveClass('danger');
    expect(screen.getByRole('button', { name: 'Recusar' })).toHaveClass('mini', 'danger');
    unmount();
    // Na Sala (tamanho normal) o botão de perigo é a própria variante, sem o compacto.
    render(wrap(<ContractActions contract={contract('pending')} />));
    expect(screen.getByRole('button', { name: 'Recusar' })).toHaveClass('danger');
    expect(screen.getByRole('button', { name: 'Recusar' })).not.toHaveClass('mini');
  });

  it('com todas as ações excluídas, não sobra botão nenhum', () => {
    render(
      wrap(<ContractActions contract={contract('accepted')} exclude={['cancel', 'dispute']} />),
    );
    expect(buttons()).toEqual([]);
  });
});

describe('ContractActions: o que cada botão manda para a API', () => {
  it('Aceitar manda "accept" da contratação e avisa que atualizou', async () => {
    const user = userEvent.setup();
    as(FREELANCER);
    render(wrap(<ContractActions contract={contract('pending')} />));
    await user.click(screen.getByRole('button', { name: 'Aceitar' }));
    expect(contractAction).toHaveBeenCalledTimes(1);
    expect(contractAction).toHaveBeenCalledWith(7, 'accept');
    expect(await screen.findByText('Contratação atualizada')).toBeInTheDocument();
    expect(prompt).not.toHaveBeenCalled();
  });

  it('Recusar manda "reject"', async () => {
    const user = userEvent.setup();
    as(FREELANCER);
    render(wrap(<ContractActions contract={contract('pending')} />));
    await user.click(screen.getByRole('button', { name: 'Recusar' }));
    expect(contractAction).toHaveBeenCalledWith(7, 'reject');
    expect(await screen.findByText('Contratação atualizada')).toBeInTheDocument();
  });

  it('Aprovar entrega manda "approve" e diz que o valor foi liberado', async () => {
    const user = userEvent.setup();
    render(wrap(<ContractActions contract={contract('delivered')} />));
    await user.click(screen.getByRole('button', { name: 'Aprovar entrega' }));
    expect(contractAction).toHaveBeenCalledWith(7, 'approve');
    expect(
      await screen.findByText('Entrega aprovada. Valor liberado para o freelancer.'),
    ).toBeInTheDocument();
    expect(requestRevision).not.toHaveBeenCalled();
  });

  it('Pedir revisão pergunta o que ajustar e manda o texto sem espaços nas pontas', async () => {
    const user = userEvent.setup();
    prompt.mockReturnValue('  Trocar a trilha  ');
    render(wrap(<ContractActions contract={contract('delivered')} />));
    await user.click(screen.getByRole('button', { name: 'Pedir revisão' }));
    expect(prompt).toHaveBeenCalledWith('O que precisa ser ajustado?');
    expect(requestRevision).toHaveBeenCalledTimes(1);
    expect(requestRevision).toHaveBeenCalledWith(7, 'Trocar a trilha');
    expect(
      await screen.findByText('Revisão solicitada. O freelancer foi avisado.'),
    ).toBeInTheDocument();
    expect(contractAction).not.toHaveBeenCalled();
  });

  it('Registrar entrega pergunta a mensagem da entrega e manda o que foi escrito', async () => {
    const user = userEvent.setup();
    as(FREELANCER);
    prompt.mockReturnValue('Vídeo final no Drive');
    render(wrap(<ContractActions contract={contract('in_progress')} />));
    await user.click(screen.getByRole('button', { name: 'Registrar entrega' }));
    expect(prompt).toHaveBeenCalledWith('Mensagem da entrega (o que foi feito, onde está):');
    expect(deliverContract).toHaveBeenCalledTimes(1);
    expect(deliverContract).toHaveBeenCalledWith(7, 'Vídeo final no Drive');
    expect(await screen.findByText('Contratação atualizada')).toBeInTheDocument();
  });

  it('Entregar revisão usa a mesma entrega, com a mensagem nova', async () => {
    const user = userEvent.setup();
    as(FREELANCER);
    prompt.mockReturnValue('Trilha trocada');
    render(wrap(<ContractActions contract={contract('revision_requested')} />));
    await user.click(screen.getByRole('button', { name: 'Entregar revisão' }));
    expect(deliverContract).toHaveBeenCalledWith(7, 'Trilha trocada');
  });

  it.each<[string, string | null]>([
    ['cancelada', null],
    ['só com espaços', '   '],
  ])('pergunta %s: nada vai para a API e nenhum aviso aparece', async (_name, answer) => {
    const user = userEvent.setup();
    as(FREELANCER);
    prompt.mockReturnValue(answer);
    render(wrap(<ContractActions contract={contract('accepted')} />));
    await user.click(screen.getByRole('button', { name: 'Registrar entrega' }));
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(deliverContract).not.toHaveBeenCalled();
    expect(screen.queryByText('Contratação atualizada')).toBeNull();
    expect(screen.getByRole('button', { name: 'Registrar entrega' })).toBeEnabled();
  });

  it('a API recusa: o aviso é a mensagem dela, sem o aviso de sucesso', async () => {
    const user = userEvent.setup();
    as(FREELANCER);
    contractAction.mockRejectedValue(new Error('Saldo do cliente insuficiente'));
    render(wrap(<ContractActions contract={contract('pending')} />));
    await user.click(screen.getByRole('button', { name: 'Aceitar' }));
    expect(await screen.findByText('Saldo do cliente insuficiente')).toBeInTheDocument();
    expect(screen.queryByText('Contratação atualizada')).toBeNull();
  });

  it('falha sem mensagem: o aviso é "Erro na ação"', async () => {
    const user = userEvent.setup();
    contractAction.mockRejectedValue('offline');
    render(wrap(<ContractActions contract={contract('delivered')} />));
    await user.click(screen.getByRole('button', { name: 'Aprovar entrega' }));
    expect(await screen.findByText('Erro na ação')).toBeInTheDocument();
  });

  it('enquanto a ação está em curso, todos os botões ficam desabilitados', async () => {
    const user = userEvent.setup();
    as(FREELANCER);
    let release!: (v: unknown) => void;
    contractAction.mockReturnValue(new Promise((r) => (release = r)));
    render(wrap(<ContractActions contract={contract('pending')} />));
    const accept = screen.getByRole('button', { name: 'Aceitar' });
    const reject = screen.getByRole('button', { name: 'Recusar' });
    await user.click(accept);
    await waitFor(() => expect(accept).toBeDisabled());
    expect(reject).toBeDisabled();
    release({});
    await waitFor(() => expect(accept).toBeEnabled());
    expect(reject).toBeEnabled();
    expect(contractAction).toHaveBeenCalledTimes(1);
  });

  it('enquanto a entrega é registrada, os botões travam e o aviso só sai quando a API responde', async () => {
    const user = userEvent.setup();
    as(FREELANCER);
    prompt.mockReturnValue('Vídeo final no Drive');
    let release!: (v: unknown) => void;
    deliverContract.mockReturnValue(new Promise((r) => (release = r)));
    render(wrap(<ContractActions contract={contract('accepted')} />));
    const deliver = screen.getByRole('button', { name: 'Registrar entrega' });
    await user.click(deliver);
    await waitFor(() => expect(deliver).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Desistir' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Abrir disputa' })).toBeDisabled();
    expect(screen.queryByText('Contratação atualizada')).toBeNull();
    release({});
    expect(await screen.findByText('Contratação atualizada')).toBeInTheDocument();
    await waitFor(() => expect(deliver).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Desistir' })).toBeEnabled();
    expect(deliverContract).toHaveBeenCalledTimes(1);
  });

  it('enquanto o pedido de revisão é enviado, aprovar, revisar e disputar ficam desabilitados', async () => {
    const user = userEvent.setup();
    prompt.mockReturnValue('Trocar a trilha');
    let release!: (v: unknown) => void;
    requestRevision.mockReturnValue(new Promise((r) => (release = r)));
    render(wrap(<ContractActions contract={contract('delivered')} />));
    const revision = screen.getByRole('button', { name: 'Pedir revisão' });
    await user.click(revision);
    await waitFor(() => expect(revision).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Aprovar entrega' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Abrir disputa' })).toBeDisabled();
    expect(screen.queryByText('Revisão solicitada. O freelancer foi avisado.')).toBeNull();
    release({});
    expect(
      await screen.findByText('Revisão solicitada. O freelancer foi avisado.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(revision).toBeEnabled());
    expect(requestRevision).toHaveBeenCalledTimes(1);
  });

  it.each<[string, ContractStatus, number, string, () => typeof deliverContract]>([
    ['a entrega', 'accepted', FREELANCER, 'Registrar entrega', () => deliverContract],
    ['o pedido de revisão', 'delivered', CLIENT, 'Pedir revisão', () => requestRevision],
  ])(
    'a API recusa %s: o aviso é a mensagem dela, sem aviso de sucesso, e o botão volta a aceitar clique',
    async (_name, status, userId, label, mock) => {
      const user = userEvent.setup();
      as(userId);
      prompt.mockReturnValue('Texto qualquer');
      mock().mockRejectedValue(new Error('A contratação mudou de situação'));
      render(wrap(<ContractActions contract={contract(status)} />));
      await user.click(screen.getByRole('button', { name: label }));
      expect(await screen.findByText('A contratação mudou de situação')).toBeInTheDocument();
      expect(mock()).toHaveBeenCalledWith(7, 'Texto qualquer');
      expect(screen.queryByText('Contratação atualizada')).toBeNull();
      expect(screen.queryByText('Revisão solicitada. O freelancer foi avisado.')).toBeNull();
      await waitFor(() => expect(screen.getByRole('button', { name: label })).toBeEnabled());
    },
  );

  it('Pedir revisão com a pergunta cancelada não manda nada nem avisa', async () => {
    const user = userEvent.setup();
    prompt.mockReturnValue(null);
    render(wrap(<ContractActions contract={contract('delivered')} />));
    await user.click(screen.getByRole('button', { name: 'Pedir revisão' }));
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(requestRevision).not.toHaveBeenCalled();
    expect(contractAction).not.toHaveBeenCalled();
    expect(screen.queryByText('Revisão solicitada. O freelancer foi avisado.')).toBeNull();
  });
});

describe('ContractActions: o que acontece só na Sala', () => {
  it('Avaliar leva para a Sala da contratação, sem chamar a API', async () => {
    const user = userEvent.setup();
    render(wrap(<ContractActions contract={contract('completed')} />));
    expect(screen.getByText('rota: /inicio')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Avaliar' }));
    expect(screen.getByText('rota: /contratos/7')).toBeInTheDocument();
    expect(contractAction).not.toHaveBeenCalled();
    // Ir para a Sala não é uma ação concluída: sem pergunta e sem aviso de "atualizada".
    expect(prompt).not.toHaveBeenCalled();
    expect(screen.queryByText('Contratação atualizada')).toBeNull();
  });

  it('Abrir disputa fora da Sala leva para ela; na Sala, abre o que a Sala passou', async () => {
    const user = userEvent.setup();
    const { unmount } = render(wrap(<ContractActions contract={contract('delivered')} />));
    await user.click(screen.getByRole('button', { name: 'Abrir disputa' }));
    expect(screen.getByText('rota: /contratos/7')).toBeInTheDocument();
    expect(screen.queryByText('Contratação atualizada')).toBeNull();
    unmount();

    const onDispute = vi.fn();
    render(wrap(<ContractActions contract={contract('delivered')} onDispute={onDispute} />));
    await user.click(screen.getByRole('button', { name: 'Abrir disputa' }));
    expect(onDispute).toHaveBeenCalledTimes(1);
    expect(screen.getByText('rota: /inicio')).toBeInTheDocument();
    expect(contractAction).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(screen.queryByText('Contratação atualizada')).toBeNull();
  });

  it('Cancelar nunca cancela direto: fora da Sala leva para ela; na Sala, abre o modal com o valor', async () => {
    const user = userEvent.setup();
    const { unmount } = render(wrap(<ContractActions contract={contract('accepted')} />));
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.getByText('rota: /contratos/7')).toBeInTheDocument();
    expect(screen.queryByText('Contratação atualizada')).toBeNull();
    unmount();

    const onCancel = vi.fn();
    as(FREELANCER);
    render(wrap(<ContractActions contract={contract('accepted')} onCancel={onCancel} />));
    await user.click(screen.getByRole('button', { name: 'Desistir' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByText('rota: /inicio')).toBeInTheDocument();
    expect(contractAction).not.toHaveBeenCalled();
    expect(deliverContract).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(screen.queryByText('Contratação atualizada')).toBeNull();
  });

  it('Cancelar proposta (cliente, antes do aceite) também passa pela Sala, sem mandar nada à API', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(wrap(<ContractActions contract={contract('pending')} onCancel={onCancel} />));
    await user.click(screen.getByRole('button', { name: 'Cancelar proposta' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(contractAction).not.toHaveBeenCalled();
    expect(screen.getByText('rota: /inicio')).toBeInTheDocument();
  });
});
