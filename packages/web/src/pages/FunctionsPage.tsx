import { type ReactElement } from 'react';
import { Canvas } from '../components/canvas/Canvas';
import { Icon } from '../components/icons';
import { useLayout } from '../App';

export function FunctionsPage(): ReactElement {
  const { services, openBuilder } = useLayout();

  return (
    <>
      <Canvas services={services} />
      <button
        onClick={() => openBuilder(null)}
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
  );
}
