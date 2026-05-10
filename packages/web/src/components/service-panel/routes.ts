// Path-parameter helpers shared by route-aware UI:
// `UseThisFunction` (substitutes placeholders inside snippet URLs) and
// `RoutesPanel` (decides whether a route is safely openable in a new tab).

const PATH_PARAM_RE = /(:[a-zA-Z_][a-zA-Z0-9_]*|\{[^}]+\})/;

export function hasPathParam(path: string): boolean {
  return PATH_PARAM_RE.test(path);
}

export function concretePath(path: string): { url: string; hadParam: boolean } {
  let hadParam = false;
  const url = path.replace(new RegExp(PATH_PARAM_RE.source, 'g'), () => {
    hadParam = true;
    return '123';
  });
  return { url, hadParam };
}
