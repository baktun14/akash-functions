import { type ReactElement } from 'react';
import { Canvas } from '../components/canvas/Canvas';
import { useLayout } from '../App';

export function FunctionsPage(): ReactElement {
  const { services, openBuilder, refresh } = useLayout();

  // The records mix both kinds; show only long-lived functions here — Python
  // GPU jobs have their own sidebar section. "New function" likewise offers only
  // service presets (no Python).
  const functions = services.filter((s) => s.kind === 'function');

  return (
    <Canvas
      services={functions}
      onNewFunction={() => openBuilder('rest', { presets: ['rest', 'jsx', 'cron', 'gpu'] })}
      onRefresh={refresh}
    />
  );
}
