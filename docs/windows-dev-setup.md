# Windows dev setup pains

A field guide to the snags you'll hit setting up karafriends on a fresh
Windows machine, in roughly the order you'll hit them. Each section has
the symptom, the cause, and the fix.

The short version: **install Rust + MSVC C++ build tools, install a
modern Git, use SSH for pushes, expect a few yarn/corepack workarounds
to make the pre-commit hook happy.** Details below.

## 1. Rust + MSVC C++ build tools

**Symptom:** `yarn run-dev` fails at `build-native-dev` with
`linker 'link.exe' not found` or `cannot find cargo`.

**Why:** the native audio module (`native/`) is Rust. Rust on Windows
links through Microsoft's linker, which only ships with Visual Studio
Build Tools. Both Rust and the build tools need to be installed
explicitly.

**Fix:**

1. Install **Visual Studio Build Tools** from
   [visualstudio.microsoft.com/visual-cpp-build-tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/),
   pick the "Desktop development with C++" workload. ~6–8 GB; mostly the
   Windows SDK that rust-lld needs.
2. Install **Rust** via `rustup-init.exe` from [rustup.rs](https://rustup.rs).
   Default install (option 1) gives you the
   `stable-x86_64-pc-windows-msvc` toolchain. ~1.5 GB.
3. **Close and reopen your terminal.** rustup writes to your user PATH;
   already-running shells (including any IDE you have open) won't see
   the new entry until they restart. The `~/.cargo/bin` dir needs to be
   on PATH for `cargo` to resolve.

## 2. Cargo via Git Bash is broken (rustup symlink trap)

**Symptom:** running `cargo` in Git Bash prints
`rustup 1.29.0` and `This is the version for the rustup toolchain
manager, not the rustc compiler`. The husky pre-commit hook fails with
`unexpected argument '--manifest-path' found`.

**Why:** rustup installs proxy binaries — `cargo.exe`, `rustc.exe`,
`rustfmt.exe`, etc. — that are actually symlinks to `rustup.exe`. The
proxy inspects `argv[0]` to figure out which tool to run. On native
Windows that works fine; in Git Bash (MSYS2), the shell resolves
symlinks before exec, so `argv[0]` becomes `rustup.exe` instead of
`cargo.exe`. rustup then dumps its self-help text.

**Fix:** prepend the actual toolchain bin directory to your PATH in
Git Bash. Add to `~/.bashrc`:

```sh
export PATH="$HOME/.rustup/toolchains/stable-x86_64-pc-windows-msvc/bin:$PATH"
```

This contains the real `cargo.exe` / `rustc.exe` binaries, not the
proxies. PowerShell and CMD don't have this problem.

## 3. Cargo components: clippy and rustfmt

**Symptom:** husky pre-commit hook fails with cargo telling you clippy
isn't installed, or `rustfmt` not found.

**Why:** rustup installs `cargo` but not its lint/format components by
default. The `.husky/pre-commit` hook runs `cargo clippy` and the
`lint-staged` config calls `rustfmt`.

**Fix:**

```sh
rustup component add clippy rustfmt
```

## 4. Yarn isn't on PATH (corepack-only)

**Symptom:** husky pre-commit hook prints `yarn: command not found`.
Or you've been running `corepack yarn ...` everywhere and forgot you
can't just say `yarn`.

**Why:** Yarn 4 is invoked via Node's corepack shim. On Windows there's
no plain `yarn` binary in `Program Files\nodejs\` by default — only
`corepack.cmd`. The hook script calls `yarn` directly.

**Fix:** two options.

**(a) Enable corepack globally** (cleanest, may need admin):

```
corepack enable
```

Installs `yarn.cmd` and `pnpm.cmd` shims into the nodejs bin folder.

**(b) Manual user-local shim** (no admin):
Create `~/bin/yarn` (Git Bash already has `~/bin` on PATH):

```sh
#!/usr/bin/env bash
exec corepack yarn "$@"
```

Then `chmod +x ~/bin/yarn`.

## 5. Old Git on Windows breaks yarn patch

**Symptom:** running `yarn patch-commit ...` fails with
`fatal: invalid diff option/value: --ignore-cr-at-eol`.

**Why:** Yarn 4's patch tool calls `git diff --ignore-cr-at-eol` to
generate the patch file. That flag landed in Git 2.18 (2018). Older
Git for Windows (e.g. 2.14, the 2017 release that some installers
still leave behind) doesn't have it.

**Fix:** upgrade Git. `winget install --id Git.Git --force` or download
from [git-scm.com/download/win](https://git-scm.com/download/win) and
click through. **Heads up:** the installer will refuse to proceed if
there are running `bash.exe` / `tail.exe` / `grep.exe` processes (it
wants to replace them on disk). Close any open Git Bash sessions and
shells that have piped commands hanging around as zombies. Task Manager
or `Stop-Process -Id <pid> -Force` works.

**Workaround if upgrading is blocked:** hand-write the unified diff
patch file under `.yarn/patches/` and add the resolution entry to
`package.json` manually. Yarn applies the patch without verifying the
generation tooling.

## 6. GitHub HTTPS auth

**Symptom:** `git push` over HTTPS gives
`Password authentication is not supported for Git operations` or
`HttpRequestException encountered`.

**Why:** GitHub deprecated password auth for git operations in 2021.
You need either a Personal Access Token (used in place of password) or
the modern Git Credential Manager doing browser-based OAuth. Old Git
ships an old GCM that can't do OAuth at all.

**Fix:** easiest is **SSH** (see next section). If you must use HTTPS:

1. Upgrade to current Git for Windows (ships with a modern GCM).
2. On first push, GCM will pop a browser window for GitHub OAuth.
   Complete it and your credential is cached for future pushes.
3. Alternatively, generate a Personal Access Token at
   github.com/settings/tokens and use it as the "password" when
   prompted.

## 7. SSH and the stale GitHub host key

**Symptom:** `git push` over SSH fails with
`WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!` followed by
`Host key verification failed`.

**Why:** GitHub rotated their RSA host key in March 2023 (after a
brief private-key exposure). If your `~/.ssh/known_hosts` has the
pre-2023 RSA entry from an old SSH connection, the new key doesn't
match.

The fingerprint you'll see for the new (valid) RSA key is
`SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s`. If that matches
what SSH is showing you, it's not a MITM — just the rotation.

**Fix:**

```sh
ssh-keygen -R github.com
```

This removes all `github.com` entries from `known_hosts`. The next
push will silently add the current entry (or you can pass
`-o StrictHostKeyChecking=accept-new` to skip the prompt).

## 8. Fork before you push

**Symptom:** `git push origin <branch>` returns `403 Forbidden` or
`Permission denied`.

**Why:** the cloned repo's `origin` points at the upstream
`emmaworley/karafriends`. You don't have write permission there.

**Fix:** fork on GitHub (one click), then:

```sh
git remote add fork git@github.com:<your-username>/karafriends.git
git push -u fork <branch>
```

Open the PR from your fork → upstream's `master` via the GitHub UI.

## 9. The youtubei.js Windows runtime crash

**Symptom:** Electron starts up, then immediately crashes with
`TypeError [ERR_INVALID_FILE_URL_PATH]: File URL path must be absolute`,
pointing into
`build/dev/main_/.yarn/cache/youtubei.js-.../node_modules/youtubei.js/src/platform/node.ts:15`.

**Why:** youtubei.js v16 detects ESM vs CJS via `import.meta.url`, then
uses `fileURLToPath` on it. Parcel inlines `import.meta.url` for the
main bundle as `"file:///.yarn/cache/..."` — a relative file URL.
Linux/macOS accepts that as absolute (the leading slash is the root);
Windows requires a drive letter, so `fileURLToPath` throws.

**Fix:** the [fix-windows-build branch](https://github.com/jonathanjtan/karafriends/tree/fix-windows-build)
patches youtubei.js to fall back to `__dirname` (or `cwd()`) on
Windows when `fileURLToPath` throws. Non-Windows code path is
unchanged from upstream.

Patch lives in `.yarn/patches/`; wired up via a `resolutions` entry
in `package.json`. Applied automatically by `yarn install`.

## 10. External resources: yt-dlp, ffmpeg, ASIO SDK

**Symptom (sometimes):** `yarn get-external-resources` fails fetching
Steinberg's ASIO SDK from `steinberg.net/asiosdk`.

**Why:** the Steinberg URL occasionally redirects in ways the
`getExternalResources` script doesn't handle, especially behind a
corporate proxy or VPN.

**Fix (if you hit it):** the ASIO SDK is **optional** — it's only used
if you opt in by building the native crate with `--features asio`,
which the default scripts don't. Workaround: create a stub
`buildResources/asio/asiosdk/common/asio.h` (empty file is fine) so
the existence-check passes. Then `yarn get-external-resources` skips
the download entirely.

In our setup it actually worked first try, so don't worry about this
unless you hit it.

## Summary checklist

If you're setting up from scratch:

- [ ] Install Visual Studio Build Tools ("Desktop development with C++")
- [ ] Install Rust via rustup (default settings)
- [ ] Add `rustup component add clippy rustfmt`
- [ ] Verify Git is 2.18 or newer (`git --version`); upgrade via winget if not
- [ ] Add `$HOME/.rustup/toolchains/.../bin` to PATH in `.bashrc` (Git Bash only)
- [ ] Create `~/bin/yarn` shim _or_ run `corepack enable`
- [ ] Restart your terminal so PATH changes take effect
- [ ] `corepack yarn install && corepack yarn run-dev`
- [ ] If Electron crashes on startup with the youtubei.js error, you're missing the patch — see section 9
- [ ] To push your own work: fork on GitHub, add as `fork` remote, use SSH
