import { PageHeader } from '../../components/ui';
import { usePageTitle } from '../../lib/title';
import { SupportDesk } from '../support/SupportDesk';

export function SuporteView() {
  usePageTitle('Suporte');
  return (
    <div className="page">
      <PageHeader
        title="Suporte"
        subtitle="Acompanhe seus chamados e fale com a equipe do Escambo."
      />
      <SupportDesk />
    </div>
  );
}
