import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TagsInput } from './TagsInput';

/** O campo com estado de verdade, como o formulário usa; `spy` vê cada lista nova. */
function Harness({ initial = [], spy }: { initial?: string[]; spy?: (tags: string[]) => void }) {
  const [tags, setTags] = useState(initial);
  return (
    <form onSubmit={(e) => e.preventDefault()}>
      <TagsInput
        value={tags}
        onChange={(next) => {
          spy?.(next);
          setTags(next);
        }}
      />
      <button type="submit">Enviar</button>
    </form>
  );
}

const input = () => screen.getByLabelText('Tags (opcional)');
const chips = () =>
  screen.queryByRole('list', { name: 'Tags do serviço' })
    ? Array.from(screen.getByRole('list', { name: 'Tags do serviço' }).querySelectorAll('li')).map(
        (li) => li.textContent,
      )
    : [];

describe('TagsInput (RF-024)', () => {
  it('Enter adiciona a tag normalizada, sem enviar o formulário, e o leitor de tela ouve', async () => {
    const user = userEvent.setup();
    const submit = vi.fn((e: Event) => e.preventDefault());
    render(<Harness />);
    screen.getByRole('button', { name: 'Enviar' }).closest('form')!.onsubmit = submit;

    await user.type(input(), '  React  Native {Enter}');

    expect(chips()).toEqual(['react native']);
    expect(input()).toHaveValue('');
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Tag adicionada: react native');
    expect(screen.getByText(/\(1\/10\)/)).toBeInTheDocument();
  });

  it('vírgula adiciona; colar "a, b, c" adiciona as que valem e deixa o resto no campo', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(input(), 'logo,');
    expect(chips()).toEqual(['logo']);
    expect(input()).toHaveValue('');

    // Colar de uma vez (o onChange recebe o texto inteiro).
    fireEvent.change(input(), { target: { value: 'Figma, x, ui/ux, fim' } });
    expect(chips()).toEqual(['logo', 'figma', 'ui/ux']);
    // "x" é curta demais e fica no campo, junto do pedaço depois da última vírgula.
    expect(input()).toHaveValue('x, fim');
    expect(screen.getByRole('alert')).toHaveTextContent('Cada tag tem de 2 a 30 caracteres.');
  });

  it('vírgula sozinha, ou Enter sem texto, não fazem nada (Enter vazio segue para o formulário)', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    await user.type(input(), ',{Enter}');
    expect(spy).not.toHaveBeenCalled();
    expect(input()).toHaveValue('');
  });

  it('repetida (sem caixa e sem acento) é recusada com o motivo; digitar de novo limpa o aviso', async () => {
    const user = userEvent.setup();
    render(<Harness initial={['programação']} />);

    await user.type(input(), 'PROGRAMACAO{Enter}');
    expect(chips()).toEqual(['programação']);
    expect(screen.getByRole('alert')).toHaveTextContent('A tag "programacao" já está na lista.');
    expect(input()).toHaveAttribute('aria-invalid', 'true');
    expect(input()).toHaveValue('PROGRAMACAO');

    await user.type(input(), 'x');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(input()).not.toHaveAttribute('aria-invalid');
  });

  it('no máximo 10: a 11ª é recusada e o campo avisa que o limite chegou', async () => {
    const user = userEvent.setup();
    const ten = Array.from({ length: 10 }, (_, i) => `tag${i}`);
    render(<Harness initial={ten} />);
    expect(input()).toHaveAttribute('placeholder', 'Limite de tags atingido');

    await user.type(input(), 'mais uma{Enter}');
    expect(chips()).toHaveLength(10);
    expect(screen.getByRole('alert')).toHaveTextContent('No máximo 10 tags por serviço.');
  });

  it('o × do chip remove pelo teclado e devolve o foco ao campo', async () => {
    const user = userEvent.setup();
    render(<Harness initial={['logo', 'figma']} />);

    const remove = screen.getByRole('button', { name: 'Remover a tag logo' });
    remove.focus();
    await user.keyboard('{Enter}');

    expect(chips()).toEqual(['figma']);
    expect(input()).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Tag removida: logo');
  });

  it('Backspace com o campo vazio remove a última tag; com texto, apaga o texto', async () => {
    const user = userEvent.setup();
    render(<Harness initial={['logo', 'figma']} />);

    await user.type(input(), 'ab{Backspace}');
    expect(chips()).toEqual(['logo', 'figma']);
    await user.keyboard('{Backspace}{Backspace}');
    expect(chips()).toEqual(['logo']);
  });

  it('sair do campo com texto adiciona a tag (quem clica em salvar não perde o que digitou)', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'Node.js');
    await user.tab();
    expect(chips()).toEqual(['node.js']);
  });

  it('caractere fora do permitido: a tag não entra e o motivo aparece ligado ao campo', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), '<b>{Enter}');
    expect(chips()).toEqual([]);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Use só letras, números, espaço e + # . / _ -');
    expect(input().getAttribute('aria-describedby')).toContain(alert.id);
  });
});
