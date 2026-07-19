import React, { useEffect, useMemo, useRef, useState } from "react";

import * as styles from "./PmdPortraitPicker.module.scss";

// Portrait picker backed by a local mirror of the PMDCollab SpriteCollab
// project (https://sprites.pmdcollab.org) — community-made Pokémon Mystery
// Dungeon portraits, one 40x40 image per pokemon/form/emotion. The dataset is
// bundled at build time (scripts/getPortraits.mjs) and served by the app
// under /portraits/; the manifest is fetched once and searched entirely
// client-side, so typing and browsing never leave the LAN. Selected portrait
// URLs are stored host-relative ("/portraits/...") — the renderer resolves
// them via resolveProfilePictureUrl.

interface PortraitForm {
  path: string;
  name: string;
  // emotion name → [offset, length] in the server-side pack; only the keys
  // (and their order — "Normal" first) matter to the client.
  emotions: Record<string, [number, number]>;
}

interface PortraitMonster {
  id: number;
  name: string;
  forms: PortraitForm[];
}

// The manifest is ~1.4MB raw (a few hundred KB gzipped) and immutable within
// an app run — fetch it once per page load and share across picker mounts.
let indexPromise: Promise<PortraitMonster[]> | null = null;
function fetchPortraitIndex(): Promise<PortraitMonster[]> {
  if (indexPromise === null) {
    indexPromise = fetch("/portraits/index.json")
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data: { monsters: PortraitMonster[] }) =>
        // dex 0000 is SpriteCollab's "Missingno_" test entry, not a pokemon
        data.monsters.filter((monster) => monster.id !== 0),
      )
      .catch((e) => {
        indexPromise = null;
        throw e;
      });
  }
  return indexPromise;
}

function portraitUrl(form: PortraitForm, emotion: string): string {
  return `/portraits/${form.path}/${encodeURIComponent(emotion)}.png`;
}

function previewUrl(monster: PortraitMonster): string {
  const form = monster.forms[0];
  return portraitUrl(form, Object.keys(form.emotions)[0]);
}

// With no filter the whole dex is shown (browsing is the primary flow);
// typing narrows it, prefix matches before substring matches.
function filterMonsters(
  monsters: PortraitMonster[],
  query: string,
): PortraitMonster[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return monsters;
  const prefixMatches: PortraitMonster[] = [];
  const substringMatches: PortraitMonster[] = [];
  for (const monster of monsters) {
    const name = monster.name.toLowerCase();
    if (name.startsWith(needle)) {
      prefixMatches.push(monster);
    } else if (name.includes(needle)) {
      substringMatches.push(monster);
    }
  }
  return [...prefixMatches, ...substringMatches];
}

interface Props {
  onSelect: (url: string) => void;
  selectedUrl: string | null;
}

const PmdPortraitPicker = ({ onSelect, selectedUrl }: Props) => {
  const [monsters, setMonsters] = useState<PortraitMonster[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedMonster, setSelectedMonster] =
    useState<PortraitMonster | null>(null);
  const [formIdx, setFormIdx] = useState(0);
  const emotionsRef = useRef<HTMLDivElement | null>(null);

  // Tapping a pokemon far down the dex grid renders the version/emotion
  // panel above the grid, off-screen — bring it into view. Instant, not
  // smooth: a smooth scroll spanning the whole dex gets canceled mid-flight
  // by the lazy-image loads it triggers (and would take seconds anyway).
  useEffect(() => {
    if (selectedMonster) {
      emotionsRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedMonster]);

  useEffect(() => {
    let cancelled = false;
    fetchPortraitIndex()
      .then((loaded) => {
        if (!cancelled) setMonsters(loaded);
      })
      .catch((e) => {
        if (!cancelled) setError(`Couldn't load portraits: ${e.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const results = useMemo(
    () => (monsters === null ? [] : filterMonsters(monsters, query)),
    [monsters, query],
  );

  const selectedForm = selectedMonster?.forms[formIdx];

  // Once a pokemon is selected its version/emotion panel becomes the top of
  // the picker, and the filter + dex grid move below it as the "switch to a
  // different pokemon" section. (The panel also can't render below the grid:
  // with the whole dex shown it would be off-screen when a mid-list pokemon
  // is tapped.)
  const filterAndResults = (
    <>
      <input
        placeholder="Filter Pokémon (English name)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {monsters === null && !error && (
        <div className={styles.hint}>Loading portraits...</div>
      )}
      {monsters !== null && results.length === 0 && (
        <div className={styles.hint}>No Pokémon found</div>
      )}
      {results.length > 0 && (
        <div className={styles.grid}>
          {results.map((monster) => (
            <div
              key={monster.id}
              className={`${styles.cell} ${
                selectedMonster?.id === monster.id ? styles.cellSelected : ""
              }`}
              onClick={() => {
                setSelectedMonster(monster);
                setFormIdx(0);
              }}
            >
              {/* lazy: the unfiltered grid is the whole dex (~1000 images);
                  only fetch the ones scrolled into view */}
              <img
                src={previewUrl(monster)}
                alt={monster.name}
                loading="lazy"
                width={40}
                height={40}
              />
              <span>{monster.name}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );

  return (
    <div className={styles.picker}>
      {error && <div className={styles.error}>{error}</div>}
      {selectedMonster && (
        <div className={styles.emotions} ref={emotionsRef}>
          {selectedMonster.forms.length > 1 && (
            <h4>
              {selectedMonster.name} — pick a version
              <select
                value={formIdx}
                onChange={(e) => setFormIdx(parseInt(e.target.value, 10))}
              >
                {selectedMonster.forms.map((form, i) => (
                  <option key={form.path} value={i}>
                    {form.name || "Normal"}
                  </option>
                ))}
              </select>
            </h4>
          )}
          <h4>{selectedMonster.name} — pick an emotion</h4>
          <div className={styles.grid}>
            {Object.keys(selectedForm?.emotions || {}).map((emotion) => (
              <div
                key={emotion}
                className={`${styles.cell} ${
                  selectedUrl === portraitUrl(selectedForm!, emotion)
                    ? styles.cellSelected
                    : ""
                }`}
                onClick={() => onSelect(portraitUrl(selectedForm!, emotion))}
              >
                <img src={portraitUrl(selectedForm!, emotion)} alt={emotion} />
                <span>{emotion}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {filterAndResults}
      <div className={styles.credit}>
        Portraits by the{" "}
        <a
          href="https://sprites.pmdcollab.org"
          target="_blank"
          rel="noreferrer"
        >
          PMDCollab SpriteCollab
        </a>{" "}
        community
      </div>
    </div>
  );
};

export default PmdPortraitPicker;
