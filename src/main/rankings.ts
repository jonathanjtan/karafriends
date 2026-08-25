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

export interface RankingArtistEntry {
  readonly rank: number;
  // The catalog artist id (JOYSOUND selArtistId / DAM artistCode). Unlike
  // songs, both services' artist charts carry ids that map straight to the
  // catalog artist routes, so this is effectively always present.
  readonly id: string | null;
  readonly name: string;
}

// One entry of Oricon's karaoke chart. No id field: Oricon is a third-party
// chart with its own title/artist spellings, so nothing here maps onto a
// catalog until it's searched for.
export interface OriconChartEntry {
  readonly rank: number;
  readonly name: string;
  readonly artistName: string;
}

export interface OriconWeeklyChart {
  // Which week this chart covers (YYYY-MM-DD), as Oricon dates it.
  readonly date: string;
  readonly songs: ReadonlyArray<OriconChartEntry>;
}

// One option in the JOYSOUND monthly month-picker. `value` is a YYYYMM archive
// or null for the current (latest) month; `label` is the site's own button
// text (e.g. "6月").
export interface RankingMonth {
  readonly value: string | null;
  readonly label: string;
}

// Mirrors the RankingCategory / RankingPeriod GraphQL enums. Both services
// publish 100-entry weekly and monthly charts for most categories (neither
// archives past months, so "monthly" is the current rolling month), except
// VTUBER and DUET, which clubdam.com charts but joysound.com doesn't publish
// at all (confirmed 404 on both /ranking/vtuber/ and /ranking/duet/ style
// paths), so those two are DAM-only.
export type RankingCategory =
  | "OVERALL"
  | "ANIME"
  | "VOCALOID"
  | "ENKA"
  | "WESTERN"
  | "VTUBER"
  | "DUET";
export type RankingPeriod = "WEEKLY" | "MONTHLY";

type JoysoundCategory = Exclude<RankingCategory, "VTUBER" | "DUET">;

const JOYSOUND_CATEGORY_PATHS: { [category in JoysoundCategory]: string } = {
  OVERALL: "all",
  ANIME: "anime",
  VOCALOID: "vocaloid",
  ENKA: "enka",
  WESTERN: "foreign",
};

function isJoysoundCategory(
  category: RankingCategory,
): category is JoysoundCategory {
  return category in JOYSOUND_CATEGORY_PATHS;
}

// DAM's overall chart lives on /ranking/ with differently-named section ids
// than the per-genre pages (weekly-ranking vs ranking-weekly, really). DUET
// is also rooted at /ranking/ (not /genre/) but its page happens to carry
// both id spellings, so either works; VTUBER is a normal /genre/ page.
const DAM_GENRE_PATHS: {
  [category in Exclude<RankingCategory, "OVERALL" | "DUET">]: string;
} = {
  ANIME: "anison",
  VOCALOID: "vocaloid",
  ENKA: "enka",
  WESTERN: "foreign",
  VTUBER: "vtuber",
};

// A YYYYMM string selects a past monthly archive (JOYSOUND keeps ~5); null or
// a non-monthly period uses the current chart.
function joysoundRankingUrl(
  category: JoysoundCategory,
  period: RankingPeriod,
  month?: string | null,
): string {
  const base = `https://www.joysound.com/web/karaoke/ranking/${
    JOYSOUND_CATEGORY_PATHS[category]
  }/${period.toLowerCase()}`;
  return period === "MONTHLY" && month ? `${base}/${month}` : base;
}

function joysoundArtistRankingUrl(
  period: RankingPeriod,
  month?: string | null,
): string {
  const base = `https://www.joysound.com/web/karaoke/ranking/artist/${period.toLowerCase()}`;
  return period === "MONTHLY" && month ? `${base}/${month}` : base;
}

function damRankingSource(
  category: RankingCategory,
  period: RankingPeriod,
): { url: string; sectionId: string } {
  if (category === "OVERALL" || category === "DUET") {
    return {
      url:
        category === "OVERALL"
          ? "https://www.clubdam.com/ranking/"
          : "https://www.clubdam.com/ranking/duet/",
      sectionId: period === "WEEKLY" ? "weekly-ranking" : "monthly-ranking",
    };
  }

  return {
    url: `https://www.clubdam.com/genre/${DAM_GENRE_PATHS[category]}/`,
    sectionId: period === "WEEKLY" ? "ranking-weekly" : "ranking-monthly",
  };
}

// Plain-browser UA. Both sites serve the scraped markup to regular
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

// Oricon serves Shift_JIS, unlike joysound.com and clubdam.com, and resp.text()
// would mangle every Japanese title, so its pages are decoded explicitly.
// The final URL comes back too: the dateless weekly URL redirects to the
// newest week, and that's how we learn which week we got.
async function fetchOriconPage(
  url: string,
): Promise<{ html: string; finalUrl: string }> {
  const resp = await nodeFetch(url, {
    agent: tunnelAgent,
    headers: { "User-Agent": USER_AGENT },
  });

  if (!resp.ok) {
    throw new Error(`Ranking fetch for ${url} failed: HTTP ${resp.status}`);
  }

  return {
    html: new TextDecoder("sjis").decode(await resp.arrayBuffer()),
    finalUrl: resp.url,
  };
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
// (e.g. 残酷な天使のテーゼ is 9629 on the web but selSongNo 9630), so the
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
// songleaf link (requestNo, the same id dkwebsys search results use), an
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

// JOYSOUND's artist ranking is the same JSON-LD ItemList shape as the song
// charts, but the items are MusicGroup nodes whose url is
// /web/search/artist/<id>. That id, unlike the song web ids, IS the
// sound-cafe artist id the app's artist pages use, so it's taken directly.
function parseJoysoundArtistRanking(html: string): RankingArtistEntry[] {
  const entries: RankingArtistEntry[] = [];

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
        const idMatch = String(listItem?.item?.url || "").match(
          /\/web\/search\/artist\/(\d+)/,
        );
        if (name && idMatch) {
          entries.push({
            rank: listItem.position || entries.length + 1,
            id: idMatch[1],
            name,
          });
        }
      }
    }
  }

  return entries;
}

// DAM's artist chart (/ranking/artist/) reuses the song-list markup, but each
// <li> links to artistleaf?artistCode=<id> (the dkwebsys artist id the app's
// DAM artist pages use) and carries only <h4 class="p-song__title">, with no
// artist sub-line, since the title *is* the artist.
function parseDamArtistRanking(
  html: string,
  sectionId: string,
): RankingArtistEntry[] {
  const afterSection = html.split(`id="${sectionId}"`)[1];
  if (!afterSection) return [];

  const nextSectionStart = afterSection.indexOf('class="c-section"');
  const section =
    nextSectionStart === -1
      ? afterSection
      : afterSection.slice(0, nextSectionStart);

  const entries: RankingArtistEntry[] = [];
  const seen = new Set<string>();

  for (const li of section.matchAll(
    /artistleaf\.html\?artistCode=(\d+)"[\s\S]*?p-song__title">([^<]*)</g,
  )) {
    if (seen.has(li[1])) continue;
    seen.add(li[1]);

    entries.push({
      rank: entries.length + 1,
      id: li[1],
      name: decodeHtmlEntities(li[2].trim()),
    });
  }

  return entries;
}

// The JOYSOUND monthly month-picker: each <a href=".../monthly[/YYYYMM]">M月</a>
// in the archive selector, newest first. The suffix-less link is the current
// month (value null); the rest are past archives.
function parseJoysoundRankingMonths(html: string): RankingMonth[] {
  const months: RankingMonth[] = [];
  const seen = new Set<string>();

  for (const m of html.matchAll(
    /href="\/web\/karaoke\/ranking\/[a-z]+\/monthly(?:\/(\d{6}))?"[^>]*>\s*(\d{1,2}月)\s*</g,
  )) {
    const value = m[1] || null;
    const dedupeKey = value || "current";
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    months.push({ value, label: m[2] });
  }

  return months;
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
// fetch, where JOYSOUND resolves ~100 songs against the search API, is paid
// once and survives relaunches. A cached chart stays fresh for the whole period
// window it belongs to (a weekly chart until the calendar week rolls over, a
// monthly chart until the month does), matching how often the sources actually
// change; a stale chart is refetched but served from cache in the meantime if
// the refetch fails. Entries are one of the ranking shapes (songs, artists) or
// the month list; the cache is generic and the on-disk JSON is shape-agnostic,
// so all of them share one persisted file keyed by service:kind:params.
interface CachedRanking {
  fetchedAt: number;
  entries: unknown[];
}

const rankingCache = new Map<string, CachedRanking>();
// In-flight scrape per key, so concurrent page visits (and the launch
// prefetch) don't kick off duplicate work.
const inflightRankings = new Map<string, Promise<unknown[]>>();

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
    // No cache yet (or corrupt / unreadable), so start empty.
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function rankingCacheJson(): string {
  const obj: { [key: string]: CachedRanking } = {};
  for (const [key, value] of rankingCache) obj[key] = value;
  return JSON.stringify(obj);
}

function saveRankingCache(): void {
  // Debounce so a burst of prefetches writes the file once.
  if (saveTimer) return;

  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(RANKING_CACHE_PATH, rankingCacheJson(), (err) => {
      if (err) console.warn("Failed to persist rankings cache:", err);
    });
  }, 1000);

  saveTimer.unref?.();
}

// Called on process shutdown so a pending debounced write isn't lost to a
// SIGTERM/SIGINT landing before the 1s debounce fires. Synchronous, since an
// async write racing process exit could still get dropped.
export function flushRankingCacheOnShutdown(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    fs.writeFileSync(RANKING_CACHE_PATH, rankingCacheJson(), "utf-8");
  } catch (e) {
    console.warn("Failed to persist rankings cache:", e);
  }
}

// Monday-anchored week key (local time), so two dates in the same week share
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
// persist, and return. If a stale refresh fails, fall back to the stale
// entries rather than erroring (an old chart beats none). Only a cold-cache
// failure propagates so the remocon can show a retry.
function withRankingCache<T>(
  key: string,
  period: RankingPeriod,
  fetchRanking: () => Promise<T[]>,
): Promise<T[]> {
  const cached = rankingCache.get(key);
  if (cached && isFresh(cached, period)) {
    return Promise.resolve(cached.entries as T[]);
  }

  const inflight = inflightRankings.get(key);
  if (inflight) return inflight as Promise<T[]>;

  const promise = fetchRanking()
    .then((entries) => {
      rankingCache.set(key, { fetchedAt: Date.now(), entries });
      saveRankingCache();
      return entries;
    })
    .catch((error) => {
      if (cached) {
        console.warn(`Refreshing ranking ${key} failed; serving stale:`, error);
        return cached.entries as T[];
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
  month?: string | null,
): Promise<RankingSongEntry[]> {
  if (!isJoysoundCategory(category)) {
    return Promise.reject(
      new Error(`JOYSOUND has no ${category} ranking (DAM-only category)`),
    );
  }

  const monthKey = period === "MONTHLY" && month ? month : "current";
  return withRankingCache<RankingSongEntry>(
    `joysound:${category}:${period}:${monthKey}`,
    period,
    async () => {
      const chart = parseJoysoundRanking(
        await fetchPage(joysoundRankingUrl(category, period, month)),
      ).slice(0, 100);

      // An empty parse means the page layout changed, not an empty chart, so
      // surface it as an error and the remocon shows a retry instead of a
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
      // every catalog lookup errored the whole result is garbage, so throw and
      // it isn't persisted and the next visit retries instead of pinning a
      // fully unclickable chart for the period.
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
  return withRankingCache<RankingSongEntry>(
    `dam:${category}:${period}`,
    period,
    async () => {
      const { url, sectionId } = damRankingSource(category, period);
      const entries = parseDamRanking(await fetchPage(url), sectionId);

      if (entries.length === 0) {
        throw new Error("Failed to parse any songs out of the DAM ranking");
      }

      return entries.slice(0, 100);
    },
  );
}

export function getJoysoundArtistRanking(
  period: RankingPeriod,
  month?: string | null,
): Promise<RankingArtistEntry[]> {
  const monthKey = period === "MONTHLY" && month ? month : "current";
  return withRankingCache<RankingArtistEntry>(
    `joysound:ARTIST:${period}:${monthKey}`,
    period,
    async () => {
      const entries = parseJoysoundArtistRanking(
        await fetchPage(joysoundArtistRankingUrl(period, month)),
      ).slice(0, 100);

      if (entries.length === 0) {
        throw new Error(
          "Failed to parse any artists out of the JOYSOUND artist ranking",
        );
      }

      return entries;
    },
  );
}

export function getDamArtistRanking(
  period: RankingPeriod,
): Promise<RankingArtistEntry[]> {
  return withRankingCache<RankingArtistEntry>(
    `dam:ARTIST:${period}`,
    period,
    async () => {
      const sectionId =
        period === "WEEKLY" ? "weekly-ranking" : "monthly-ranking";
      const entries = parseDamArtistRanking(
        await fetchPage("https://www.clubdam.com/ranking/artist/"),
        sectionId,
      );

      if (entries.length === 0) {
        throw new Error(
          "Failed to parse any artists out of the DAM artist ranking",
        );
      }

      return entries.slice(0, 100);
    },
  );
}

// Oricon's chart pages, weekly and yearly alike, render each entry as a
// <section class="box-rank-entry"> holding the rank, title and artist. No
// catalog ids anywhere: it's a third-party chart, so rows are mapped onto
// singable songs later, by search.
function parseOriconRanking(html: string): OriconChartEntry[] {
  const entries: OriconChartEntry[] = [];
  const blocks =
    html.match(/<section class="box-rank-entry[\s\S]*?<\/section>/g) || [];

  for (const block of blocks) {
    const pick = (pattern: RegExp): string | null => {
      const matched = block.match(pattern);
      return matched
        ? decodeHtmlEntities(matched[1].replace(/<[^>]+>/g, "")).trim()
        : null;
    };

    const rank = pick(/<p class="num[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const name = pick(/<h2 class="title[^"]*"[^>]*>([\s\S]*?)<\/h2>/);
    const artistName = pick(/<p class="name[^"]*"[^>]*>([\s\S]*?)<\/p>/);

    if (!rank || !name) continue;

    entries.push({
      rank: Number(rank.replace(/\D/g, "")),
      name,
      artistName: artistName || "",
    });
  }

  return entries;
}

// Oricon publishes karaoke charts weekly and yearly only. There is no
// /rank/ko/m/ monthly page (404). Past years are paywalled and immutable, so
// they're a static table in common/oriconChart.ts; only the current week has
// to be fetched. The dateless /rank/ko/w/ redirects to the newest week, so
// this needs no date arithmetic. Which week we landed on is read back off
// the final URL.
//
// The weekly chart is a Top 20 split over two pages (…/ and …/p/2/), unlike the
// yearly one, which really is a Top 10, since /y/<year>/p/2/ 404s. Page 2 is
// best-effort: a chart of 10 beats erroring out of the whole thing.
//
// Cached with weekly freshness, so this is two fetches per calendar week,
// which is what keeps a rate-limit-happy site at arm's length.
export function getOriconWeeklyRanking(): Promise<OriconWeeklyChart> {
  return withRankingCache<OriconWeeklyChart>(
    "oricon:WEEKLY",
    "WEEKLY",
    async () => {
      const { html, finalUrl } = await fetchOriconPage(
        "https://www.oricon.co.jp/rank/ko/w/",
      );
      const songs = parseOriconRanking(html);

      if (songs.length === 0) {
        throw new Error(
          "Failed to parse any songs out of the Oricon weekly ranking",
        );
      }

      try {
        const second = await fetchOriconPage(`${finalUrl}p/2/`);
        songs.push(...parseOriconRanking(second.html));
      } catch (error) {
        console.warn("Oricon weekly ranking page 2 failed:", error);
      }

      const dated = finalUrl.match(/\/w\/(\d{4}-\d{2}-\d{2})\//);

      return [{ date: dated ? dated[1] : "", songs: songs.slice(0, 20) }];
    },
  ).then(([chart]) => chart);
}

// The month-picker options are the same across all JOYSOUND monthly charts, so
// scrape them once from the overall page. Cached with monthly freshness (the
// archive set only grows when the month rolls over).
export function getJoysoundRankingMonths(): Promise<RankingMonth[]> {
  return withRankingCache<RankingMonth>(
    "joysound:MONTHS",
    "MONTHLY",
    async () => {
      const months = parseJoysoundRankingMonths(
        await fetchPage(joysoundRankingUrl("OVERALL", "MONTHLY")),
      );

      if (months.length === 0) {
        throw new Error("Failed to parse the JOYSOUND month picker");
      }

      return months;
    },
  );
}

const ALL_DAM_CATEGORIES: RankingCategory[] = [
  "OVERALL",
  "ANIME",
  "VOCALOID",
  "ENKA",
  "WESTERN",
  "VTUBER",
  "DUET",
];
const ALL_JOYSOUND_CATEGORIES: JoysoundCategory[] = [
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
// guarded so one failure neither stops the sweep nor, critically, escapes as
// an unhandled rejection (which would take the whole app down).
//
// `onEntries` (if given) is handed each resolved chart's entries so the caller
// can enrich them out-of-band, used to prime DAM's canonical readings for the
// chart rows, which the scrapes themselves don't carry. It must not throw; it
// runs inside the guarded sweep but is otherwise fire-and-forget.
export function primeRankings(
  joysoundApi: JoysoundAPI,
  onEntries?: (entries: RankingSongEntry[]) => void,
  onArtistEntries?: (entries: RankingArtistEntry[]) => void,
): void {
  loadRankingCache();

  void (async () => {
    // The month list first, so the picker is populated before anyone opens a
    // monthly chart. Past-month archives themselves stay on-demand.
    await getJoysoundRankingMonths().catch((error) =>
      console.warn("Prefetch joysound months failed:", error),
    );

    for (const period of ALL_PERIODS) {
      for (const category of ALL_DAM_CATEGORIES) {
        await getDamRanking(category, period)
          .then((entries) => onEntries?.(entries))
          .catch((error) =>
            console.warn(`Prefetch dam ${category} ${period} failed:`, error),
          );
      }
      for (const category of ALL_JOYSOUND_CATEGORIES) {
        await getJoysoundRanking(joysoundApi, category, period)
          .then((entries) => onEntries?.(entries))
          .catch((error) =>
            console.warn(
              `Prefetch joysound ${category} ${period} failed:`,
              error,
            ),
          );
      }

      // Artist charts (current month only; past-month archives on demand).
      await getDamArtistRanking(period)
        .then((entries) => onArtistEntries?.(entries))
        .catch((error) =>
          console.warn(`Prefetch dam artists ${period} failed:`, error),
        );
      await getJoysoundArtistRanking(period)
        .then((entries) => onArtistEntries?.(entries))
        .catch((error) =>
          console.warn(`Prefetch joysound artists ${period} failed:`, error),
        );
    }
  })();
}
