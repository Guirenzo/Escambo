import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ContentRemoval, MyModeration, StrikeSummary } from '@escambo/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModeracaoCard } from './ModeracaoCard';
import { dtm } from '../../lib/format';
import { ToastProvider } from '../../lib/toast';

/**
 * Conteúdo removido pela moderação (ADR 41 e 44), como o dono vê: o que foi removido e por quê, a
 * reincidência que bloqueia o envio de imagens e a contestação, que só vai para a API com pelo
 * menos 20 caracteres de verdade. As datas saem pelo `dtm` do app (fuso de quem roda o teste).
 */

const myModeration = vi.fn();
const appealRemoval = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    myModeration: () => myModeration(),
    appealRemoval: (id: number, text: string) => appealRemoval(id, text),
  },
}));

const REMOVED_AT = '2026-09-20T15:00:00.000Z';
const DEADLINE = '2026-10-04T15:00:00.000Z';
const APPEALED_AT = '2026-09-22T12:30:00.000Z';
const DECIDED_AT = '2026-09-25T18:45:00.000Z';

const removal = (o: Partial<ContentRemoval> = {}): ContentRemoval => ({
  id: 5,
  targetType: 'avatar',
  label: 'Foto de perfil',
  excerpt: null,
  reason: 'offensive',
  note: null,
  removedAt: REMOVED_AT,
  status: 'removed',
  appealDeadline: DEADLINE,
  canAppeal: true,
  appealText: null,
  appealedAt: null,
  decidedAt: null,
  decisionNote: null,
  ...o,
});

const strikes = (o: Partial<StrikeSummary> = {}): StrikeSummary => ({
  strikes: 1,
  imageStrikes: 1,
  windowDays: 90,
  reviewThreshold: 3,
  uploadsBlockedUntil: null,
  ...o,
});

const moderation = (
  removals: ContentRemoval[],
  summary: Partial<StrikeSummary> = {},
): MyModeration => ({ removals, strikes: strikes(summary) });

function renderCard(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ModeracaoCard />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return client;
}

/** A linha de uma remoção, achada pelo rótulo do que foi removido. */
const row = (label: string): HTMLElement => screen.getByText(label).closest('li')!;

/** Abre o diálogo de contestação da única remoção contestável da tela. */
async function openAppeal(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: 'Contestar' }));
  return screen.getByRole('dialog', { name: 'Contestar remoção' });
}

const reasonBox = (): HTMLElement => screen.getByLabelText('Por que a remoção deve ser revertida');

type User = ReturnType<typeof userEvent.setup>;

/** Cola o texto no campo de uma vez: tecla a tecla, cada letra redesenha a tela e o teste arrasta. */
async function fill(user: User, field: HTMLElement, text: string): Promise<void> {
  await user.click(field);
  await user.paste(text);
}

beforeEach(() => {
  myModeration.mockReset();
  appealRemoval.mockReset();
  appealRemoval.mockResolvedValue(removal({ status: 'appealed', canAppeal: false }));
});

describe('cartão de moderação: quando aparece', () => {
  it('quem nunca teve conteúdo removido não vê o cartão', async () => {
    myModeration.mockResolvedValue(moderation([], { strikes: 0, imageStrikes: 0 }));
    const client = renderCard();

    await waitFor(() => expect(myModeration).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(screen.queryByRole('heading', { name: 'Moderação' })).not.toBeInTheDocument();
    expect(screen.queryByText(/remoç/)).not.toBeInTheDocument();
  });

  it('enquanto a consulta não volta, nada é mostrado; quando volta com remoção, o cartão aparece', async () => {
    let solta!: (v: MyModeration) => void;
    myModeration.mockReturnValue(new Promise<MyModeration>((r) => (solta = r)));
    renderCard();

    expect(screen.queryByRole('heading', { name: 'Moderação' })).not.toBeInTheDocument();
    expect(screen.queryByText(/remoç/)).not.toBeInTheDocument();

    solta(moderation([removal()]));
    expect(await screen.findByRole('heading', { name: 'Moderação' })).toBeInTheDocument();
    expect(screen.getByText('1 remoção')).toBeInTheDocument();
  });

  it('com uma remoção: mostra o que foi, quando, o motivo, a nota e o prazo para contestar', async () => {
    myModeration.mockResolvedValue(
      moderation([removal({ note: 'A imagem mostra dados pessoais de outra pessoa.' })]),
    );
    renderCard();

    expect(await screen.findByRole('heading', { name: 'Moderação' })).toBeInTheDocument();
    expect(screen.getByText('1 remoção')).toBeInTheDocument();
    const linha = row('Foto de perfil');
    expect(within(linha).getByText('Removida')).toBeInTheDocument();
    expect(
      within(linha).getByText(`Removida em ${dtm(REMOVED_AT)} · Conteúdo ofensivo`),
    ).toBeInTheDocument();
    expect(linha).toHaveTextContent(
      'Nota da moderaçãoA imagem mostra dados pessoais de outra pessoa.',
    );
    expect(
      within(linha).getByText(`Você pode contestar até ${dtm(DEADLINE)}.`),
    ).toBeInTheDocument();
    expect(within(linha).getByRole('button', { name: 'Contestar' })).toBeEnabled();
    // Imagem não tem texto removido, nem contestação ou decisão ainda.
    expect(linha).not.toHaveTextContent('Conteúdo removido');
    expect(linha).not.toHaveTextContent('Sua contestação');
    expect(linha).not.toHaveTextContent('Decisão');
  });

  it('com várias, o cabeçalho conta no plural e cada uma diz em que pé está', async () => {
    myModeration.mockResolvedValue(
      moderation(
        [
          removal({
            id: 1,
            targetType: 'review',
            label: 'Avaliação',
            excerpt: 'Péssimo, não contratem.',
            status: 'appealed',
            canAppeal: false,
            appealText: 'A avaliação conta o que aconteceu na entrega.',
            appealedAt: APPEALED_AT,
          }),
          removal({
            id: 2,
            targetType: 'portfolio_item',
            label: 'Imagem do trabalho “Logo”',
            status: 'overturned',
            canAppeal: false,
            decidedAt: DECIDED_AT,
            decisionNote: 'A imagem é do próprio autor.',
          }),
          removal({
            id: 3,
            targetType: 'message',
            label: 'Mensagem no chat',
            excerpt: 'me chama no zap',
            reason: 'off_platform',
            status: 'upheld',
            canAppeal: false,
            decidedAt: DECIDED_AT,
          }),
          removal({ id: 4, label: 'Foto de perfil', canAppeal: false }),
        ],
        { strikes: 3, imageStrikes: 1 },
      ),
    );
    renderCard();

    expect(await screen.findByText('4 remoções')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Contestar' })).not.toBeInTheDocument();

    const avaliacao = row('Avaliação');
    expect(within(avaliacao).getByText('Contestação em análise')).toBeInTheDocument();
    expect(avaliacao).toHaveTextContent('Conteúdo removidoPéssimo, não contratem.');
    expect(avaliacao).toHaveTextContent(
      'Sua contestaçãoA avaliação conta o que aconteceu na entrega.',
    );
    expect(
      within(avaliacao).getByText(
        `Contestação enviada em ${dtm(APPEALED_AT)}. A resposta chega por notificação e e-mail.`,
      ),
    ).toBeInTheDocument();

    const trabalho = row('Imagem do trabalho “Logo”');
    expect(within(trabalho).getByText('Remoção revertida')).toBeInTheDocument();
    expect(trabalho).toHaveTextContent('DecisãoA imagem é do próprio autor.');
    expect(
      within(trabalho).getByText(`Revertida em ${dtm(DECIDED_AT)}: não conta como remoção.`),
    ).toBeInTheDocument();

    const mensagem = row('Mensagem no chat');
    expect(within(mensagem).getByText('Remoção mantida')).toBeInTheDocument();
    expect(
      within(mensagem).getByText(
        `Removida em ${dtm(REMOVED_AT)} · Tenta negociar fora da plataforma`,
      ),
    ).toBeInTheDocument();
    expect(within(mensagem).getByText(`Mantida em ${dtm(DECIDED_AT)}.`)).toBeInTheDocument();

    const foto = row('Foto de perfil');
    expect(
      within(foto).getByText(`O prazo para contestar terminou em ${dtm(DEADLINE)}.`),
    ).toBeInTheDocument();
  });

  it('motivo que a tela não conhece aparece como veio, em vez de sumir', async () => {
    myModeration.mockResolvedValue(
      moderation([removal({ reason: 'direitos_autorais' as ContentRemoval['reason'] })]),
    );
    renderCard();

    expect(
      await screen.findByText(`Removida em ${dtm(REMOVED_AT)} · direitos_autorais`),
    ).toBeInTheDocument();
  });
});

describe('cartão de moderação: reincidência', () => {
  it('nenhuma remoção contando: diz que revertidas e antigas não contam, sem medidor', async () => {
    myModeration.mockResolvedValue(
      moderation([removal({ status: 'overturned', canAppeal: false, decidedAt: DECIDED_AT })], {
        strikes: 0,
        imageStrikes: 0,
      }),
    );
    renderCard();

    expect(
      await screen.findByText(
        'Nenhuma remoção conta contra você agora: remoções revertidas ou antigas não contam.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /remoções$/ })).not.toBeInTheDocument();
  });

  it('uma remoção contando: medidor 1 de 3 e a regra do bloqueio e da revisão', async () => {
    myModeration.mockResolvedValue(moderation([removal()]));
    renderCard();

    expect(await screen.findByRole('img', { name: '1 de 3 remoções' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Uma remoção conta nos últimos 90 dias. A partir da segunda imagem removida, o envio de imagens fica bloqueado por um tempo; com 3 remoções de qualquer conteúdo, a conta passa por revisão.',
      ),
    ).toBeInTheDocument();
  });

  it('mais de uma: conta no plural, com a janela e o limite que a API mandou', async () => {
    myModeration.mockResolvedValue(
      moderation([removal()], { strikes: 2, imageStrikes: 0, windowDays: 60, reviewThreshold: 5 }),
    );
    renderCard();

    expect(await screen.findByRole('img', { name: '2 de 5 remoções' })).toBeInTheDocument();
    expect(
      screen.getByText(
        '2 remoções contam nos últimos 60 dias. A partir da segunda imagem removida, o envio de imagens fica bloqueado por um tempo; com 5 remoções de qualquer conteúdo, a conta passa por revisão.',
      ),
    ).toBeInTheDocument();
  });

  it('envio bloqueado: diz até quando e quantas imagens levaram a isso', async () => {
    const until = '2026-10-09T03:00:00.000Z';
    myModeration.mockResolvedValue(
      moderation([removal()], { strikes: 2, imageStrikes: 2, uploadsBlockedUntil: until }),
    );
    renderCard();

    expect(
      await screen.findByText(`Envio de imagens bloqueado até ${dtm(until)}.`),
    ).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '2 de 3 remoções' })).toBeInTheDocument();
    expect(
      screen.getByText(/Com 2 imagens removidas nos últimos 90 dias, novos envios de imagem/),
    ).toHaveTextContent('ficam parados por um tempo que cresce a cada nova imagem removida.');
    expect(screen.queryByText(/a conta passa por revisão/)).not.toBeInTheDocument();
  });
});

describe('cartão de moderação: contestar', () => {
  it('o diálogo diz o que está sendo contestado, o motivo e o prazo', async () => {
    const user = userEvent.setup();
    myModeration.mockResolvedValue(moderation([removal()]));
    renderCard();

    const dialogo = await openAppeal(user);

    expect(within(dialogo).getByText('Foto de perfil')).toBeInTheDocument();
    expect(
      within(dialogo).getByText(`Conteúdo ofensivo · contestação até ${dtm(DEADLINE)}`),
    ).toBeInTheDocument();
    expect(dialogo).toHaveTextContent('Conte por que a imagem não viola as regras');
    expect(dialogo).toHaveTextContent('A contestação é analisada uma vez.');
    expect(dialogo).not.toHaveTextContent('Conteúdo removido');
    expect(reasonBox()).toHaveValue('');
    expect(reasonBox()).toHaveAttribute('maxlength', '1000');
  });

  it('contestar texto removido mostra o trecho e fala em conteúdo, não em imagem', async () => {
    const user = userEvent.setup();
    myModeration.mockResolvedValue(
      moderation([
        removal({ targetType: 'message', label: 'Mensagem no chat', excerpt: 'me chama no zap' }),
      ]),
    );
    renderCard();

    const dialogo = await openAppeal(user);

    expect(dialogo).toHaveTextContent('Conteúdo removidome chama no zap');
    expect(dialogo).toHaveTextContent('Conte por que o conteúdo não viola as regras');
  });

  it('com menos de 20 caracteres o envio fica travado e a tela conta quanto falta', async () => {
    const user = userEvent.setup();
    myModeration.mockResolvedValue(moderation([removal()]));
    renderCard();
    const dialogo = await openAppeal(user);
    const enviar = within(dialogo).getByRole('button', { name: 'Enviar contestação' });

    expect(within(dialogo).getByText('Escreva mais 20 caracteres')).toBeInTheDocument();
    expect(enviar).toBeDisabled();

    await fill(user, reasonBox(), 'A foto é minha mesm'); // 19
    expect(within(dialogo).getByText('Escreva mais 1 caractere')).toBeInTheDocument();
    expect(enviar).toBeDisabled();

    await user.type(reasonBox(), 'o'); // 20: a letra que falta, digitada
    expect(within(dialogo).getByText('20/1000')).toBeInTheDocument();
    expect(enviar).toBeEnabled();
  });

  it('espaços nas pontas não contam para o mínimo', async () => {
    const user = userEvent.setup();
    myModeration.mockResolvedValue(moderation([removal()]));
    renderCard();
    const dialogo = await openAppeal(user);

    await fill(user, reasonBox(), '   A foto é minha     '); // 14 de verdade

    expect(within(dialogo).getByText('Escreva mais 6 caracteres')).toBeInTheDocument();
    expect(within(dialogo).getByRole('button', { name: 'Enviar contestação' })).toBeDisabled();
    // Nem forçando o envio do formulário a contestação curta chega à API.
    fireEvent.submit(reasonBox().closest('form')!);
    expect(appealRemoval).not.toHaveBeenCalled();
  });

  it('envia o texto sem os espaços das pontas, confirma, fecha e recarrega a lista', async () => {
    const user = userEvent.setup();
    myModeration.mockResolvedValueOnce(moderation([removal({ id: 12 })]));
    // O que a API devolve depois de registrar a contestação.
    myModeration.mockResolvedValue(
      moderation([
        removal({
          id: 12,
          status: 'appealed',
          canAppeal: false,
          appealText: 'A foto é minha, tirada no meu ateliê.',
          appealedAt: APPEALED_AT,
        }),
      ]),
    );
    renderCard();
    const dialogo = await openAppeal(user);

    await fill(user, reasonBox(), '  A foto é minha, tirada no meu ateliê.  ');
    await user.click(within(dialogo).getByRole('button', { name: 'Enviar contestação' }));

    expect(appealRemoval).toHaveBeenCalledTimes(1);
    expect(appealRemoval).toHaveBeenCalledWith(12, 'A foto é minha, tirada no meu ateliê.');
    expect(
      await screen.findByText('Contestação enviada. A resposta chega por notificação e e-mail.'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Contestar remoção' })).not.toBeInTheDocument(),
    );
    // A lista do perfil é lida de novo e a linha passa a mostrar a contestação, sem o botão.
    const linha = row('Foto de perfil');
    expect(await within(linha).findByText('Contestação em análise')).toBeInTheDocument();
    expect(linha).toHaveTextContent('Sua contestaçãoA foto é minha, tirada no meu ateliê.');
    expect(within(linha).queryByRole('button', { name: 'Contestar' })).not.toBeInTheDocument();
    expect(myModeration).toHaveBeenCalledTimes(2);
  });

  it('enquanto envia, o botão diz Enviando… e fica travado', async () => {
    const user = userEvent.setup();
    myModeration.mockResolvedValue(moderation([removal()]));
    let solta!: (v: ContentRemoval) => void;
    appealRemoval.mockImplementation(() => new Promise<ContentRemoval>((r) => (solta = r)));
    renderCard();
    const dialogo = await openAppeal(user);

    await fill(user, reasonBox(), 'A foto é minha, tirada no meu ateliê.');
    await user.click(within(dialogo).getByRole('button', { name: 'Enviar contestação' }));

    expect(await within(dialogo).findByRole('button', { name: 'Enviando…' })).toBeDisabled();
    expect(screen.getByRole('dialog', { name: 'Contestar remoção' })).toBeInTheDocument();
    // Nada é confirmado antes de a API responder.
    expect(screen.queryByText(/^Contestação enviada\./)).not.toBeInTheDocument();

    solta(removal({ status: 'appealed', canAppeal: false }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Contestar remoção' })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(myModeration).toHaveBeenCalledTimes(2));
  });

  it('recusa da API: mostra a mensagem dela e o diálogo fica aberto com o texto', async () => {
    const user = userEvent.setup();
    myModeration.mockResolvedValue(moderation([removal()]));
    appealRemoval.mockRejectedValue(new Error('O prazo para contestar já terminou.'));
    renderCard();
    const dialogo = await openAppeal(user);

    await fill(user, reasonBox(), 'A foto é minha, tirada no meu ateliê.');
    await user.click(within(dialogo).getByRole('button', { name: 'Enviar contestação' }));

    expect(await screen.findByText('O prazo para contestar já terminou.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Contestar remoção' })).toBeInTheDocument();
    expect(reasonBox()).toHaveValue('A foto é minha, tirada no meu ateliê.');
    expect(screen.queryByText(/^Contestação enviada\./)).not.toBeInTheDocument();
    expect(myModeration).toHaveBeenCalledTimes(1);
  });

  it('falha sem mensagem cai no texto padrão', async () => {
    const user = userEvent.setup();
    myModeration.mockResolvedValue(moderation([removal()]));
    appealRemoval.mockRejectedValue('sem rede');
    renderCard();
    const dialogo = await openAppeal(user);

    await fill(user, reasonBox(), 'A foto é minha, tirada no meu ateliê.');
    await user.click(within(dialogo).getByRole('button', { name: 'Enviar contestação' }));

    expect(await screen.findByText('Não foi possível enviar a contestação')).toBeInTheDocument();
  });

  it('fechar sem enviar não contesta, e reabrir começa com o campo vazio', async () => {
    const user = userEvent.setup();
    myModeration.mockResolvedValue(moderation([removal()]));
    renderCard();
    const dialogo = await openAppeal(user);

    await fill(user, reasonBox(), 'Rascunho que não vou mandar agora.');
    await user.click(within(dialogo).getByRole('button', { name: 'Fechar' }));

    expect(screen.queryByRole('dialog', { name: 'Contestar remoção' })).not.toBeInTheDocument();
    expect(appealRemoval).not.toHaveBeenCalled();

    await openAppeal(user);
    expect(reasonBox()).toHaveValue('');
    expect(screen.getByText('Escreva mais 20 caracteres')).toBeInTheDocument();
  });

  it('com duas contestáveis, o botão de cada linha contesta a remoção daquela linha', async () => {
    const user = userEvent.setup();
    myModeration.mockResolvedValue(
      moderation([
        removal({ id: 7, label: 'Foto de perfil' }),
        removal({ id: 8, targetType: 'portfolio_item', label: 'Imagem do trabalho “Logo”' }),
      ]),
    );
    renderCard();
    await screen.findByText('2 remoções');

    await user.click(
      within(row('Imagem do trabalho “Logo”')).getByRole('button', { name: 'Contestar' }),
    );
    const dialogo = screen.getByRole('dialog', { name: 'Contestar remoção' });
    expect(within(dialogo).getByText('Imagem do trabalho “Logo”')).toBeInTheDocument();
    await fill(user, reasonBox(), 'O logo foi feito por mim para o cliente.');
    await user.click(within(dialogo).getByRole('button', { name: 'Enviar contestação' }));

    expect(appealRemoval).toHaveBeenCalledTimes(1);
    expect(appealRemoval).toHaveBeenCalledWith(8, 'O logo foi feito por mim para o cliente.');
    expect(
      await screen.findByText('Contestação enviada. A resposta chega por notificação e e-mail.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(myModeration).toHaveBeenCalledTimes(2));
  });
});
