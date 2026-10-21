import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Inbox, Wallet } from 'lucide-react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import {
  Breadcrumbs,
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
  onTablistKeyDown,
  PageHeader,
  Pill,
  QueryState,
  Select,
  Skeleton,
  SkipLink,
  Stat,
  TableWrap,
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

  it('erro técnico do JavaScript não aparece cru: vira a mensagem genérica (RNF-028)', () => {
    const { unmount } = render(
      <ErrorState error={new TypeError("Cannot read properties of undefined (reading 'items')")} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível carregar.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('Cannot read properties');
    unmount();

    // A mensagem da API (ou de uma regra nossa) continua aparecendo como veio.
    render(<ErrorState error={new Error('Serviço indisponível no momento.')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Serviço indisponível no momento.');
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

describe('Modal: quem abriu, com campo de foco automático', () => {
  it('o foco volta para quem abriu mesmo quando um campo do diálogo pediu o foco ao abrir', async () => {
    const user = userEvent.setup();
    render(<Opener withField />);
    const opener = screen.getByRole('button', { name: 'Abrir' });
    await user.click(opener);
    expect(screen.getByRole('textbox', { name: 'Título' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});

describe('TableWrap', () => {
  it('é uma região com nome que entra no Tab, para a tabela larga rolar pelo teclado', async () => {
    const user = userEvent.setup();
    render(
      <TableWrap label="Tabela de saques">
        <table>
          <tbody>
            <tr>
              <td>R$ 10,00</td>
            </tr>
          </tbody>
        </table>
      </TableWrap>,
    );
    const region = screen.getByRole('region', { name: 'Tabela de saques' });
    expect(region).toHaveClass('table-wrap');
    expect(within(region).getByRole('table')).toBeInTheDocument();
    await user.tab();
    expect(region).toHaveFocus();
  });
});

describe('SkipLink', () => {
  it('é um link para a âncora e leva o foco ao alvo sem mudar a URL', async () => {
    const user = userEvent.setup();
    const before = window.location.href;
    render(
      <>
        <SkipLink target="conteudo" />
        <button type="button">Menu</button>
        <main id="conteudo" tabIndex={-1}>
          <button type="button">Primeiro do conteúdo</button>
        </main>
      </>,
    );
    const link = screen.getByRole('link', { name: 'Pular para o conteúdo' });
    expect(link).toHaveAttribute('href', '#conteudo');
    await user.tab();
    expect(link).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('main')).toHaveFocus();
    expect(window.location.href).toBe(before);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Primeiro do conteúdo' })).toHaveFocus();
  });

  it('aceita outro rótulo e, sem o alvo na tela, segue o link normalmente', () => {
    render(<SkipLink target="nao-existe" label="Ir para a lista" />);
    const link = screen.getByRole('link', { name: 'Ir para a lista' });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });
});

describe('onTablistKeyDown', () => {
  function Tabs({ disabledLast = false }: { disabledLast?: boolean }) {
    const [tab, setTab] = useState('a');
    return (
      <>
        <div role="tablist" aria-label="Período" onKeyDown={onTablistKeyDown}>
          {['a', 'b', 'c'].map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              disabled={disabledLast && t === 'c'}
              onClick={() => setTab(t)}
            >
              {t.toUpperCase()}
            </button>
          ))}
        </div>
        <p>escolhida: {tab}</p>
      </>
    );
  }
  const tab = (name: string) => screen.getByRole('tab', { name });

  it('setas andam em círculo e acionam a aba; Home e End vão às pontas', async () => {
    const user = userEvent.setup();
    render(<Tabs />);
    tab('A').focus();
    await user.keyboard('{ArrowRight}');
    expect(tab('B')).toHaveFocus();
    expect(tab('B')).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(tab('A')).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(tab('C')).toHaveFocus();
    expect(screen.getByText('escolhida: c')).toBeInTheDocument();
    await user.keyboard('{Home}');
    expect(tab('A')).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}');
    expect(tab('C')).toHaveAttribute('aria-selected', 'true');
  });

  it('aba desabilitada fica fora; End na última não aciona de novo; outras teclas passam', async () => {
    const user = userEvent.setup();
    render(<Tabs disabledLast />);
    tab('B').focus();
    await user.keyboard('{End}');
    expect(tab('B')).toHaveFocus();
    expect(screen.getByText('escolhida: a')).toBeInTheDocument();
    await user.keyboard('{ArrowRight}');
    expect(tab('A')).toHaveFocus();
    await user.keyboard('x');
    expect(tab('A')).toHaveFocus();
  });

  it('com o foco fora das abas (no próprio tablist), não faz nada', () => {
    render(<Tabs />);
    const list = screen.getByRole('tablist');
    list.tabIndex = -1;
    list.focus();
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(list).toHaveFocus();
    expect(screen.getByText('escolhida: a')).toBeInTheDocument();
  });
});

describe('kit v2: tamanhos, carregando, cabeçalhos e indicadores', () => {
  it('o botão leva o tamanho na classe; carregando, trava e avisa (aria-busy)', async () => {
    const onClick = vi.fn();
    render(
      <>
        <Button size="sm">Pequeno</Button>
        <Button variant="secondary" size="lg" loading onClick={onClick}>
          Salvando
        </Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Pequeno' })).toHaveAttribute('class', 'sm');
    expect(screen.getByRole('button', { name: 'Pequeno' })).not.toHaveAttribute('aria-busy');
    const busy = screen.getByRole('button', { name: 'Salvando' });
    expect(busy).toHaveAttribute('class', 'secondary lg');
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy).toBeDisabled();
    expect(busy.querySelector('.btn-spin')).not.toBeNull();
    await userEvent.click(busy);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('o cartão com linha de apoio e ação monta o cabeçalho; interativo leva a classe', () => {
    const { container } = render(
      <Card
        title="Atalhos"
        subtitle="O que mais se faz"
        action={<button type="button">Ver tudo</button>}
        interactive
      >
        <p>conteúdo</p>
      </Card>,
    );
    const head = container.querySelector('.card-head')!;
    expect(
      within(head as HTMLElement).getByRole('heading', { level: 3, name: 'Atalhos' }),
    ).toBeInTheDocument();
    expect(within(head as HTMLElement).getByText('O que mais se faz')).toHaveClass('card-sub');
    expect(
      within(head as HTMLElement).getByRole('button', { name: 'Ver tudo' }),
    ).toBeInTheDocument();
    expect(container.querySelector('section')).toHaveClass('card', 'interactive');
  });

  it('o cartão só com ação (sem linha de apoio) também ganha o cabeçalho', () => {
    const { container } = render(
      <Card title="Saques" action={<span>3</span>}>
        <p>lista</p>
      </Card>,
    );
    expect(container.querySelector('.card-head h3')).toHaveTextContent('Saques');
    expect(container.querySelector('.card-sub')).toBeNull();
  });

  it('o indicador junta rótulo, número, legenda e a barra com nome', () => {
    const { container } = render(
      <Stat
        Icon={Wallet}
        label="Saldo"
        value="R$ 10,00"
        hint="para saque"
        tone="amber"
        progress={41.6}
        progressLabel="Progresso de nível"
      />,
    );
    const kpi = container.querySelector('.kpi')!;
    expect(kpi).toHaveClass('kpi', 'amber');
    expect(kpi).toHaveTextContent('SaldoR$ 10,00para saque');
    expect(screen.getByRole('progressbar', { name: 'Progresso de nível' })).toHaveAttribute(
      'aria-valuenow',
      '42',
    );
  });

  it('o indicador sem tom, legenda nem barra fica só com rótulo e número', () => {
    const { container } = render(<Stat Icon={Wallet} label="Créditos" value="40" />);
    expect(container.querySelector('.kpi')).toHaveAttribute('class', 'kpi');
    expect(container.querySelector('.kpi')).toHaveTextContent(/^Créditos40$/);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('o cabeçalho de página aceita migalhas, linha de contexto e algo antes do texto', () => {
    const { container } = render(
      <MemoryRouter>
        <PageHeader
          leading={<span data-testid="avatar">A</span>}
          eyebrow="Terça-feira, 20 de outubro"
          breadcrumbs={[{ label: 'Início', to: '/' }, { label: 'Contrato' }]}
          title="Boa tarde, Ana"
        />
      </MemoryRouter>,
    );
    expect(container.querySelector('.page-head')).toHaveClass('has-leading');
    expect(screen.getByTestId('avatar')).toBeInTheDocument();
    expect(screen.getByText('Terça-feira, 20 de outubro')).toHaveClass('page-eyebrow');
    const crumbs = screen.getByRole('list', { name: 'Você está em' });
    expect(within(crumbs).getByRole('link', { name: 'Início' })).toHaveAttribute('href', '/');
    expect(within(crumbs).getByText('Contrato')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 1, name: 'Boa tarde, Ana' })).toBeInTheDocument();
  });

  it('migalhas sozinhas: a página atual sem link, as anteriores com link', () => {
    render(
      <MemoryRouter>
        <Breadcrumbs items={[{ label: 'Serviços', to: '/servicos' }, { label: 'Logo' }]} />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual(['Serviços']);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('o estado vazio aceita título, ícone e ação', () => {
    const { container } = render(
      <EmptyState icon={Inbox} title="Nenhum depósito ainda" action={<button>Depositar</button>}>
        Os depósitos via PIX aparecem aqui.
      </EmptyState>,
    );
    expect(screen.getByText('Nenhum depósito ainda')).toHaveClass('empty-title');
    expect(screen.getByText('Os depósitos via PIX aparecem aqui.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Depositar' })).toBeInTheDocument();
    expect(container.querySelector('.empty-ico')).toHaveAttribute('aria-hidden', 'true');
  });

  it('o estado vazio sem frase nem ação fica só com o título', () => {
    const { container } = render(<EmptyState title="Nada aqui" />);
    expect(container.querySelector('p.muted')).toBeNull();
    expect(container.querySelector('.empty-action')).toBeNull();
  });
});
