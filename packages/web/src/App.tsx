// Top-level App: routes between Onboarding ↔ shell; manages session, services,
// modals, banner, toasts.

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { CodeSample, FunctionRecord, PresetId, Session, ToastMsg } from '@shared/types';
import { Sidebar } from './components/shell/Sidebar';
import { TopBar } from './components/shell/TopBar';
import { ExpiredBanner } from './components/shell/ExpiredBanner';
import { Onboarding } from './components/onboarding/Onboarding';
import { Canvas } from './components/canvas/Canvas';
import { ServicePanel } from './components/service-panel/ServicePanel';
import { TemplatesPage } from './components/templates/TemplatesPage';
import { FunctionBuilder } from './components/builder/FunctionBuilder';
import { Toast } from './components/ui/Toast';
import { Icon } from './components/icons';
import { api } from './lib/api';

type View = 'deployments' | 'templates' | 'logs' | 'keys' | 'usage' | 'docs' | 'support';

export default function App(): ReactElement {
  const [session, setSession] = useState<Session | null>(() => api.getSession());
  const [services, setServices] = useState<FunctionRecord[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<View>('deployments');
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderPreset, setBuilderPreset] = useState<PresetId | null>(null);
  const [toast, setToast] = useState<ToastMsg | null>(null);
  const [expired, setExpired] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  // Load services whenever session changes.
  useEffect(() => {
    if (!session) {
      setServices([]);
      return;
    }
    let cancelled = false;
    api.listServices().then((list) => {
      if (!cancelled) setServices(list);
    });
    return () => {
      cancelled = true;
    };
  }, [session]);

  // ?expired=1 banner on mount.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('expired') === '1' && session) setExpired(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = useMemo(
    () => services.find((s) => s.id === activeId) ?? null,
    [services, activeId]
  );

  const handleConnect = (sess: Session) => {
    setSession(sess);
    setExpired(false);
    setReconnecting(false);
  };

  const handleDisconnect = () => {
    api.disconnect();
    setSession(null);
    setActiveId(null);
    setBuilderOpen(false);
  };

  const handleDeploy = async (sample: CodeSample) => {
    const svc = await api.deploy(sample);
    setServices((cur) => [...cur, svc]);
    setBuilderOpen(false);
    setToast({ kind: 'ok', text: `Deployment successful · ${svc.name} is live` });
    setTimeout(() => setToast(null), 4500);
  };

  if (!session || reconnecting) {
    return <Onboarding onConnect={handleConnect} />;
  }

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
        active={view}
        onSelect={(id) => {
          if (id === 'deployments' || id === 'templates') {
            setView(id);
            setActiveId(null);
          } else {
            setView(id);
          }
        }}
        onDeploy={() => {
          setBuilderPreset(null);
          setBuilderOpen(true);
        }}
      />

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <TopBar
          session={session}
          expired={expired}
          onDisconnect={handleDisconnect}
          onReconnect={() => setReconnecting(true)}
          onOpenAgent={() => {
            setBuilderPreset(null);
            setBuilderOpen(true);
          }}
        />

        <div style={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative' }}>
          <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
            {view === 'deployments' && (
              <>
                <Canvas
                  services={services}
                  selectedId={activeId}
                  onSelect={(id) => setActiveId(id)}
                />
                <button
                  onClick={() => {
                    setBuilderPreset(null);
                    setBuilderOpen(true);
                  }}
                  className="btn btn-subtle btn-sm"
                  style={{
                    position: 'absolute',
                    top: 18,
                    right: 24,
                    zIndex: 5,
                    gap: 6,
                  }}
                >
                  <Icon name="plus" size={13} /> New function
                </button>
              </>
            )}

            {view === 'templates' && (
              <TemplatesPage
                onUseTemplate={(t) => {
                  setBuilderPreset(t.preset);
                  setBuilderOpen(true);
                }}
              />
            )}

            {(view === 'logs' || view === 'keys' || view === 'usage' ||
              view === 'docs' || view === 'support') && (
              <PlaceholderView label={labelFor(view)} />
            )}
          </div>

          {view === 'deployments' && active && (
            <ServicePanel
              svc={active}
              session={session}
              onClose={() => setActiveId(null)}
            />
          )}

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

function labelFor(view: View): string {
  switch (view) {
    case 'logs':    return 'Logs';
    case 'keys':    return 'API keys';
    case 'usage':   return 'Usage';
    case 'docs':    return 'Documentation';
    case 'support': return 'Support';
    default:        return '';
  }
}

function PlaceholderView({ label }: { label: string }) {
  return (
    <div
      className="page-in"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: 8,
        color: 'var(--fg-muted)',
      }}
    >
      <div className="eyebrow">Coming soon</div>
      <div style={{ fontSize: 24, fontWeight: 600, color: 'var(--fg)', letterSpacing: '-0.015em' }}>
        {label}
      </div>
      <div style={{ fontSize: 13, maxWidth: 360, textAlign: 'center' }}>
        This view is on the roadmap. For now, manage everything from the Functions list.
      </div>
    </div>
  );
}
