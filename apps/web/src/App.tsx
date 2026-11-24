/**
 * Mapa de URL para tela do web (React Router). Camada: roteamento do front.
 * Cada <Route> liga um caminho do navegador (ex.: /servicos/12) a um componente de tela, quase
 * todos em features/views. Quem chama: o main.tsx desenha <App />. O que chama: as telas, as
 * guardas (AuthGate e as pequenas *Route abaixo) e o Shell, a moldura com menu e barra do topo.
 * Blocos dentro de <Routes>:
 *   - rotas públicas: login, cadastro, volta do Google, senha, e-mail, termos e privacidade;
 *   - rotas logadas, dentro do AuthGate e do Shell: Início, Serviços, Carteira, Sala etc.;
 *   - "*" no fim: endereço desconhecido cai na página 404.
 * LoginRoute, AdminRoute, SalaContratoRoute e ServicoRoute leem a sessão ou a URL antes de abrir
 * a tela. A guarda daqui só organiza a navegação: quem barra de verdade é a API.
 */
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { AuthGate, backTo } from './components/AuthGate';
import { Spinner } from './components/ui';
import { NotFoundView } from './features/views/NotFoundView';
import {
  ConfirmEmailChangeView,
  ForgotPasswordView,
  ResetPasswordView,
  VerifyEmailView,
} from './features/auth/AccountViews';
import { LoginForm, type AuthMode } from './features/auth/LoginForm';
import { GoogleReturnView } from './features/auth/GoogleReturnView';
import { LandingView } from './features/landing/LandingView';
import { LegalView } from './features/legal/LegalView';
import { Shell } from './features/shell/Shell';
import { AdminView } from './features/views/AdminView';
import { CarteiraView } from './features/views/CarteiraView';
import { EmpresaView } from './features/views/EmpresaView';
import { FreelancerView } from './features/views/FreelancerView';
import { InicioView } from './features/views/InicioView';
import { NotificacoesView } from './features/views/NotificacoesView';
import { PerfilView } from './features/views/PerfilView';
import { RankingView } from './features/views/RankingView';
import { SalaContratoView } from './features/views/SalaContratoView';
import { ServicosView } from './features/views/ServicosView';
import { ServicoView } from './features/views/ServicoView';
import { TrocasView } from './features/views/TrocasView';
import { SuporteView } from './features/views/SuporteView';
import { useAuth } from './lib/auth';
import { RouteAnnouncer } from './lib/title';
import './styles.css';
import './album-app.css';
import './album-inicio.css';
import './album-servicos.css';
import './album-servico.css';
import './album-trocas.css';
import './album-carteira.css';
import './album-ranking.css';
import { MaintenanceGate } from './components/MaintenanceGate';

/**
 * /login e /cadastro: se já autenticado, volta para onde a guarda mandou (só caminhos do próprio
 * app, nunca `//outro-site`), ou para a home. /cadastro abre em "Criar conta", com o "Eu sou" de
 * `?perfil=freelancer|cliente|empresa`.
 */
function LoginRoute({ mode = 'login' }: { mode?: AuthMode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  const perfil = new URLSearchParams(location.search).get('perfil');
  if (loading)
    return (
      <div className="splash">
        <Spinner />
      </div>
    );
  if (user) return <Navigate to={backTo(location.state)} replace />;
  // O "Eu sou" do cadastro vem da URL (?perfil=...); valor desconhecido abre como cliente.
  const role = perfil === 'freelancer' ? 'freelancer' : perfil === 'empresa' ? 'company' : 'client';
  return <LoginForm initialMode={mode} initialRole={role} />;
}

/** /admin: papel atual de administrador e conta sem suspensão. A API revalida os dois. */
function AdminRoute() {
  const { user } = useAuth();
  if (user?.role !== 'admin' || user.status === 'suspended') return <Navigate to="/" replace />;
  return <AdminView />;
}

/** /contratos/:id → sala do contrato (timeline + chat). */
function SalaContratoRoute() {
  const { id } = useParams();
  const navigate = useNavigate();
  const contractId = Number(id);
  // Id que não é inteiro positivo (ex.: /contratos/abc) volta para o Início, sem chamar a API.
  if (!Number.isInteger(contractId) || contractId <= 0) return <Navigate to="/" replace />;
  return <SalaContratoView contractId={contractId} onBack={() => navigate(-1)} />;
}

/** /servicos/:id → detalhe do serviço (RF-024, RF-029). */
function ServicoRoute() {
  const serviceId = Number(useParams().id);
  if (!Number.isInteger(serviceId) || serviceId <= 0) return <Navigate to="/servicos" replace />;
  return <ServicoView serviceId={serviceId} />;
}

/**
 * O roteador do app. O BrowserRouter usa a URL de verdade (sem #): na produção o nginx manda
 * qualquer caminho para o index.html (try_files) e aqui o React Router escolhe a tela.
 * RouteAnnouncer avisa o leitor de tela quando a rota troca (ADR 21), e o MaintenanceGate põe a
 * tela de manutenção ou de fora do ar no lugar de tudo quando a API avisa (ADR 33, RNF-010).
 */
export function App() {
  return (
    <BrowserRouter>
      <RouteAnnouncer />
      <MaintenanceGate>
        <Routes>
          <Route path="/login" element={<LoginRoute />} />
          <Route path="/cadastro" element={<LoginRoute mode="register" />} />
          {/* A volta do Google (RF-002): troca o código de uso único do endereço pela sessão. */}
          <Route path="/entrar/google" element={<GoogleReturnView />} />
          <Route path="/esqueci-senha" element={<ForgotPasswordView />} />
          <Route path="/redefinir-senha" element={<ResetPasswordView />} />
          <Route path="/verificar-email" element={<VerifyEmailView />} />
          <Route path="/confirmar-novo-email" element={<ConfirmEmailChangeView />} />
          <Route path="/termos" element={<LegalView kind="termos" />} />
          <Route path="/privacidade" element={<LegalView kind="privacidade" />} />
          {/* `/` sem sessão é a página pública; com sessão, o Início dentro do Shell. */}
          <Route element={<AuthGate home={<LandingView />} />}>
            {/* Rota sem path: o Shell desenha a moldura e a tela entra no Outlet dele. */}
            <Route element={<Shell />}>
              <Route index element={<InicioView />} />
              <Route path="servicos" element={<ServicosView />} />
              <Route path="servicos/:id" element={<ServicoRoute />} />
              <Route path="trocas" element={<TrocasView />} />
              <Route path="ranking" element={<RankingView />} />
              <Route path="carteira" element={<CarteiraView />} />
              <Route path="notificacoes" element={<NotificacoesView />} />
              <Route path="perfil" element={<PerfilView />} />
              <Route path="suporte" element={<SuporteView />} />
              <Route path="contratos/:id" element={<SalaContratoRoute />} />
              <Route path="freelancers/:ulid" element={<FreelancerView />} />
              <Route path="empresas/:ulid" element={<EmpresaView />} />
              <Route path="admin" element={<AdminRoute />} />
            </Route>
          </Route>
          {/* Qualquer endereço que não casou acima: página 404 com saídas (ADR 21). */}
          <Route path="*" element={<NotFoundView />} />
        </Routes>
      </MaintenanceGate>
    </BrowserRouter>
  );
}
