export type Route =
  | { kind: 'directory' }
  | { kind: 'admin-netease' }
  | { kind: 'admin-emotes' }
  | { kind: 'room'; roomId: string };
// Explicit room links/choices take precedence over a newly created home room.
export function accountEntryRoute(
  current: Route,
  createdRoom?: { number: number },
): Route {
  if (current.kind !== 'directory' || !createdRoom) return current;
  return { kind: 'room', roomId: String(createdRoom.number) };
}
export function roomPath(roomId: string, number?: number) {
  if (number !== undefined) return `/${number}`;
  if (/^[1-9]\d*$/.test(roomId) && Number.isSafeInteger(Number(roomId)))
    return `/${roomId}`;
  return `/rooms/${encodeURIComponent(roomId)}`;
}
export function routeFor(path: string): Route {
  if (/^\/admin\/netease\/?$/.test(path)) return { kind: 'admin-netease' };
  if (/^\/admin\/emotes\/?$/.test(path)) return { kind: 'admin-emotes' };
  const numeric = /^\/([1-9]\d*)\/?$/.exec(path);
  if (numeric && Number.isSafeInteger(Number(numeric[1])))
    return { kind: 'room', roomId: numeric[1]! };
  const match = /^\/rooms\/([^/]+)\/?$/.exec(path);
  if (match) {
    try {
      const roomId = decodeURIComponent(match[1]!);
      if (roomId && !roomId.includes('/')) return { kind: 'room', roomId };
    } catch {
      /* Malformed paths return to the directory. */
    }
  }
  return { kind: 'directory' };
}
export interface NavigationHost {
  location: { pathname: string };
  history: {
    pushState(data: unknown, unused: string, url: string): void;
    replaceState(data: unknown, unused: string, url: string): void;
  };
  addEventListener(name: 'popstate', listener: () => void): void;
  removeEventListener(name: 'popstate', listener: () => void): void;
}
// State admission belongs to the caller: the address changes only after entry succeeds.
export function createNavigation(
  host: NavigationHost,
  pop: (route: Route) => void,
) {
  const listener = () => pop(routeFor(host.location.pathname));
  host.addEventListener('popstate', listener);
  return {
    current: () => routeFor(host.location.pathname),
    write(route: Route, replace = false) {
      host.history[replace ? 'replaceState' : 'pushState'](
        null,
        '',
        route.kind === 'room'
          ? roomPath(route.roomId)
          : route.kind === 'admin-netease'
            ? '/admin/netease'
            : route.kind === 'admin-emotes'
              ? '/admin/emotes'
              : '/',
      );
    },
    close: () => host.removeEventListener('popstate', listener),
  };
}
