// Lightweight, regex-only sanity checks for function source.
//
// The agent occasionally emits code that combines `Bun.serve(...)` with
// `export default app` — both alone are valid in this runtime, but together
// they crash at startup with EADDRINUSE on port 3001 because Bun's runtime
// auto-serves the default export on top of the explicit Bun.serve. We surface
// the conflict before the user deploys so they can fix it (or ask the agent
// to fix it).

export type StartupIssue = {
  kind: 'double-server-start';
  message: string;
  /** Pre-canned instruction we hand to the agent when the user clicks
   *  "Quick fix with agent". Includes enough context for the model to
   *  produce a corrected full-file rewrite. */
  agentPrompt: string;
};

const DOUBLE_SERVER_MESSAGE =
  'This file calls Bun.serve(…) AND has an `export default`. Bun will auto-serve the default export on top of the explicit Bun.serve, causing EADDRINUSE on port 3001 at startup. Remove one — the canonical pattern is to keep Bun.serve(…) and delete the default export.';

const DOUBLE_SERVER_AGENT_PROMPT =
  'The current file has a server-start conflict: it calls `Bun.serve(...)` AND has an `export default app` (or `export default { fetch }`). Bun auto-serves the default export, which collides with the explicit Bun.serve on port 3001 and crashes the function at startup with EADDRINUSE. Please rewrite the file to remove the `export default` line and keep the `Bun.serve({ port: import.meta.env.PORT ?? 3000, fetch: app.fetch })` call. Emit the full corrected file in a single fenced ```ts block.';

export function detectStartupIssue(code: string): StartupIssue | null {
  const hasBunServe = /\bBun\.serve\s*\(/.test(code);
  // `export default app` (Hono app, etc.) or `export default { ... fetch ... }`.
  // Plain default exports of values without a `fetch` property are fine because
  // Bun won't auto-serve them — but they're rare enough in this context that
  // a broad `export default` match keeps the rule legible. We accept the
  // false-positive trade-off; the warning is non-blocking.
  const hasDefaultExport = /^[ \t]*export\s+default\s+/m.test(code);

  if (hasBunServe && hasDefaultExport) {
    return {
      kind: 'double-server-start',
      message: DOUBLE_SERVER_MESSAGE,
      agentPrompt: DOUBLE_SERVER_AGENT_PROMPT,
    };
  }
  return null;
}

// Restrict the chat-side check to TS/JS code blocks. `splitMessage` puts the
// language tag in `lang` (e.g. "ts", "tsx", "typescript", "" for no tag). We
// accept all of those — the model frequently omits the tag.
export function detectStartupIssueInFencedBlock(
  code: string,
  lang: string
): StartupIssue | null {
  if (lang && !/^(ts|tsx|typescript|js|jsx|javascript)$/i.test(lang)) return null;
  return detectStartupIssue(code);
}
