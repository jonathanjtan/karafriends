# Dev server / remocon whitescreen investigation

Two separate dev-tooling bugs made the remocon render a **blank page**, each of
which burned a lot of time because the symptom (whitescreen) looks like an app
bug but is actually in the serve/proxy layer. This doc exists so the next
person recognizes it in minutes, not hours.

## The 30-second diagnostic

When the remocon whitescreens, **first decide whether it's app code or the
serve/proxy layer** before reading any React source:

```sh
# 1. What bundle does the served index reference?
curl -s http://localhost:8080/ | grep -oE 'remocon\.[a-z0-9]+\.js'

# 2. Does that path actually return JavaScript?
curl -s -o /dev/null -w '%{content_type} %{size_download}\n' \
  http://localhost:8080/remocon.<hash>.js
```

- **`application/javascript` (~20 MB in dev):** the bundle is served fine — the
  problem _is_ app code (failed query with no error boundary, `window.prompt`
  in a headless context, etc. — see the CLAUDE.md remocon-blank gotcha).
- **`text/html`:** the `<script>` is being served an HTML page, so the bundle
  **never executes**. This is a serve/proxy routing bug, _not_ app code. Tell-
  tale signs in the browser: `#root` has 0 children, **no console error**, and
  **no GraphQL POST** ever fires (the app dies before its first query). Don't
  bother reading components — go to the two bugs below.

## Bug 1: reverse-proxy `/remocon` filename collision (fixed: `ba397e27`)

`src/main/middleware/remoconReverseProxy.ts` prefixed non-target paths with
`/remocon` to route them to the remocon target, guarding with
`req.path.startsWith("/remocon")`. But the bundle is named `remocon.<hash>.js`,
so that guard **also matched the filename** and skipped the prefix — fetching
`:3000/remocon.<hash>.js` (parcel's SPA-fallback HTML) instead of
`:3000/remocon/remocon.<hash>.js` (the real bundle).

Fix: require a trailing slash (`startsWith("/remocon/")`) so the directory
check can't match the filename.

It surfaced only intermittently because a browser-cached bundle masked it until
a rebuild churned the hash to one the browser hadn't cached.

## Bug 2: `parcel serve` multi-target collision (fixed: `c30b2499`)

`run-dev` used to `parcel build` all targets into `build/dev`, then
`parcel serve --target remocon --target renderer --dist-dir build/dev`. Two
independent parcel builds writing the same dir collide:

- `parcel serve` runs its **own** in-memory HMR build that **hashes the same
  source differently** than `parcel build` (it wraps modules for HMR), **hoists
  the remocon bundle to the server root** (`:3000/remocon.<hash>.js` is JS, but
  `:3000/remocon/remocon.<hash>.js` is a 404 HTML page), and **overwrites the
  on-disk `build/dev/remocon/index.html`** to reference that root-hosted hash.
- The reverse proxy (and the on-disk `--public-url .` build) expect the remocon
  self-contained under `/remocon/`. So the proxy fetches a hash that only
  exists at the root → HTML → whitescreen.

Historically it "worked" as a **race**: the browser loaded the consistent disk
build before `parcel serve` overwrote the index. Anything that perturbed timing
(clearing `.parcel-cache`, a rebuild) tipped it into the broken window.

No `parcel serve` flag fixes this (`--public-url .` made it worse — the bundle
404'd everywhere). The fix removes `parcel serve` entirely:

- `parcel watch --target remocon --target renderer --dist-dir build/dev
--public-url .` rebuilds the **self-consistent** on-disk build on change.
- `scripts/devStaticServer.mjs` serves `build/dev` statically on :3000.

The reverse proxy's `/remocon/` assumption then holds with no code changes.
**Trade-off: no HMR** — `parcel watch` only rebuilds to disk; reload the page to
pick up changes. `graphql-ws` lives on :8080 (the app), so nothing on the
websocket side is lost.

## Why it was slow to solve (and how to be faster)

- The symptom is a whitescreen, which pattern-matches to "React bug" — but the
  diagnostic above distinguishes app-vs-tooling in 30 seconds. Run it _first_.
- The preview browser's console capture didn't surface the throw (there was no
  throw — the bundle just never ran). "No console error + no network request +
  empty `#root`" is the signature of _bundle-never-executed_, which points at
  serving, not code.
- `curl`-probing the actual content-type of the referenced bundle at both
  `:8080` (through the proxy) and `:3000` (parcel directly), and comparing
  `/remocon/<file>` vs `/<file>` (root), is what actually localized it.
