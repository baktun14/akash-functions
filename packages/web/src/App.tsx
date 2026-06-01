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
import type {
  CodeSample,
  CreateAndRunRequest,
  DeploymentRecord,
  FunctionRecord,
  FunctionVersionDetail,
  PresetId,
  ResourceRequest,
  RunRecord,
  Session,
  ToastMsg,
  WaitForCapacityRequest,
} from '@shared/types';
import { Sidebar } from './components/shell/Sidebar';
import { TopBar } from './components/shell/TopBar';
import { ExpiredBanner } from './components/shell/ExpiredBanner';
import { Onboarding } from './components/onboarding/Onboarding';
import { TemplatesPage } from './components/templates/TemplatesPage';
import { FunctionBuilder } from './components/builder/FunctionBuilder';
import { FunctionEditor } from './components/builder/FunctionEditor';
import { Toast } from './components/ui/Toast';
import { ActiveEditorProvider } from './components/agent/ActiveEditorContext';
import { AgentPanel } from './components/agent/AgentPanel';
import { ApiKeysPage } from './pages/ApiKeysPage';
import { FunctionsPage } from './pages/FunctionsPage';
import { JobsPage } from './pages/JobsPage';
import { FunctionDetailPage } from './pages/FunctionDetailPage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { useFunctions } from './lib/useFunctions';
import { sessionDeploys } from './lib/sessionDeploys';
import { api } from './lib/api';

type OpenBuilderOpts = { preset?: PresetId | null; initialSource?: string | null; presets?: PresetId[] };

type LayoutContext = {
  session: Session;
  services: FunctionRecord[];
  setLocal: (next: FunctionRecord[] | ((prev: FunctionRecord[]) => FunctionRecord[])) => void;
  refresh: () => Promise<void>;
  openBuilder: (preset?: PresetId | null, opts?: OpenBuilderOpts) => void;
  openEditor: (fnId: string) => void;
  // True while openEditor is fetching the latest version. Lets the
  // "Edit in builder" trigger show a loading state until the modal mounts.
  editorLoading: boolean;
  // Tick that bumps after a save/restore so subscribed tabs (Source Code,
  // History) re-fetch their version data without prop-drilling.
  versionRev: number;
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
        <Route path="/jobs" element={<JobsPage />} />
        <Route path="/jobs/:id" element={<FunctionDetailPage />} />
        <Route path="/templates" element={<TemplatesPageRoute />} />
        <Route path="/logs" element={<PlaceholderPage label="Logs" />} />
        <Route path="/keys" element={<ApiKeysPage />} />
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
  const [builderInitialSource, setBuilderInitialSource] = useState<string | null>(null);
  // Restricts the builder's preset picker (e.g. service presets for "New
  // function", python-only for "New job"). undefined = all presets allowed.
  const [builderPresets, setBuilderPresets] = useState<PresetId[] | undefined>(undefined);
  const [editorTarget, setEditorTarget] = useState<
    { fnId: string; detail: FunctionVersionDetail } | null
  >(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [versionRev, setVersionRev] = useState(0);
  const [toast, setToast] = useState<ToastMsg | null>(null);
  const [expired, setExpired] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentPendingPrompt, setAgentPendingPrompt] = useState<string | null>(null);

  // Editor's "Quick fix with agent" affordance funnels through here: ensure
  // the panel is mounted, then queue the prompt for the panel to consume.
  const requestAgentFix = (prompt: string) => {
    setAgentOpen(true);
    setAgentPendingPrompt(prompt);
  };

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

  const openBuilder = (preset: PresetId | null = null, opts?: OpenBuilderOpts) => {
    setBuilderPreset(opts?.preset ?? preset);
    setBuilderInitialSource(opts?.initialSource ?? null);
    setBuilderPresets(opts?.presets);
    setBuilderOpen(true);
  };

  // Agent's "Use as new function" lands here: open the builder seeded with the
  // generated code.
  const openBuilderWithSource = (code: string) => {
    setBuilderPreset(null);
    setBuilderInitialSource(code);
    setBuilderPresets(undefined);
    setBuilderOpen(true);
  };

  // Pre-loads the latest version so the editor opens with the source already
  // populated — avoids a flash of empty editor while fetching.
  const openEditor = async (fnId: string) => {
    if (editorLoading || editorTarget) return;
    setEditorLoading(true);
    try {
      const detail = await api.getLatestVersion(fnId);
      setEditorTarget({ fnId, detail });
    } catch (err) {
      setToast({ kind: 'error', text: `Failed to open editor: ${(err as Error).message}` });
      setTimeout(() => setToast(null), 4000);
    } finally {
      setEditorLoading(false);
    }
  };

  const handleEditorSaved = (_versionId: string) => {
    setEditorTarget(null);
    setVersionRev((r) => r + 1);
    setToast({ kind: 'ok', text: 'Saved a new version' });
    setTimeout(() => setToast(null), 3500);
  };

  const handleEditorSavedAndDeployed = (_versionId: string, dep: DeploymentRecord) => {
    setEditorTarget(null);
    setVersionRev((r) => r + 1);
    // Reflect the new deployment id on the function row so DeploymentsTab can
    // poll right away.
    if (editorTarget) {
      setLocal((cur) =>
        cur.map((s) =>
          s.id === editorTarget.fnId
            ? { ...s, deploymentId: dep.id, latestDeploymentId: dep.id, status: 'pending' }
            : s
        )
      );
      sessionDeploys.mark(editorTarget.fnId);
    }
    setToast({ kind: 'ok', text: 'Saved & deploying new version…' });
    setTimeout(() => setToast(null), 3500);
    refresh().catch(() => undefined);
  };

  // python-job editor "Save & run": a fresh run of the new version was started.
  // Bumping versionRev signals the mounted RunPanel to reload its run list and
  // jump to the new run, so the user sees it stream without a manual refresh.
  const handleEditorSavedAndRun = (_versionId: string, run: RunRecord) => {
    setEditorTarget(null);
    setVersionRev((r) => r + 1);
    if (editorTarget) {
      setLocal((cur) =>
        cur.map((s) =>
          s.id === editorTarget.fnId
            ? { ...s, deploymentId: run.runId, latestDeploymentId: run.runId, status: 'pending' }
            : s
        )
      );
      sessionDeploys.mark(editorTarget.fnId);
    }
    setToast({ kind: 'ok', text: 'Saved & running new version…' });
    setTimeout(() => setToast(null), 3500);
    refresh().catch(() => undefined);
  };

  const handleDeploy = async (
    sample: CodeSample,
    customResources?: ResourceRequest,
    envVars?: Record<string, string>,
    opts?: WaitForCapacityRequest,
  ) => {
    try {
      const svc = await api.deploy(sample, customResources, envVars, opts);
      // Optimistically reflect the waiting state so the card doesn't flash
      // "Deploying" before the first poll when delayed start is on.
      const optimistic = opts?.waitForCapacity ? { ...svc, status: 'waiting' as const } : svc;
      setLocal((cur) => [optimistic, ...cur.filter((s) => s.id !== optimistic.id)]);
      sessionDeploys.mark(svc.id);
      setBuilderOpen(false);
      setToast({
        kind: 'ok',
        text: opts?.waitForCapacity ? `Waiting for capacity for ${svc.name}…` : `Deploying ${svc.name}…`,
      });
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

  // Python-job "Run" path: create function + first version + first run in one
  // shot, push the new python-job into local state, and navigate to its
  // RunPanel so the user watches logs stream live.
  const handleRun = async (body: CreateAndRunRequest) => {
    try {
      const run = await api.createAndRun(body);
      const svc: FunctionRecord = {
        id: run.functionId,
        name: body.name,
        kind: 'python-job',
        image: 'ghcr.io/akash-network/python-runner',
        status: body.waitForCapacity ? 'waiting' : 'pending',
        deploymentId: run.runId,
        latestDeploymentId: run.runId,
      };
      setLocal((cur) => [svc, ...cur.filter((s) => s.id !== svc.id)]);
      sessionDeploys.mark(svc.id);
      setBuilderOpen(false);
      setToast({
        kind: 'ok',
        text: body.waitForCapacity ? `Waiting for a GPU for ${body.name}…` : `Running ${body.name}…`,
      });
      setTimeout(() => setToast(null), 3500);
      // Land inside the Jobs section so the sidebar highlights Jobs and the new
      // run shows up under Jobs (not Functions).
      navigate(`/jobs/${svc.id}`);
      refresh().catch(() => undefined);
    } catch (err) {
      setBuilderOpen(false);
      setToast({ kind: 'error', text: `Run failed: ${(err as Error).message}` });
      setTimeout(() => setToast(null), 6000);
    }
  };

  const sidebarActive = pathToSidebarId(location.pathname);

  const ctx: LayoutContext = {
    session,
    services,
    setLocal,
    refresh,
    openBuilder,
    openEditor,
    editorLoading,
    versionRev,
  };

  // Builder modal's grid is told whether to include the agent slot. When the
  // agent is open AND the builder is mounted, the builder takes 3 columns
  // (editor | side | agent) and renders the panel inside it. When the agent is
  // open but no modal is mounted, the panel renders as a sibling of <Outlet/>.
  const builderHostsAgent = builderOpen && agentOpen;
  const editorHostsAgent = !!editorTarget && agentOpen;
  const agentInModal = builderHostsAgent || editorHostsAgent;

  const agentPanelEl = agentOpen && (
    <AgentPanel
      onClose={() => setAgentOpen(false)}
      onUseAsNewFunction={openBuilderWithSource}
      pendingPrompt={agentPendingPrompt}
      onPendingPromptConsumed={() => setAgentPendingPrompt(null)}
    />
  );

  return (
    <ActiveEditorProvider>
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
        />

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <TopBar
            session={session}
            expired={expired}
            onDisconnect={handleDisconnect}
            onReconnect={() => setReconnecting(true)}
            onOpenAgent={() => setAgentOpen((o) => !o)}
          />

          <div style={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative' }}>
            <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
              <Outlet context={ctx} />
            </div>

            {/* Page-level dock — only when agent is open AND no modal is up. */}
            {agentOpen && !agentInModal && agentPanelEl}

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
                presets={builderPresets}
                initialSource={builderInitialSource}
                onClose={() => setBuilderOpen(false)}
                onDeploy={handleDeploy}
                onRun={handleRun}
                agentSlot={builderHostsAgent ? agentPanelEl : null}
                agentOpen={agentOpen}
                onOpenAgent={() => setAgentOpen(true)}
              />
            )}
            {editorTarget && (
              <FunctionEditor
                functionId={editorTarget.fnId}
                functionName={
                  services.find((s) => s.id === editorTarget.fnId)?.name ?? 'function'
                }
                kind={services.find((s) => s.id === editorTarget.fnId)?.kind ?? 'function'}
                initialDetail={editorTarget.detail}
                hasActiveDeployment={
                  services.find((s) => s.id === editorTarget.fnId)?.status === 'online' ||
                  services.find((s) => s.id === editorTarget.fnId)?.status === 'pending'
                }
                onClose={() => setEditorTarget(null)}
                onSaved={handleEditorSaved}
                onSavedAndDeployed={handleEditorSavedAndDeployed}
                onSavedAndRun={handleEditorSavedAndRun}
                agentSlot={editorHostsAgent ? agentPanelEl : null}
                agentOpen={agentOpen}
                onOpenAgent={() => setAgentOpen(true)}
                onAgentFix={requestAgentFix}
              />
            )}
            {toast && <Toast toast={toast} />}
          </div>
        </div>
      </div>
    </ActiveEditorProvider>
  );
}

function TemplatesPageRoute(): ReactElement {
  const { openBuilder } = useLayout();
  return <TemplatesPage onUseTemplate={(t) => openBuilder(t.preset)} />;
}

type SidebarId = 'deployments' | 'jobs' | 'templates' | 'logs' | 'keys' | 'usage' | 'docs' | 'support';

function pathToSidebarId(pathname: string): SidebarId {
  if (pathname.startsWith('/jobs')) return 'jobs';
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
