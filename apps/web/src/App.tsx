import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { backTo, RequireAuth } from './components/RequireAuth';
import { Spinner } from './components/ui';
import { NotFoundView } from './features/views/NotFoundView';
import {
  ForgotPasswordView,
  ResetPasswordView,
  VerifyEmailView,
} from './features/auth/AccountViews';
import { LoginForm } from './features/auth/LoginForm';
import { LegalView } from './features/legal/LegalView';
import { Shell } from './features/shell/Shell';
import { AdminView } from './features/views/AdminView';
import { CarteiraView } from './features/views/CarteiraView';
import { FreelancerView } from './features/views/FreelancerView';
import { InicioView } from './features/views/InicioView';
import { NotificacoesView } from './features/views/NotificacoesView';
import { PerfilView } from './features/views/PerfilView';
import { RankingView } from './features/views/RankingView';
import { SalaContratoView } from './features/views/SalaContratoView';
import { ServicosView } from './features/views/ServicosView';
import { TrocasView } from './features/views/TrocasView';
import { useAuth } from './lib/auth';
import { RouteAnnouncer } from './lib/title';
import './styles.css';
import { MaintenanceGate } from './components/MaintenanceGate';

/**
 * /login: se já autenticado, volta para onde a guarda mandou (só caminhos do próprio app, nunca
 * `//outro-site`), ou para a home.
 */
function LoginRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading)
    return (
      <div className="splash">
        <Spinner />
      </div>
    );
  if (user) return <Navigate to={backTo(location.state)} replace />;
  return <LoginForm />;
}

/** /admin: só para administradores (ADMIN_EMAILS); os demais voltam para a home. */
function AdminRoute() {
  const { user } = useAuth();
  if (user?.role !== 'admin') return <Navigate to="/" replace />;
  return <AdminView />;
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
      <RouteAnnouncer />
      <MaintenanceGate>
        <Routes>
          <Route path="/login" element={<LoginRoute />} />
          <Route path="/esqueci-senha" element={<ForgotPasswordView />} />
          <Route path="/redefinir-senha" element={<ResetPasswordView />} />
          <Route path="/verificar-email" element={<VerifyEmailView />} />
          <Route path="/termos" element={<LegalView kind="termos" />} />
          <Route path="/privacidade" element={<LegalView kind="privacidade" />} />
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
              <Route path="freelancers/:ulid" element={<FreelancerView />} />
              <Route path="admin" element={<AdminRoute />} />
            </Route>
          </Route>
          <Route path="*" element={<NotFoundView />} />
        </Routes>
      </MaintenanceGate>
    </BrowserRouter>
  );
}
