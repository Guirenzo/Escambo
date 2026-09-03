import { BrowserRouter, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { RequireAuth } from './components/RequireAuth';
import { Spinner } from './components/ui';
import { LoginForm } from './features/auth/LoginForm';
import { Shell } from './features/shell/Shell';
import { CarteiraView } from './features/views/CarteiraView';
import { InicioView } from './features/views/InicioView';
import { NotificacoesView } from './features/views/NotificacoesView';
import { PerfilView } from './features/views/PerfilView';
import { RankingView } from './features/views/RankingView';
import { SalaContratoView } from './features/views/SalaContratoView';
import { ServicosView } from './features/views/ServicosView';
import { TrocasView } from './features/views/TrocasView';
import { useAuth } from './lib/auth';
import './styles.css';

/** /login: se já autenticado, vai para a home. */
function LoginRoute() {
  const { user, loading } = useAuth();
  if (loading) return <div className="splash"><Spinner /></div>;
  if (user) return <Navigate to="/" replace />;
  return <LoginForm />;
}

/** /contratos/:id → sala do contrato (timeline + chat). */
function SalaContratoRoute() {
  const { id } = useParams();
  const navigate = useNavigate();
  const contractId = Number(id);
  if (!Number.isInteger(contractId) || contractId <= 0) return <Navigate to="/" replace />;
  return <SalaContratoView contractId={contractId} onBack={() => navigate(-1)} />;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginRoute />} />
        <Route element={<RequireAuth />}>
          <Route element={<Shell />}>
            <Route index element={<InicioView />} />
            <Route path="servicos" element={<ServicosView />} />
            <Route path="trocas" element={<TrocasView />} />
            <Route path="ranking" element={<RankingView />} />
            <Route path="carteira" element={<CarteiraView />} />
            <Route path="notificacoes" element={<NotificacoesView />} />
            <Route path="perfil" element={<PerfilView />} />
            <Route path="contratos/:id" element={<SalaContratoRoute />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
