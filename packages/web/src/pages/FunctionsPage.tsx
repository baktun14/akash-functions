import { type ReactElement } from 'react';
import { Canvas } from '../components/canvas/Canvas';
import { useLayout } from '../App';

export function FunctionsPage(): ReactElement {
  const { services, openBuilder, refresh } = useLayout();

  return (
    <Canvas
      services={services}
      onNewFunction={() => openBuilder(null)}
      onRefresh={refresh}
    />
  );
}
