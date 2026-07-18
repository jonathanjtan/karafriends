// Avatar URLs picked from the local portrait mirror are stored host-relative
// ("/portraits/...") so any client can resolve them against the karafriends
// server it already talks to: the remocon is served by that same origin (or
// behind a proxy that forwards absolute paths, same as /graphql), while the
// Electron renderer — loaded from file:// in prod — must prefix the local
// server explicitly. Avatars picked before the local mirror existed are
// absolute raw.githubusercontent.com URLs and pass through untouched.
export function resolveProfilePictureUrl(url: string): string {
  if (!url.startsWith("/") || window.karafriends === undefined) {
    return url;
  }
  return `http://localhost:${
    window.karafriends.karafriendsConfig().remoconPort
  }${url}`;
}
