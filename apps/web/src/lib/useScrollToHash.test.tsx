import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useScrollToHashWhenSettled } from './useScrollToHash';

/** Uma página com uma consulta que só termina quando o teste manda, e o título-âncora. */
function Page({ load, withTarget = true }: { load: () => Promise<string>; withTarget?: boolean }) {
  useScrollToHashWhenSettled();
  const q = useQuery({ queryKey: ['pagina'], queryFn: load });
  return (
    <main>
      <p>{q.data ?? 'carregando'}</p>
      {withTarget && <h3 id="health-title">Saúde da moderação</h3>}
    </main>
  );
}

const renderAt = (path: string, load: () => Promise<string>, withTarget = true) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[path]}>
        <Page load={load} withTarget={withTarget} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

/** Deixa o React Query avisar que a consulta começou (ele notifica num setTimeout). */
const tick = () => act(async () => new Promise((r) => setTimeout(r, 20)));

/** Um carregamento controlado pelo teste. */
function deferred() {
  let resolve!: (v: string) => void;
  const promise = new Promise<string>((r) => (resolve = r));
  return { load: () => promise, resolve };
}

const scroll = vi.fn();
beforeEach(() => {
  scroll.mockReset();
  Element.prototype.scrollIntoView = scroll;
});
afterEach(() => {
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

/** Link com âncora para o painel (ADR 55): rola e foca uma vez, quando a página assenta. */
describe('useScrollToHashWhenSettled', () => {
  it('espera as consultas terminarem, rola uma vez e põe o foco no destino', async () => {
    const d = deferred();
    renderAt('/admin#health-title', d.load);
    await tick();
    expect(scroll).not.toHaveBeenCalled();

    await act(async () => d.resolve('pronto'));
    await screen.findByText('pronto');
    const title = screen.getByRole('heading', { name: 'Saúde da moderação' });
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(title);
    expect(title).toHaveAttribute('tabindex', '-1');
    expect(title).toHaveFocus();
  });

  it('sem âncora, ou com uma âncora que não existe na página, não rola nem mexe no foco', async () => {
    const a = deferred();
    const { unmount } = renderAt('/admin', a.load);
    await tick();
    await act(async () => a.resolve('pronto'));
    await screen.findByText('pronto');
    expect(scroll).not.toHaveBeenCalled();
    unmount();

    const b = deferred();
    renderAt('/admin#health-title', b.load, false);
    await tick();
    await act(async () => b.resolve('pronto'));
    await screen.findByText('pronto');
    expect(scroll).not.toHaveBeenCalled();
    expect(document.body).toHaveFocus();
  });
});
