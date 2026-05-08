// Top-level App: auth gate + routed shell.
// Onboarding takes over when there's no session; otherwise the Layout renders
// the sidebar/topbar around routed page content.

import { useEffect, useState, type ReactElement } from 'react';
import {
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useOutletContext,
} from 'react-router-dom';
import type { CodeSample, FunctionRecord, PresetId, Session, ToastMsg } from '@shared/types';
import { Sidebar } from './components/shell/Sidebar';
import { TopBar } from './components/shell/TopBar';
import { ExpiredBanner } from './components/shell/ExpiredBanner';
import { Onboarding } from './components/onboarding/Onboarding';
import { TemplatesPage } from './components/templates/TemplatesPage';
import { FunctionBuilder } from './components/builder/FunctionBuilder';
import { Toast } from './components/ui/Toast';
import { FunctionsPage } from './pages/FunctionsPage';
import { FunctionDetailPage } from './pages/FunctionDetailPage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { useFunctions } from './lib/useFunctions';
import { api } from './lib/api';

type LayoutContext = {
  session: Session;
  services: FunctionRecord[];
  setLocal: (next: FunctionRecord[] | ((prev: FunctionRecord[]) => FunctionRecord[])) => void;
  refresh: () => Promise<void>;
  openBuilder: (preset?: PresetId | null) => void;
};

export function useLayout(): LayoutContext {
  return useOutletContext<LayoutContext>();
}

export default function App(): ReactElement {
  const [session, setSession] = useState<Session | null>(() => api.getSession());
  const [reconnecting, setReconnecting] = useState(false);

  const handleConnect = (sess: Session) => {
    setSession(sess);
    setReconnecting(false);
  };

  if (!session || reconnecting) {
    return <Onboarding onConnect={handleConnect} />;
  }

  return (
    <Routes>
      <Route element={<Layout session={session} setSession={setSession} setReconnecting={setReconnecting} />}>
        <Route path="/" element={<Navigate to="/functions" replace />} />
        <Route path="/functions" element={<FunctionsPage />} />
        <Route path="/functions/:id" element={<FunctionDetailPage />} />
        <Route path="/templates" element={<TemplatesPageRoute />} />
        <Route path="/logs" element={<PlaceholderPage label="Logs" />} />
        <Route path="/keys" element={<PlaceholderPage label="API keys" />} />
        <Route path="/usage" element={<PlaceholderPage label="Usage" />} />
        <Route path="/docs" element={<PlaceholderPage label="Documentation" />} />
        <Route path="/support" element={<PlaceholderPage label="Support" />} />
        <Route path="*" element={<Navigate to="/functions" replace />} />
      </Route>
    </Routes>
  );
}

function Layout({
  session,
  setSession,
  setReconnecting,
}: {
  session: Session;
  setSession: (s: Session | null) => void;
  setReconnecting: (b: boolean) => void;
}): ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const { services, refresh, setLocal } = useFunctions();
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderPreset, setBuilderPreset] = useState<PresetId | null>(null);
  const [toast, setToast] = useState<ToastMsg | null>(null);
  const [expired, setExpired] = useState(false);

  // ?expired=1 banner on mount.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('expired') === '1') setExpired(true);
  }, []);

  const handleDisconnect = () => {
    api.disconnect();
    setSession(null);
    setBuilderOpen(false);
  };

  const openBuilder = (preset: PresetId | null = null) => {
    setBuilderPreset(preset);
    setBuilderOpen(true);
  };

  const handleDeploy = async (sample: CodeSample) => {
    try {
      const svc = await api.deploy(sample);
      setLocal((cur) => [svc, ...cur.filter((s) => s.id !== svc.id)]);
      setBuilderOpen(false);
      setToast({ kind: 'ok', text: `Deploying ${svc.name}…` });
      setTimeout(() => setToast(null), 3500);
      // Jump to the detail page so the user sees the live deployment progress.
      navigate(`/functions/${svc.id}`);
      // Kick off a refresh in the background to pull latestDeploymentId.
      refresh().catch(() => undefined);
    } catch (err) {
      setBuilderOpen(false);
      setToast({ kind: 'error', text: `Deploy failed: ${(err as Error).message}` });
      setTimeout(() => setToast(null), 6000);
    }
  };

  const sidebarActive = pathToSidebarId(location.pathname);

  const ctx: LayoutContext = { session, services, setLocal, refresh, openBuilder };

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
        position: 'relative',
        display: 'flex',
      }}
    >
      <Sidebar
        active={sidebarActive}
        onSelect={(id) => navigate(sidebarIdToPath(id))}
        onDeploy={() => openBuilder(null)}
      />

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <TopBar
          session={session}
          expired={expired}
          onDisconnect={handleDisconnect}
          onReconnect={() => setReconnecting(true)}
          onOpenAgent={() => openBuilder(null)}
        />

        <div style={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative' }}>
          <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
            <Outlet context={ctx} />
          </div>

          {expired && (
            <ExpiredBanner
              onReconnect={() => {
                setReconnecting(true);
                setExpired(false);
              }}
              onDismiss={() => setExpired(false)}
            />
          )}

          {builderOpen && (
            <FunctionBuilder
              initialPreset={builderPreset}
              onClose={() => setBuilderOpen(false)}
              onDeploy={handleDeploy}
            />
          )}
          {toast && <Toast toast={toast} />}
        </div>
      </div>
    </div>
  );
}

function TemplatesPageRoute(): ReactElement {
  const { openBuilder } = useLayout();
  return <TemplatesPage onUseTemplate={(t) => openBuilder(t.preset)} />;
}

type SidebarId = 'deployments' | 'templates' | 'logs' | 'keys' | 'usage' | 'docs' | 'support';

function pathToSidebarId(pathname: string): SidebarId {
  if (pathname.startsWith('/templates')) return 'templates';
  if (pathname.startsWith('/logs')) return 'logs';
  if (pathname.startsWith('/keys')) return 'keys';
  if (pathname.startsWith('/usage')) return 'usage';
  if (pathname.startsWith('/docs')) return 'docs';
  if (pathname.startsWith('/support')) return 'support';
  return 'deployments';
}

function sidebarIdToPath(id: SidebarId): string {
  return id === 'deployments' ? '/functions' : `/${id}`;
}
