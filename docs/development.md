# Development

This page walks through getting karafriends to build from a clean
checkout. The intended platform is Windows, macOS, or Linux on x86_64;
the project has historically been developed primarily on macOS.

## Prerequisites

You need:

- **Yarn** (the package manager). Karafriends pins itself to Yarn 4.x via
  the `packageManager` field in `package.json`, so any recent
  Corepack-enabled Node.js install will pick the right version
  automatically. Node 20 or newer is fine.
- **Rust** (the systems programming language) plus Cargo, its build tool.
  Install via [rustup](https://rustup.rs/). A stable toolchain is enough
  for builds; the test target uses nightly with `cargo-careful`.
- A working **C/C++ toolchain** for the system you're on:
  - Windows: Visual Studio Build Tools with the "Desktop development with
    C++" workload.
  - macOS: Xcode command-line tools (`xcode-select --install`).
  - Linux: `build-essential` or your distro's equivalent, plus
    `libasound2-dev` (or `alsa-lib-devel` on RPM-based distros) for the
    audio backend.
- An **internet connection** during the first build, because the build
  downloads `yt-dlp` and `ffmpeg` (and on Windows, Steinberg's ASIO SDK).

You do _not_ need anything from Anthropic, OpenAI, DAM, or JOYSOUND to
get the app _building_. Credentials only matter at runtime when you
actually queue a DAM/JOYSOUND song.

## Cloning

The repo has a large history. The README recommends a shallow clone:

```sh
git clone --depth 1 https://github.com/emmaworley/karafriends.git
cd karafriends
```

A shallow clone gets you the latest snapshot only; if you later need
full history (e.g., to write commits with `git blame`-aware tooling) you
can deepen with `git fetch --unshallow`.

## First run

```sh
yarn install
yarn run-dev
```

`yarn install` does two things: installs Node packages using Yarn's
"Plug'n'Play" mode (no `node_modules` folder — Yarn keeps everything
zipped under `.yarn/cache/`), and registers Husky's Git hooks for
linting on commit.

`yarn run-dev` does a lot more:

1. **`get-external-resources`** — downloads `yt-dlp`, `ffmpeg`, and on
   Windows the ASIO SDK, into `extraResources/` and `buildResources/`.
   This is skipped on subsequent runs once the files exist.
2. **`build-native-dev`** — compiles the Rust audio module via Cargo
   and copies the resulting `.node` file to `native/index.node`.
3. **`build-relay-dev`** — runs the Relay compiler. It scans the
   TypeScript sources for `graphql\`...\``template literals,
type-checks each against
[src/common/schema.graphql](../src/common/schema.graphql), and
generates the`**generated**/\*.ts` files Relay needs at runtime.
4. **`build-parcel-dev`** — bundles the four targets (main, preload,
   renderer, remocon) into `build/dev/`.
5. **`parcel serve --target remocon --target renderer`** — starts a
   Parcel dev server on port 3000 that serves the renderer and remocon
   bundles with live reload. The main Express server in step 6 reverse
   proxies non-GraphQL requests to this dev server in development.
6. **`electron .`** — launches Electron, which runs the built main
   bundle, opens the renderer window, and starts the Express server on
   port 8080.

After that, edit a `.tsx` or `.css` file and the renderer/remocon
should hot-reload. The Rust module and the main process don't
hot-reload — you'll need to kill the dev server and re-run.

## What if it doesn't build?

A few common stumbling blocks:

- **`getExternalResources` fails on Windows** because Steinberg's ASIO
  SDK download URL occasionally redirects in a way 7zip doesn't like.
  If you don't need ASIO (the WASAPI fallback works fine for most
  cases), you can pre-create empty asio header files to satisfy the
  build's existence check, or compile the Rust crate without the
  `asio` feature.
- **`cargo build` fails on Linux** with an `alsa.h not found` error.
  Install your distro's ALSA development headers.
- **Type errors in `__generated__/*.ts`** after pulling new changes
  usually mean the Relay compiler hasn't re-run. Try
  `yarn build-relay-dev`.

## Useful scripts

All defined in [package.json](../package.json) under `scripts`.

| Command                       | What it does                                                           |
| ----------------------------- | ---------------------------------------------------------------------- |
| `yarn run-dev`                | Full dev pipeline + Electron, described above.                         |
| `yarn build-dev`              | Just the dev bundles — no Electron.                                    |
| `yarn build-prod`             | Production bundles (optimized, no source maps).                        |
| `yarn build-native-dev`       | Just the Rust module, debug.                                           |
| `yarn build-native-prod`      | Just the Rust module, release.                                         |
| `yarn build-relay-dev`        | Re-run Relay codegen.                                                  |
| `yarn build-parcel-dev`       | Re-run Parcel bundling.                                                |
| `yarn package-prod`           | Build a distributable using `electron-packager` and zip it.            |
| `yarn test:native`            | `cargo clippy` plus `cargo +nightly careful test` for the Rust crates. |
| `yarn test:wdio`              | End-to-end tests via WebdriverIO (see [tests/wdio/](../tests/wdio/)).  |
| `yarn get-external-resources` | Re-download `yt-dlp`, `ffmpeg`, and ASIO SDK (Windows).                |

## How the four bundles fit on disk

After a `build-dev` or `build-prod`:

```
build/
  dev/  (or prod/)
    main_/          Bundle for the Electron main process
      index.js
    preload/        Preload script bundle
      index.js
    renderer/       Renderer (TV) bundle
      index.html
      ...
    remocon/        Remocon (phone) bundle
      index.html
      ...
```

`package.json`'s `main` field points at `build/prod/main_/index.js` so a
production-installed Electron picks up the right entry. In dev,
[electron.js](../electron.js) at the repo root is the entry; it spawns
Electron with the path to the dev main bundle and sets up Yarn PnP
resolution for the main process.

## Testing

There are two layers of tests:

- **Rust unit tests** in [native/karafriends-lib/src/](../native/karafriends-lib/src/),
  primarily for the pitch detector. Run with `yarn test:native`.
- **End-to-end tests** in [tests/wdio/](../tests/wdio/), driven by
  WebdriverIO. These spin up Parcel's dev server, then Electron, and
  exercise the renderer and remocon through Chromium automation.
  Run with `yarn test:wdio`.

There is no TypeScript unit test layer — front-end logic is exercised
through the e2e tests.

## Code style

The Husky `pre-commit` hook (configured under `lint-staged` in
`package.json`) runs:

- Prettier on every file.
- TSLint with `--fix` on `.ts`/`.tsx` files.
- `rustfmt` on `.rs` files.

TSLint is end-of-life upstream but the project still uses it; don't be
surprised by some flag combinations that look unusual compared to
ESLint.

## Packaging a release

`yarn package-prod` produces a platform-native bundle (`.app` on macOS,
a directory tree on Windows, AppImage-style on Linux) and zips it into
`dist/`. macOS additionally code-signs and notarizes the bundle —
that requires Apple Developer credentials, set via the
`NOTARIZATION_KEY_PATH` environment variable and identity strings
hardcoded into `packager.js`. If you're building for yourself, you'll
want to edit or comment out the signing block.

The CI workflows under [.github/workflows/](../.github/workflows/) call
`package-prod` for each platform and attach the results to GitHub
Releases.

## decryptor/

Not part of the runtime app. This folder contains two standalone Python
scripts and a `requirements.txt`. They reverse the encryption DAM uses
on certain song-file formats. You don't need them to run karafriends;
they're tools for offline experimentation.
