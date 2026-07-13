import React, { useEffect, useRef, useState } from "react";

import DebouncedInput from "../DebouncedInput";
import * as styles from "./PmdPortraitPicker.module.scss";

// Portrait picker backed by the PMDCollab SpriteCollab project
// (https://sprites.pmdcollab.org) — community-made Pokémon Mystery Dungeon
// portraits, one 40x40 image per pokemon/form/emotion. We query their public
// GraphQL API directly from the phone (CORS is open) and the chosen portrait
// is just the raw.githubusercontent.com URL of the image.
const SPRITE_SERVER_URL = "https://spriteserver.pmdcollab.org/graphql";

interface PmdEmotion {
  emotion: string;
  url: string;
}

interface PmdForm {
  path: string;
  fullName: string;
  portraits: {
    previewEmotion: PmdEmotion | null;
    emotions?: PmdEmotion[];
  };
}

interface PmdMonster {
  id: number;
  name: string;
  forms: PmdForm[];
}

const SEARCH_QUERY = `
  query PmdPortraitSearch($name: String!) {
    searchMonster(monsterName: $name) {
      id
      name
      forms {
        path
        fullName
        portraits {
          previewEmotion {
            emotion
            url
          }
        }
      }
    }
  }
`;

const DETAIL_QUERY = `
  query PmdPortraitDetail($id: Int!) {
    monster(filter: [$id]) {
      id
      name
      forms {
        path
        fullName
        portraits {
          previewEmotion {
            emotion
            url
          }
          emotions {
            emotion
            url
          }
        }
      }
    }
  }
`;

async function spriteServerQuery<T>(
  query: string,
  variables: object,
): Promise<T> {
  const response = await fetch(SPRITE_SERVER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`SpriteCollab returned HTTP ${response.status}`);
  }
  const json = await response.json();
  if (json.errors?.length) {
    throw new Error(json.errors[0].message);
  }
  return json.data;
}

function previewUrl(monster: PmdMonster): string | null {
  for (const form of monster.forms) {
    if (form.portraits.previewEmotion) return form.portraits.previewEmotion.url;
  }
  return null;
}

interface Props {
  onSelect: (url: string) => void;
  selectedUrl: string | null;
}

const PmdPortraitPicker = ({ onSelect, selectedUrl }: Props) => {
  const [query, setQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState<PmdMonster[] | null>(null);
  const [selectedMonster, setSelectedMonster] = useState<PmdMonster | null>(
    null,
  );
  const [formIdx, setFormIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Monotonic id so a slow earlier response can't clobber a newer one.
  const requestSeq = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults(null);
      setIsSearching(false);
      return;
    }

    const seq = ++requestSeq.current;
    setIsSearching(true);
    setError(null);
    spriteServerQuery<{ searchMonster: PmdMonster[] }>(SEARCH_QUERY, {
      name: trimmed,
    })
      .then((data) => {
        if (seq !== requestSeq.current) return;
        setResults(data.searchMonster.filter((m) => previewUrl(m) !== null));
        setIsSearching(false);
      })
      .catch((e) => {
        if (seq !== requestSeq.current) return;
        setError(`Search failed: ${e.message}`);
        setIsSearching(false);
      });
  }, [query]);

  const pickMonster = (monster: PmdMonster) => {
    const seq = ++requestSeq.current;
    setSelectedMonster(null);
    setFormIdx(0);
    setError(null);
    spriteServerQuery<{ monster: PmdMonster[] }>(DETAIL_QUERY, {
      id: monster.id,
    })
      .then((data) => {
        if (seq !== requestSeq.current) return;
        const detail = data.monster[0];
        if (!detail) throw new Error("not found");
        setSelectedMonster({
          ...detail,
          forms: detail.forms.filter(
            (form) => (form.portraits.emotions || []).length > 0,
          ),
        });
      })
      .catch((e) => {
        if (seq !== requestSeq.current) return;
        setError(`Couldn't load ${monster.name}'s portraits: ${e.message}`);
      });
  };

  const selectedForm = selectedMonster?.forms[formIdx];

  return (
    <div className={styles.picker}>
      <DebouncedInput
        period={500}
        placeholder="Search Pokémon (English name)"
        onChange={(e) => setQuery(e.target.value)}
      />
      {error && <div className={styles.error}>{error}</div>}
      {isSearching && <div className={styles.hint}>Searching...</div>}
      {!isSearching && results !== null && results.length === 0 && (
        <div className={styles.hint}>No Pokémon found</div>
      )}
      {results !== null && results.length > 0 && (
        <div className={styles.grid}>
          {results.map((monster) => (
            <div
              key={monster.id}
              className={`${styles.cell} ${
                selectedMonster?.id === monster.id ? styles.cellSelected : ""
              }`}
              onClick={() => pickMonster(monster)}
            >
              <img src={previewUrl(monster)!} alt={monster.name} />
              <span>{monster.name}</span>
            </div>
          ))}
        </div>
      )}
      {selectedMonster && (
        <div className={styles.emotions}>
          {selectedMonster.forms.length > 1 && (
            <h4>
              {selectedMonster.name} — pick a version
              <select
                value={formIdx}
                onChange={(e) => setFormIdx(parseInt(e.target.value, 10))}
              >
                {selectedMonster.forms.map((form, i) => (
                  <option key={form.path} value={i}>
                    {form.fullName.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </h4>
          )}
          <h4>{selectedMonster.name} — pick an emotion</h4>
          <div className={styles.grid}>
            {(selectedForm?.portraits.emotions || []).map((portrait) => (
              <div
                key={portrait.url}
                className={`${styles.cell} ${
                  selectedUrl === portrait.url ? styles.cellSelected : ""
                }`}
                onClick={() => onSelect(portrait.url)}
              >
                <img src={portrait.url} alt={portrait.emotion} />
                <span>{portrait.emotion}</span>
              </div>
            ))}
          </div>
        </div>
      )}
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
