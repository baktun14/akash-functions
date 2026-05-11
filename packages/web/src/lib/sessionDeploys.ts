// Tracks deploy lifecycle within the current browser session. Survives
// component unmounts (in-session navigation list → detail → list → detail)
// but resets on hard reload — exactly the lifetime we want for "did the
// user just start a deploy here, so the post-deploy ingress probe should
// run?". `confirmed` lets a fnId opt out of re-probing once we've already
// observed its ingress as reachable this session.

const initiated = new Set<string>();
const confirmedReachable = new Set<string>();

export const sessionDeploys = {
  mark(fnId: string): void {
    initiated.add(fnId);
    confirmedReachable.delete(fnId);
  },
  was(fnId: string): boolean {
    return initiated.has(fnId);
  },
  confirm(fnId: string): void {
    confirmedReachable.add(fnId);
  },
  confirmed(fnId: string): boolean {
    return confirmedReachable.has(fnId);
  },
  clear(fnId: string): void {
    initiated.delete(fnId);
    confirmedReachable.delete(fnId);
  },
};
