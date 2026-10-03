import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
  PageHeader,
  Pill,
  QueryState,
  Select,
  Skeleton,
  Spinner,
} from './index';

/**
 * Kit base: o que cada peça entrega para quem usa a tela (nome acessível, papel, texto) e as
 * regras do diálogo modal (foco, Tab preso, Esc, clique fora). Os estados do QueryState com
 * carregando, erro com "tentar de novo", vazio e dados estão em QueryState.test.tsx.
 */

describe('Button', () => {
  it('o primário não leva classe; as outras variantes levam a própria, junto da classe pedida', () => {
    render(
      <>
        <Button>Salvar</Button>
        <Button variant="secondary" className="mini upload-btn">
          Enviar
        </Button>
        <Button variant="danger">Excluir</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Salvar' })).not.toHaveAttribute('class');
    expect(screen.getByRole('button', { name: 'Enviar' })).toHaveAttribute(
      'class',
      'secondary mini upload-btn',
    );
    expect(screen.getByRole('button', { name: 'Excluir' })).toHaveAttribute('class', 'danger');
  });

  it('repassa os atributos do botão: desabilitado não chama o clique', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Salvar
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Salvar' });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Card', () => {
  it('com título mostra o cabeçalho de nível 3 e o conteúdo', () => {
    render(
      <Card title="Carteira">
        <p>Saldo</p>
      </Card>,
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Carteira' })).toBeInTheDocument();
    expect(screen.getByText('Saldo')).toBeInTheDocument();
  });

  it('sem título não cria cabeçalho vazio', () => {
    render(
      <Card>
        <p>Saldo</p>
      </Card>,
    );
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('largo e com classe extra somam as classes ao cartão', () => {
    render(
      <Card wide className="destaque">
        <p>Saldo</p>
      </Card>,
    );
    expect(screen.getByText('Saldo').parentElement).toHaveAttribute('class', 'card wide destaque');
  });
});

describe('Field, Input e Select', () => {
  it('o rótulo dá nome ao campo que está dentro dele', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Field label="Título">
          <Input placeholder="Logo para padaria" />
        </Field>
        <Field label="Modalidade">
          <Select defaultValue="cash">
            <option value="cash">Dinheiro</option>
            <option value="credits">Créditos</option>
          </Select>
        </Field>
      </>,
    );
    const title = screen.getByLabelText('Título');
    await user.type(title, 'Logo');
    expect(title).toHaveValue('Logo');
    expect(title).toHaveAttribute('placeholder', 'Logo para padaria');
    const mode = screen.getByRole('combobox', { name: 'Modalidade' });
    await user.selectOptions(mode, 'Créditos');
    expect(mode).toHaveValue('credits');
  });
});

describe('Pill e Chip', () => {
  it('a pílula leva o status na classe (é o que dá a cor); sem status, só a base', () => {
    render(
      <>
        <Pill status="in_progress">Em andamento</Pill>
        <Pill>Neutra</Pill>
      </>,
    );
    expect(screen.getByText('Em andamento')).toHaveAttribute('class', 'pill status-in_progress');
    expect(screen.getByText('Neutra')).toHaveAttribute('class', 'pill');
  });

  it('o chip é de ranking por padrão e de nível quando pedido', () => {
    render(
      <>
        <Chip>#3</Chip>
        <Chip kind="level">Nível 2</Chip>
      </>,
    );
    expect(screen.getByText('#3')).toHaveAttribute('class', 'chip rank');
    expect(screen.getByText('Nível 2')).toHaveAttribute('class', 'chip level');
  });
});

describe('PageHeader', () => {
  it('mostra o título como h1, o subtítulo e a ação', () => {
    render(
      <PageHeader
        title="Serviços"
        subtitle="Encontre quem faz"
        action={<button type="button">Novo serviço</button>}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Serviços' })).toBeInTheDocument();
    expect(screen.getByText('Encontre quem faz')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Novo serviço' })).toBeInTheDocument();
  });

  it('sem subtítulo e sem ação, fica só o título', () => {
    const { container } = render(<PageHeader title="Ranking" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Ranking' })).toBeInTheDocument();
    expect(container.querySelector('p')).toBeNull();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('estados de tela', () => {
  it('o spinner é um status com o rótulo padrão, visível também como texto', () => {
    render(<Spinner />);
    const status = screen.getByRole('status', { name: 'Carregando…' });
    expect(within(status).getByText('Carregando…')).toBeInTheDocument();
  });

  it('o spinner aceita o rótulo de quem chama', () => {
    render(<Spinner label="Verificando sessão…" />);
    expect(screen.getByRole('status', { name: 'Verificando sessão…' })).toHaveTextContent(
      'Verificando sessão…',
    );
  });

  it('o esqueleto tem três linhas por padrão e quantas forem pedidas', () => {
    const { unmount } = render(<Skeleton />);
    expect(screen.getByRole('status', { name: 'Carregando' }).children).toHaveLength(3);
    unmount();
    render(<Skeleton lines={5} />);
    expect(screen.getByRole('status', { name: 'Carregando' }).children).toHaveLength(5);
  });

  it('o estado vazio mostra a mensagem recebida', () => {
    render(<EmptyState>Nenhuma contratação ainda.</EmptyState>);
    expect(screen.getByText('Nenhuma contratação ainda.')).toBeInTheDocument();
  });

  it('erro que não é Error vira a mensagem genérica, e sem onRetry não há botão', () => {
    render(<ErrorState error="falhou" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível carregar.');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('QueryState: vazio sem mensagem própria usa a padrão', () => {
    render(
      <QueryState
        isLoading={false}
        error={null}
        data={[] as string[]}
        isEmpty={(d) => d.length === 0}
      >
        {(d) => <p>{d.length} itens</p>}
      </QueryState>,
    );
    expect(screen.getByText('Nada por aqui ainda.')).toBeInTheDocument();
    expect(screen.queryByText('0 itens')).not.toBeInTheDocument();
  });

  it('QueryState: sem dados, sem erro e sem carregar não mostra nada', () => {
    const { container } = render(
      <QueryState isLoading={false} error={null} data={undefined as string[] | undefined}>
        {(d) => <p>{d.length} itens</p>}
      </QueryState>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('QueryState: sem isEmpty, lista vazia ainda vai para o conteúdo', () => {
    render(
      <QueryState isLoading={false} error={null} data={[] as string[]}>
        {(d) => <p>{d.length} itens</p>}
      </QueryState>,
    );
    expect(screen.getByText('0 itens')).toBeInTheDocument();
  });

  it('QueryState: carregando vem antes do erro', () => {
    render(
      <QueryState isLoading error={new Error('Deu ruim')} data={undefined as string[] | undefined}>
        {(d) => <p>{d.length} itens</p>}
      </QueryState>,
    );
    expect(screen.getByRole('status', { name: 'Carregando' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

/** Tela com um botão que abre o modal: é o caminho de quem usa (o foco volta para o botão). */
function Opener({ onClose, withField = false }: { onClose?: () => void; withField?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Abrir
      </button>
      <button type="button">Fora</button>
      {open && (
        <Modal
          title="Novo serviço"
          onClose={() => {
            onClose?.();
            setOpen(false);
          }}
        >
          {withField && <input aria-label="Título" autoFocus />}
          <button type="button">Salvar</button>
        </Modal>
      )}
    </>
  );
}

describe('Modal', () => {
  it('abre como diálogo modal com o título por nome e recebe o foco', async () => {
    const user = userEvent.setup();
    render(<Opener />);
    await user.click(screen.getByRole('button', { name: 'Abrir' }));
    const dialog = screen.getByRole('dialog', { name: 'Novo serviço' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveFocus();
    expect(within(dialog).getByRole('heading', { level: 3, name: 'Novo serviço' })).toBeVisible();
  });

  it('campo que já pediu o foco fica com ele', async () => {
    const user = userEvent.setup();
    render(<Opener withField />);
    await user.click(screen.getByRole('button', { name: 'Abrir' }));
    expect(screen.getByRole('textbox', { name: 'Título' })).toHaveFocus();
  });

  it('o ✕ fecha e devolve o foco para quem abriu', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Opener onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'Abrir' });
    await user.click(opener);
    await user.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('Esc fecha, de onde quer que o foco esteja, e não vaza para a página', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Opener onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Abrir' }));
    // Foco fora do diálogo (num botão da página): o Esc ainda é do diálogo.
    const outside = screen.getByRole('button', { name: 'Fora' });
    outside.focus();
    expect(fireEvent.keyDown(outside, { key: 'Escape' })).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('clicar fora (no fundo) fecha; clicar dentro do diálogo não', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Opener onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Abrir' }));
    const dialog = screen.getByRole('dialog', { name: 'Novo serviço' });
    await user.click(within(dialog).getByRole('heading', { name: 'Novo serviço' }));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('o Tab fica preso: do último volta ao primeiro, e Shift+Tab do primeiro vai ao último', async () => {
    const user = userEvent.setup();
    render(<Opener />);
    await user.click(screen.getByRole('button', { name: 'Abrir' }));
    const close = screen.getByRole('button', { name: 'Fechar' });
    const save = screen.getByRole('button', { name: 'Salvar' });
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab();
    expect(save).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(save).toHaveFocus();
  });

  it('Shift+Tab com o foco ainda no diálogo vai para o último controle', async () => {
    const user = userEvent.setup();
    render(<Opener />);
    await user.click(screen.getByRole('button', { name: 'Abrir' }));
    expect(screen.getByRole('dialog', { name: 'Novo serviço' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Salvar' })).toHaveFocus();
  });

  it('foco que escapou para a página volta ao primeiro controle no Tab seguinte', async () => {
    const user = userEvent.setup();
    render(<Opener />);
    await user.click(screen.getByRole('button', { name: 'Abrir' }));
    screen.getByRole('button', { name: 'Fora' }).focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Fechar' })).toHaveFocus();
  });

  it('outras teclas não fecham nem mexem no foco', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Opener onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Abrir' }));
    await user.keyboard('a{ArrowDown}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Novo serviço' })).toHaveFocus();
  });

  it('usa sempre o onClose mais recente (o Esc não chama uma função antiga)', async () => {
    const user = userEvent.setup();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(
      <Modal title="Aviso" onClose={first}>
        <p>Texto</p>
      </Modal>,
    );
    rerender(
      <Modal title="Aviso" onClose={second}>
        <p>Texto</p>
      </Modal>,
    );
    await user.keyboard('{Escape}');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('se quem abriu saiu da tela, fechar não tenta devolver o foco', async () => {
    const user = userEvent.setup();
    function Vanishing() {
      const [step, setStep] = useState<'closed' | 'open' | 'done'>('closed');
      return (
        <>
          {step === 'closed' && (
            <button type="button" onClick={() => setStep('open')}>
              Abrir
            </button>
          )}
          {step === 'open' && (
            <Modal title="Aviso" onClose={() => setStep('done')}>
              <p>Texto</p>
            </Modal>
          )}
        </>
      );
    }
    render(<Vanishing />);
    await user.click(screen.getByRole('button', { name: 'Abrir' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body).toHaveFocus();
  });
});
