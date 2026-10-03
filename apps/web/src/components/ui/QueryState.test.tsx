import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QueryState } from './index';

const base = {
  isEmpty: (d: string[]) => d.length === 0,
  children: (d: string[]) => (
    <ul>
      {d.map((x) => (
        <li key={x}>{x}</li>
      ))}
    </ul>
  ),
};

describe('QueryState (estados padrão do kit)', () => {
  it('carregando mostra o esqueleto e nada do conteúdo', () => {
    render(<QueryState isLoading error={null} data={['a']} {...base} />);
    expect(screen.getByRole('status', { name: 'Carregando' })).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('erro mostra a mensagem dele e o "Tentar de novo" chama onRetry', async () => {
    const onRetry = vi.fn();
    render(
      <QueryState
        isLoading={false}
        error={new Error('Deu ruim')}
        data={undefined}
        onRetry={onRetry}
        {...base}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Deu ruim');
    await userEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('erro vem antes dos dados antigos: a lista que já tinha chegado sai da tela', () => {
    render(
      <QueryState isLoading={false} error={new Error('Deu ruim')} data={['a', 'b']} {...base} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Deu ruim');
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('vazio mostra a mensagem informada no lugar da lista', () => {
    render(<QueryState isLoading={false} error={null} data={[]} empty="Nada aqui." {...base} />);
    expect(screen.getByText('Nada aqui.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('com dados, mostra o conteúdo, sem carregando, erro ou vazio', () => {
    render(<QueryState isLoading={false} error={null} data={['a', 'b']} {...base} />);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['a', 'b']);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Nada por aqui ainda.')).not.toBeInTheDocument();
  });
});
