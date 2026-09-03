import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QueryState } from './index';

const base = { isEmpty: (d: string[]) => d.length === 0, children: (d: string[]) => <ul>{d.map((x) => <li key={x}>{x}</li>)}</ul> };

describe('QueryState (estados padrão do kit)', () => {
  it('carregando → skeleton', () => {
    render(<QueryState isLoading error={null} data={undefined} {...base} />);
    expect(screen.getByRole('status', { name: 'Carregando' })).toBeInTheDocument();
  });

  it('erro → mensagem + botão de tentar de novo que chama onRetry', async () => {
    const onRetry = vi.fn();
    render(<QueryState isLoading={false} error={new Error('Deu ruim')} data={undefined} onRetry={onRetry} {...base} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Deu ruim');
    await userEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('vazio → empty state com a mensagem informada', () => {
    render(<QueryState isLoading={false} error={null} data={[]} empty="Nada aqui." {...base} />);
    expect(screen.getByText('Nada aqui.')).toBeInTheDocument();
  });

  it('dados → renderiza o conteúdo', () => {
    render(<QueryState isLoading={false} error={null} data={['a', 'b']} {...base} />);
    expect(screen.getByText('a')).toBeInTheDocument();
    expect(screen.getByText('b')).toBeInTheDocument();
  });
});
