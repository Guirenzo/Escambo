import { ArrowLeftRight, Compass, Home } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui';
import { usePageTitle } from '../../lib/title';

/**
 * Endereço que não existe. Antes o app mandava para a home em silêncio, o que esconde link
 * quebrado e atrapalha quem usa leitor de tela; agora a pessoa vê onde está e para onde ir.
 */
export function NotFoundView() {
  usePageTitle('Página não encontrada');
  const navigate = useNavigate();

  return (
    <main className="notfound" data-testid="not-found">
      <Link to="/" className="brand">
        <span className="brand-mark">
          <ArrowLeftRight size={18} strokeWidth={2.5} />
        </span>
        <span className="brand-name">Escambo</span>
      </Link>
      <p className="nf-code" aria-hidden="true">
        404
      </p>
      <h1>Esta página não existe</h1>
      <p className="muted">
        O endereço pode ter mudado ou o link que trouxe você até aqui está quebrado.
      </p>
      <div className="svc-actions">
        <Button type="button" onClick={() => navigate('/')}>
          <Home size={16} /> Ir para o início
        </Button>
        <Button type="button" variant="secondary" onClick={() => navigate('/servicos')}>
          <Compass size={16} /> Procurar serviços
        </Button>
      </div>
    </main>
  );
}
