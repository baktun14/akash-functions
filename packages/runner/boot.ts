// Akash Functions runner boot — fetches source, installs deps, spawns user code.
//
// Required env vars (injected via SDL by the backend at deploy time):
//   FUNCTION_ID    — opaque function identifier
//   VERSION_ID     — opaque code version
//   CODE_URL       — backend endpoint that returns a tar.gz of the source
//   CODE_TOKEN     — short-lived HMAC token; sent both as ?t= and Bearer
//   PORT           — port the user code should listen on (default 3000)
//   AKASHML_API_KEY (optional) — passed through to user code as-is
//
// Lifecycle: this script blocks until user code exits, propagates SIGTERM/SIGINT,
// and exits with the same code so the Akash provider can handle restarts.

const { FUNCTION_ID, VERSION_ID, CODE_URL, CODE_TOKEN, PORT } = process.env;

if (!FUNCTION_ID || !VERSION_ID || !CODE_URL || !CODE_TOKEN) {
  console.error('[boot] missing one of FUNCTION_ID, VERSION_ID, CODE_URL, CODE_TOKEN');
  process.exit(1);
}

console.log(`[boot] fetching source for ${FUNCTION_ID}@${VERSION_ID}`);

const url = new URL(CODE_URL);
url.searchParams.set('t', CODE_TOKEN);

const res = await fetch(url, {
  headers: { Authorization: `Bearer ${CODE_TOKEN}` },
});

if (!res.ok) {
  console.error(`[boot] code fetch failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}

// Stream tar.gz into `tar -xz -C /app`.
const tar = Bun.spawn(['tar', '-xz', '-C', '/app'], {
  stdin: 'pipe',
  stdout: 'inherit',
  stderr: 'inherit',
});

const writer = tar.stdin;
const reader = res.body?.getReader();
if (!reader) {
  console.error('[boot] no response body');
  process.exit(1);
}

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  writer.write(value);
}
await writer.end();

const tarExit = await tar.exited;
if (tarExit !== 0) {
  console.error(`[boot] tar exited with code ${tarExit}`);
  process.exit(1);
}
console.log('[boot] source extracted to /app');

// Install dependencies if a package.json was shipped.
const pkgJson = Bun.file('/app/package.json');
if (await pkgJson.exists()) {
  console.log('[boot] running bun install');
  const install = Bun.spawn(['bun', 'install', '--production'], {
    cwd: '/app',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const installExit = await install.exited;
  if (installExit !== 0) {
    console.error(`[boot] bun install exited with code ${installExit}`);
    process.exit(1);
  }
}

// Pick the entry point. Prefer src/index.ts, then index.ts.
const candidates = ['/app/src/index.ts', '/app/index.ts', '/app/src/index.tsx', '/app/index.tsx'];
let entry: string | undefined;
for (const c of candidates) {
  if (await Bun.file(c).exists()) {
    entry = c;
    break;
  }
}
if (!entry) {
  console.error(`[boot] no entry point found. Tried: ${candidates.join(', ')}`);
  process.exit(1);
}

console.log(`[boot] starting user code at ${entry} on port ${PORT ?? 3000}`);

const child = Bun.spawn(['bun', entry], {
  cwd: '/app',
  stdout: 'inherit',
  stderr: 'inherit',
  env: { ...process.env, PORT: PORT ?? '3000' },
});

const forward = (sig: NodeJS.Signals) => {
  console.log(`[boot] forwarding ${sig}`);
  child.kill(sig);
};
process.on('SIGTERM', () => forward('SIGTERM'));
process.on('SIGINT', () => forward('SIGINT'));

const exitCode = await child.exited;
console.log(`[boot] user code exited with code ${exitCode}`);
process.exit(exitCode ?? 0);
