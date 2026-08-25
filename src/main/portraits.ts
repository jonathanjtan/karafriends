import fs from "fs";
import path from "path";

import { Application } from "express";

import { extraResourcesPath } from "../common/videoDownloader";

// Serves the local mirror of the PMDCollab SpriteCollab avatar portraits
// (built by scripts/getPortraits.mjs into extraResources/portraits/):
//   /portraits/index.json, the monster/form/emotion manifest the remocon
//     searches client-side, and
//   /portraits/<form path>/<emotion>.png, individual 40x40 portraits read
//     as byte slices out of the single portraits.pack blob.
// Everything is immutable within one app run (the dataset only changes when a
// build refetches it), so responses carry a day of client cache.

interface PortraitForm {
  path: string;
  name: string;
  emotions: Record<string, [number, number]>;
}

interface PortraitMonster {
  id: number;
  name: string;
  forms: PortraitForm[];
}

const CACHE_HEADER = "public, max-age=86400";

export function applyPortraitsMiddleware(app: Application): void {
  const indexPath = path.resolve(
    `${extraResourcesPath}portraits/portraits.json`,
  );
  const packPath = path.resolve(
    `${extraResourcesPath}portraits/portraits.pack`,
  );

  // path → [offset, length] into the pack.
  const locations = new Map<string, [number, number]>();
  let packFd: number;
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as {
      monsters: PortraitMonster[];
    };
    for (const monster of index.monsters) {
      for (const form of monster.forms) {
        for (const [emotion, location] of Object.entries(form.emotions)) {
          locations.set(`${form.path}/${emotion}.png`, location);
        }
      }
    }
    packFd = fs.openSync(packPath, "r");
  } catch (e) {
    console.warn(
      `Local portraits unavailable, avatar picker will not work (rerun get-external-resources?): ${e}`,
    );
    return;
  }

  app.get("/portraits/index.json", (req, res) => {
    res.setHeader("Cache-Control", CACHE_HEADER);
    res.sendFile(indexPath);
  });

  app.get(/^\/portraits\/(.+\.png)$/, (req, res) => {
    let key = req.params[0];
    try {
      key = decodeURIComponent(key);
    } catch {
      // fall through with the raw key; it just won't match anything
    }
    const location = locations.get(key);
    if (!location) {
      res.status(404).end();
      return;
    }
    const [offset, length] = location;
    const buffer = Buffer.alloc(length);
    fs.read(packFd, buffer, 0, length, offset, (err, bytesRead) => {
      if (err || bytesRead !== length) {
        res.status(500).end();
        return;
      }
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", CACHE_HEADER);
      res.end(buffer);
    });
  });
}
