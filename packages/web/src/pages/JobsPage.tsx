import { type ReactElement } from 'react';
import { JobsList } from '../components/jobs/JobsList';
import { useLayout } from '../App';

export function JobsPage(): ReactElement {
  const { services, openBuilder } = useLayout();
  const jobs = services.filter((s) => s.kind === 'python-job');

  // "New job" opens the same builder modal, locked to the python preset (the
  // only job-creating preset). Service presets stay on the Functions page.
  return (
    <JobsList
      jobs={jobs}
      onNewJob={() => openBuilder('python', { presets: ['python'] })}
    />
  );
}
