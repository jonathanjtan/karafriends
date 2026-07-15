// Scrapers for the public JOYSOUND / DAM weekly karaoke rankings, used to
// back the remocon's "Top 100" pages. Both sites embed their catalog song
// ids directly in the ranking markup (JOYSOUND as /web/search/song/<id>
// links in a schema.org JSON-LD ItemList, DAM as songleaf requestNo query
// params), so entries map straight onto the same ids the search flows use.
import fs from "fs";
import nodeFetch from "node-fetch";
import path from "path";
import tunnel from "tunnel";

import karafriendsConfig from "../common/config";
import { TEMP_FOLDER } from "../common/videoDownloader";
import { JoysoundAPI } from "./joysoundApi";

export interface RankingSongEntry {
  readonly rank: number;
  // The service's catalog id, or null when the charted song couldn't be
  // found in the singable catalog (JOYSOUND's public chart covers songs the
  // sound-cafe.jp catalog doesn't carry).
  readonly id: string | null;
  readonly name: string;
  readonly artistName: string;
}

// Mirrors the RankingCategory / RankingPeriod GraphQL enums. Both services
// publish 100-entry weekly and monthly charts for the same five categories
// (neither archives past months — "monthly" is the current rolling month).
export type RankingCategory =
  | "OVERALL"
  | "ANIME"
  | "VOCALOID"
  | "ENKA"
  | "WESTERN";
export type RankingPeriod = "WEEKLY" | "MONTHLY";

const JOYSOUND_CATEGORY_PATHS: { [category in RankingCategory]: string } = {
  OVERALL: "all",
  ANIME: "anime",
  VOCALOID: "vocaloid",
  ENKA: "enka",
  WESTERN: "foreign",
};

// DAM's overall chart lives on /ranking/ with differently-named section ids
// than the per-genre pages (weekly-ranking vs ranking-weekly — really).
const DAM_GENRE_PATHS: {
  [category in Exclude<RankingCategory, "OVERALL">]: string;
} = {
  ANIME: "anison",
  VOCALOID: "vocaloid",
  ENKA: "enka",
  WESTERN: "foreign",
};

function joysoundRankingUrl(
  category: RankingCategory,
  period: RankingPeriod,
): string {
  return `https://www.joysound.com/web/karaoke/ranking/${
    JOYSOUND_CATEGORY_PATHS[category]
  }/${period.toLowerCase()}`;
}

function damRankingSource(
  category: RankingCategory,
  period: RankingPeriod,
): { url: string; sectionId: string } {
  if (category === "OVERALL") {
    return {
      url: "https://www.clubdam.com/ranking/",
      sectionId: period === "WEEKLY" ? "weekly-ranking" : "monthly-ranking",
    };
  }

  return {
    url: `https://www.clubdam.com/genre/${DAM_GENRE_PATHS[category]}/`,
    sectionId: period === "WEEKLY" ? "ranking-weekly" : "ranking-monthly",
  };
}

// Plain-browser UA — both sites serve the scraped markup to regular
// browsers; no reason to advertise a headless client instead.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/112.0";

const tunnelAgent = karafriendsConfig.proxyEnable
  ? tunnel.httpsOverHttp({
      proxy: {
        host: karafriendsConfig.proxyHost,
        port: karafriendsConfig.proxyPort,
        proxyAuth: `${karafriendsConfig.proxyUser}:${karafriendsConfig.proxyPass}`,
      },
    })
  : undefined;

async function fetchPage(url: string): Promise<string> {
  const resp = await nodeFetch(url, {
    agent: tunnelAgent,
    headers: { "User-Agent": USER_AGENT },
  });

  if (!resp.ok) {
    throw new Error(`Ranking fetch for ${url} failed: HTTP ${resp.status}`);
  }

  return resp.text();
}

// DAM song titles/artists arrive as HTML text nodes; JOYSOUND's come out of
// JSON-LD already decoded. Only the entity forms that actually show up in
// song metadata need handling.
function decodeHtmlEntities(str: string): string {
  const named: { [entity: string]: string } = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };

  return str.replace(/&([a-zA-Z]+|#x?[0-9a-fA-F]+);/g, (match, code) => {
    if (named[code] !== undefined) return named[code];

    const hex = code.match(/^#x([0-9a-fA-F]+)$/);
    if (hex) return String.fromCodePoint(parseInt(hex[1], 16));

    const dec = code.match(/^#(\d+)$/);
    if (dec) return String.fromCodePoint(parseInt(dec[1], 10));

    return match;
  });
}

// joysound.com's ranking pages embed the full chart as a schema.org
// ItemList: { itemListElement: [{ position, item: { name, byArtist: { name },
// url: ".../web/search/song/<id>" } }] }. NOTE: that id is joysound.com's
// own web catalog id, NOT the sound-cafe.jp selSongNo the app plays through
// (e.g. 残酷な天使のテーゼ is 9629 on the web but selSongNo 9630) — so the
// parse keeps name/artist only and the id is resolved separately against the
// sound-cafe search API.
interface JoysoundChartEntry {
  readonly rank: number;
  readonly name: string;
  readonly artistName: string;
}

function parseJoysoundRanking(html: string): JoysoundChartEntry[] {
  const entries: JoysoundChartEntry[] = [];

  for (const scriptMatch of html.matchAll(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
  )) {
    let data: any;
    try {
      data = JSON.parse(scriptMatch[1]);
    } catch {
      continue;
    }

    const graphs: any[] = data["@graph"] || [data];
    for (const node of graphs) {
      const items = node?.mainEntity?.itemListElement;
      if (!Array.isArray(items)) continue;

      for (const listItem of items) {
        const name = listItem?.item?.name;
        const artistName = listItem?.item?.byArtist?.name;

        if (name && artistName) {
          entries.push({
            rank: listItem.position || entries.length + 1,
            name,
            artistName,
          });
        }
      }
    }
  }

  return entries;
}

// clubdam.com pages carry several top-100 sections in one page (the overall
// /ranking/ page has daily/weekly/monthly, genre pages weekly/monthly with a
// teaser + full-list copy of the same chart); each entry <li> holds a
// songleaf link (requestNo — the same id dkwebsys search results use), an
// <h4 class="p-song__title"> and a <div class="p-song__artist">. Slice from
// the wanted section id to the next section container and dedupe repeats.
function parseDamRanking(html: string, sectionId: string): RankingSongEntry[] {
  const afterSection = html.split(`id="${sectionId}"`)[1];
  if (!afterSection) return [];

  const nextSectionStart = afterSection.indexOf('class="c-section"');
  const section =
    nextSectionStart === -1
      ? afterSection
      : afterSection.slice(0, nextSectionStart);

  const entries: RankingSongEntry[] = [];
  const seen = new Set<string>();

  for (const li of section.matchAll(
    /songleaf\.html\?requestNo=([0-9-]+)"[\s\S]*?p-song__title">([^<]*)<[\s\S]*?p-song__artist">([^<]*)</g,
  )) {
    if (seen.has(li[1])) continue;
    seen.add(li[1]);

    entries.push({
      rank: entries.length + 1,
      id: li[1],
      name: decodeHtmlEntities(li[2].trim()),
      artistName: decodeHtmlEntities(li[3].trim()),
    });
  }

  return entries;
}

// Loose-equality normalization for chart↔catalog title/artist matching:
// joysound.com and sound-cafe.jp disagree on width ("滅!" vs "滅！"), casing
// and spacing for the same song.
function normalizeForMatch(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

function artistMatches(chartArtist: string, candidateArtist: string): boolean {
  const a = normalizeForMatch(chartArtist);
  const b = normalizeForMatch(candidateArtist);

  // Containment either way absorbs featuring/CV suffix differences between
  // the two sites' credits for the same artist.
  return a === b || a.includes(b) || b.includes(a);
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let nextIndex = 0;

  const workers = new Array(Math.min(concurrency, items.length))
    .fill(null)
    .map(async () => {
      while (nextIndex < items.length) {
        const i = nextIndex++;
        results[i] = await fn(items[i]);
      }
    });

  await Promise.all(workers);
  return results;
}

// Resolve one JOYSOUND chart entry to a sound-cafe selSongNo by searching
// the singable catalog for the title (popularity-sorted, like remocon
// search) and taking the first candidate whose title matches exactly and
// whose artist matches loosely. Chart songs missing from the catalog (or
// only present as [サビカラ] chorus cuts) resolve to null.
async function resolveJoysoundEntry(
  joysoundApi: JoysoundAPI,
  entry: JoysoundChartEntry,
): Promise<RankingSongEntry & { searchFailed?: boolean }> {
  try {
    const wantedName = normalizeForMatch(entry.name);
    const isWanted = (candidate: { songName: string; artistName: string }) =>
      normalizeForMatch(candidate.songName) === wantedName &&
      artistMatches(entry.artistName, candidate.artistName);

    const candidates = await joysoundApi.getSongListByKeyword(
      entry.name,
      1,
      50,
    );
    let match = candidates.find(isWanted);

    // Short generic titles ("恋") bury the charted artist's version beyond
    // the popularity-sorted keyword results behind same-named songs by other
    // artists. Retry from the artist side: find the artist, then the exact
    // title in their song list.
    if (!match) {
      const artists = await joysoundApi.getArtistListByKeyword(
        entry.artistName,
        1,
        5,
      );

      // Exact artist-name matches first: the name-sorted artist search can
      // list a collab act like "大竹しのぶ×清水依与吏 (back number)" ahead of
      // "back number" itself, and containment alone would pick it.
      const wantedArtist = normalizeForMatch(entry.artistName);
      const rankedArtists = artists
        .filter((candidate) =>
          artistMatches(entry.artistName, candidate.artistName),
        )
        .sort(
          (a, b) =>
            Number(normalizeForMatch(b.artistName) === wantedArtist) -
            Number(normalizeForMatch(a.artistName) === wantedArtist),
        );

      for (const artist of rankedArtists) {
        const artistSongs = await joysoundApi.getSongListByArtist(
          artist.artistId_digi,
          1,
          100,
        );
        match = artistSongs.find(isWanted);
        if (match) break;
      }
    }

    return { ...entry, id: match ? match.selSongNo : null };
  } catch (error) {
    console.warn(
      `Failed to resolve JOYSOUND ranking entry "${entry.name}":`,
      error,
    );
    return { ...entry, id: null, searchFailed: true };
  }
}

// Charts are cached to disk (like reading-cache.json) so the expensive first
// fetch — JOYSOUND resolves ~100 songs against the search API — is paid once
// and survives relaunches. A cached chart stays fresh for the whole period
// window it belongs to (a weekly chart until the calendar week rolls over, a
// monthly chart until the month does), matching how often the sources
// actually change; a stale chart is refetched but served from cache in the
// meantime if the refetch fails.
interface CachedRanking {
  fetchedAt: number;
  entries: RankingSongEntry[];
}

const rankingCache = new Map<string, CachedRanking>();
// In-flight scrape per key, so concurrent page visits (and the launch
// prefetch) don't kick off duplicate work.
const inflightRankings = new Map<string, Promise<RankingSongEntry[]>>();

const RANKING_CACHE_PATH = path.resolve(TEMP_FOLDER, "rankings-cache.json");

function loadRankingCache(): void {
  try {
    const parsed = JSON.parse(fs.readFileSync(RANKING_CACHE_PATH, "utf-8")) as {
      [key: string]: CachedRanking;
    };

    for (const [key, value] of Object.entries(parsed)) {
      if (
        value &&
        typeof value.fetchedAt === "number" &&
        Array.isArray(value.entries)
      ) {
        rankingCache.set(key, value);
      }
    }
  } catch {
    // No cache yet (or corrupt / unreadable) — start empty.
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveRankingCache(): void {
  // Debounce so a burst of prefetches writes the file once.
  if (saveTimer) return;

  saveTimer = setTimeout(() => {
    saveTimer = null;
    const obj: { [key: string]: CachedRanking } = {};
    for (const [key, value] of rankingCache) obj[key] = value;

    fs.writeFile(RANKING_CACHE_PATH, JSON.stringify(obj), (err) => {
      if (err) console.warn("Failed to persist rankings cache:", err);
    });
  }, 1000);

  saveTimer.unref?.();
}

// Monday-anchored week key (local time) — two dates in the same week share
// it, sidestepping ISO week-number/year-boundary edge cases.
function periodBucket(date: Date, period: RankingPeriod): string {
  if (period === "MONTHLY") {
    return `${date.getFullYear()}-${date.getMonth()}`;
  }

  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return `${monday.getFullYear()}-${monday.getMonth()}-${monday.getDate()}`;
}

function isFresh(cached: CachedRanking, period: RankingPeriod): boolean {
  return (
    periodBucket(new Date(cached.fetchedAt), period) ===
    periodBucket(new Date(), period)
  );
}

// Serve from disk cache while the period window holds; otherwise scrape,
// persist, and return — but if a stale refresh fails, fall back to the stale
// entries rather than erroring (an old chart beats none). Only a cold-cache
// failure propagates so the remocon can show a retry.
function withRankingCache(
  key: string,
  period: RankingPeriod,
  fetchRanking: () => Promise<RankingSongEntry[]>,
): Promise<RankingSongEntry[]> {
  const cached = rankingCache.get(key);
  if (cached && isFresh(cached, period)) {
    return Promise.resolve(cached.entries);
  }

  const inflight = inflightRankings.get(key);
  if (inflight) return inflight;

  const promise = fetchRanking()
    .then((entries) => {
      rankingCache.set(key, { fetchedAt: Date.now(), entries });
      saveRankingCache();
      return entries;
    })
    .catch((error) => {
      if (cached) {
        console.warn(`Refreshing ranking ${key} failed; serving stale:`, error);
        return cached.entries;
      }
      throw error;
    })
    .finally(() => inflightRankings.delete(key));

  inflightRankings.set(key, promise);
  return promise;
}

export function getJoysoundRanking(
  joysoundApi: JoysoundAPI,
  category: RankingCategory,
  period: RankingPeriod,
): Promise<RankingSongEntry[]> {
  return withRankingCache(
    `joysound:${category}:${period}`,
    period,
    async () => {
      const chart = parseJoysoundRanking(
        await fetchPage(joysoundRankingUrl(category, period)),
      ).slice(0, 100);

      // An empty parse means the page layout changed, not an empty chart —
      // surface it as an error so the remocon shows a retry instead of a
      // blank-but-successful page.
      if (chart.length === 0) {
        throw new Error(
          "Failed to parse any songs out of the JOYSOUND ranking",
        );
      }

      const entries = await mapWithConcurrency(chart, 6, (entry) =>
        resolveJoysoundEntry(joysoundApi, entry),
      );

      // No-match entries are expected (catalog gaps) and cacheable, but if
      // every catalog lookup errored the whole result is garbage — throw so it
      // isn't persisted and the next visit retries instead of pinning a fully
      // unclickable chart for the period.
      if (entries.every((entry) => entry.searchFailed)) {
        throw new Error("All JOYSOUND ranking catalog lookups failed");
      }

      return entries.map(({ searchFailed, ...entry }) => entry);
    },
  );
}

export function getDamRanking(
  category: RankingCategory,
  period: RankingPeriod,
): Promise<RankingSongEntry[]> {
  return withRankingCache(`dam:${category}:${period}`, period, async () => {
    const { url, sectionId } = damRankingSource(category, period);
    const entries = parseDamRanking(await fetchPage(url), sectionId);

    if (entries.length === 0) {
      throw new Error("Failed to parse any songs out of the DAM ranking");
    }

    return entries.slice(0, 100);
  });
}

const ALL_CATEGORIES: RankingCategory[] = [
  "OVERALL",
  "ANIME",
  "VOCALOID",
  "ENKA",
  "WESTERN",
];
const ALL_PERIODS: RankingPeriod[] = ["WEEKLY", "MONTHLY"];

// Load any persisted charts and warm every (service, category, period) in the
// background so a chart is already resolved by the time someone opens the
// page. Runs sequentially and best-effort: withRankingCache short-circuits
// fresh entries (so a warm launch does almost nothing), and each fetch is
// guarded so one failure neither stops the sweep nor — critically — escapes
// as an unhandled rejection (which would take the whole app down).
export function primeRankings(joysoundApi: JoysoundAPI): void {
  loadRankingCache();

  void (async () => {
    for (const period of ALL_PERIODS) {
      for (const category of ALL_CATEGORIES) {
        await getDamRanking(category, period).catch((error) =>
          console.warn(`Prefetch dam ${category} ${period} failed:`, error),
        );
        await getJoysoundRanking(joysoundApi, category, period).catch((error) =>
          console.warn(
            `Prefetch joysound ${category} ${period} failed:`,
            error,
          ),
        );
      }
    }
  })();
}
