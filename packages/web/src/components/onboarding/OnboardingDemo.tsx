// Onboarding hero demo — faux IDE/terminal pair. A code card on top, a deploy
// log below. Loops forever: log lines reveal one at a time, hold on the final
// "live → URL" frame, then fade out and restart. CSS transitions on a single
// `is-shown` class flipped by React state — no animation library.

import { useEffect, useState, type ReactNode } from 'react';

const CODE = `import { Hono } from 'hono';

const app = new Hono();
app.get('/', (c) =>
  c.json({ hello: 'Akash' })
);

Bun.serve({ fetch: app.fetch });`;

const STEPS: { text: string; tone?: 'live' }[] = [
  { text: '→ packaging' },
  { text: '→ uploading' },
  { text: '→ starting' },
  { text: '✓ live → https://greet-fn.akash.network', tone: 'live' },
];

const PROMPT = '$ deploy greet.ts';

export function OnboardingDemo() {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const delay =
      step === 0 ? 1500
      : step === STEPS.length ? 3200
      : 950;
    const next = (step + 1) % (STEPS.length + 1);
    const t = setTimeout(() => setStep(next), delay);
    return () => clearTimeout(t);
  }, [step]);

  return (
    <div className="onboarding-demo">
      <div className="onboarding-demo__card">
        <div className="onboarding-demo__topbar">
          <span className="onboarding-demo__dot" />
          <span className="onboarding-demo__dot" />
          <span className="onboarding-demo__dot" />
          <span className="onboarding-demo__filename">greet.ts</span>
        </div>
        <div className="onboarding-demo__code code-block">
          {CODE.split('\n').map((line, i) => (
            <div key={i} style={{ whiteSpace: 'pre' }}>
              {line.length === 0 ? ' ' : renderJsLine(line)}
            </div>
          ))}
        </div>
      </div>

      <div className="onboarding-demo__log">
        <div className="onboarding-demo__log-prompt">{PROMPT}</div>
        {STEPS.map((s, i) => (
          <div
            key={i}
            className={
              'onboarding-demo__log-line' +
              (step > i ? ' is-shown' : '') +
              (s.tone === 'live' ? ' is-live' : '')
            }
          >
            {s.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function renderJsLine(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = '';
  let i = 0;
  let key = 0;
  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = '';
    }
  };

  while (i < line.length) {
    if (line.startsWith('//', i)) {
      flush();
      out.push(
        <span key={key++} className="tok-c">
          {line.slice(i)}
        </span>
      );
      return out;
    }
    const ch = line[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = line.indexOf(ch, i + 1);
      if (end !== -1) {
        flush();
        out.push(
          <span key={key++} className="tok-s">
            {line.slice(i, end + 1)}
          </span>
        );
        i = end + 1;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}
