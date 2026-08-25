// Builds the local avatar-portrait dataset from PMDCollab's SpriteCollab
// (https://sprites.pmdcollab.org): a sparse clone of just portrait/ +
// tracker.json (~80MB instead of the 1.8GB full repo), packed into
//   extraResources/portraits/portraits.pack, every portrait PNG concatenated
//     (deduped by content hash), and
//   extraResources/portraits/portraits.json, monster/form/emotion names with
//     [offset, length] into the pack.
// One 78MB file + one manifest instead of ~50k tiny files keeps packaging and
// git operations fast; the main process serves slices of the pack over HTTP
// and the remocon searches the manifest entirely client-side.
import { execFileSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const extraResourcesDir = `${process.cwd()}/extraResources`;
const portraitsDir = `${extraResourcesDir}/portraits`;
const SPRITECOLLAB_REPO = "https://github.com/PMDCollab/SpriteCollab.git";
// Sanity floor: the dataset had ~47k portraits / ~77MB in 2026-07. A build
// that comes in way under this scraped a broken checkout, so fail loudly
// instead of shipping an empty picker.
const MIN_PORTRAITS = 40000;
const MIN_PACK_BYTES = 50 * 1024 * 1024;

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
}

// tracker.json mirrors the portrait/ directory tree: subgroup keys are the
// directory names, each level carrying a human-readable form name fragment
// ("", "Gigantamax", "Shiny", "Female", ...).
function trackerNodeFor(tracker, segments) {
  let node = tracker[segments[0]];
  for (const segment of segments.slice(1)) {
    node = node?.subgroups?.[segment];
  }
  return node;
}

function formName(tracker, segments) {
  const fragments = [];
  for (let i = 1; i < segments.length; i++) {
    const name = trackerNodeFor(tracker, segments.slice(0, i + 1))?.name;
    if (name) fragments.push(name.replace(/_/g, " "));
  }
  return fragments.join(" ");
}

// "Normal" is the canonical/default portrait; surface it first everywhere.
function compareEmotions(a, b) {
  if (a === b) return 0;
  if (a === "Normal") return -1;
  if (b === "Normal") return 1;
  return a < b ? -1 : 1;
}

function collectFormDirs(root) {
  const formDirs = [];
  const walk = (dir, rel) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const pngs = entries
      .filter((e) => e.isFile() && e.name.endsWith(".png"))
      .map((e) => e.name);
    if (pngs.length > 0) formDirs.push({ rel, dir, pngs });
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${rel}/${e.name}`);
    }
  };
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(root, e.name), e.name);
  }
  return formDirs;
}

export async function ensurePortraits() {
  if (
    fs.existsSync(`${portraitsDir}/portraits.pack`) &&
    fs.existsSync(`${portraitsDir}/portraits.json`)
  ) {
    return;
  }

  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "karafriends_portraits"),
  );
  try {
    console.log("Fetching SpriteCollab portraits (sparse clone, ~80MB)...");
    const cloneDir = path.join(tmpDir, "SpriteCollab");
    git(
      [
        "clone",
        "--depth=1",
        "--filter=blob:none",
        "--sparse",
        SPRITECOLLAB_REPO,
        cloneDir,
      ],
      tmpDir,
    );
    git(["sparse-checkout", "add", "portrait"], cloneDir);

    const tracker = JSON.parse(
      fs.readFileSync(path.join(cloneDir, "tracker.json"), "utf-8"),
    );

    const formDirs = collectFormDirs(path.join(cloneDir, "portrait"));
    // Group by dex id; base form (the dex root dir) first, then subdirs.
    const byDex = new Map();
    for (const formDir of formDirs) {
      const dex = formDir.rel.split("/")[0];
      if (!byDex.has(dex)) byDex.set(dex, []);
      byDex.get(dex).push(formDir);
    }

    const chunks = [];
    const offsetsByHash = new Map();
    let packLength = 0;
    let portraitCount = 0;
    const monsters = [];
    for (const dex of [...byDex.keys()].sort()) {
      const name = tracker[dex]?.name;
      if (!name) continue;
      const forms = [];
      for (const formDir of byDex
        .get(dex)
        .sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
        const emotions = {};
        for (const png of formDir.pngs.sort((a, b) =>
          compareEmotions(a.slice(0, -4), b.slice(0, -4)),
        )) {
          const bytes = fs.readFileSync(path.join(formDir.dir, png));
          const hash = crypto.createHash("sha1").update(bytes).digest("hex");
          let entry = offsetsByHash.get(hash);
          if (!entry) {
            entry = [packLength, bytes.length];
            offsetsByHash.set(hash, entry);
            chunks.push(bytes);
            packLength += bytes.length;
          }
          emotions[png.slice(0, -4)] = entry;
          portraitCount++;
        }
        forms.push({
          path: formDir.rel,
          name: formName(tracker, formDir.rel.split("/")),
          emotions,
        });
      }
      monsters.push({ id: parseInt(dex, 10), name, forms });
    }

    if (portraitCount < MIN_PORTRAITS || packLength < MIN_PACK_BYTES) {
      throw new Error(
        `Portrait dataset implausibly small (${portraitCount} portraits, ${packLength} bytes), aborting`,
      );
    }

    fs.mkdirSync(portraitsDir, { recursive: true });
    fs.writeFileSync(
      `${portraitsDir}/portraits.pack.tmp`,
      Buffer.concat(chunks),
    );
    fs.writeFileSync(
      `${portraitsDir}/portraits.json.tmp`,
      JSON.stringify({ version: 1, monsters }),
    );
    fs.copyFileSync(
      path.join(cloneDir, "LICENSE.md"),
      `${portraitsDir}/LICENSE.md`,
    );
    // Rename-into-place so a killed build never leaves a truncated pack that
    // the existence check above would then treat as complete.
    fs.renameSync(
      `${portraitsDir}/portraits.pack.tmp`,
      `${portraitsDir}/portraits.pack`,
    );
    fs.renameSync(
      `${portraitsDir}/portraits.json.tmp`,
      `${portraitsDir}/portraits.json`,
    );
    console.log(
      `Packed ${portraitCount} portraits (${monsters.length} pokemon, ${(
        packLength / 1048576
      ).toFixed(1)}MiB) into extraResources/portraits/`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
