// Scrapers for the public JOYSOUND / DAM weekly karaoke rankings, used to
// back the remocon's "Top 100" pages. Both sites embed their catalog song
// ids directly in the ranking markup (JOYSOUND as /web/search/song/<id>
// links in a schema.org JSON-LD ItemList, DAM as songleaf requestNo query
// params), so entries map straight onto the same ids the search flows use.
import nodeFetch from "node-fetch";
import tunnel from "tunnel";

import karafriendsConfig from "../common/config";
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

const JOYSOUND_RANKING_URL =
  "https://www.joysound.com/web/karaoke/ranking/all/weekly";
const DAM_RANKING_URL = "https://www.clubdam.com/ranking/";

// Rankings only change weekly; an hour keeps repeat page visits free while
// still picking up the weekly rollover within the same karaoke session.
const RANKING_CACHE_TTL_MS = 60 * 60 * 1000;

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

// clubdam.com/ranking/ carries daily/weekly/monthly top-100 sections in one
// page; each weekly <li> holds a songleaf link (requestNo — the same id
// dkwebsys search results use), an <h4 class="p-song__title"> and a
// <div class="p-song__artist">.
function parseDamRanking(html: string): RankingSongEntry[] {
  const weeklySection = html
    .split('id="weekly-ranking"')[1]
    ?.split('id="ranking-monthly"')[0];

  if (!weeklySection) return [];

  const entries: RankingSongEntry[] = [];

  for (const li of weeklySection.matchAll(
    /songleaf\.html\?requestNo=([0-9-]+)"[\s\S]*?p-song__title">([^<]*)<[\s\S]*?p-song__artist">([^<]*)</g,
  )) {
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

// TTL-cached fetch with failure eviction: a successful scrape is reused for
// the TTL, but a rejected one is dropped immediately so the next page visit
// retries instead of serving a stuck error until relaunch.
function cachedRanking<Args extends unknown[]>(
  fetchRanking: (...args: Args) => Promise<RankingSongEntry[]>,
): (...args: Args) => Promise<RankingSongEntry[]> {
  let cached: {
    fetchedAt: number;
    promise: Promise<RankingSongEntry[]>;
  } | null = null;

  return (...args: Args) => {
    if (cached && Date.now() - cached.fetchedAt < RANKING_CACHE_TTL_MS) {
      return cached.promise;
    }

    const promise = fetchRanking(...args).catch((error) => {
      cached = null;
      throw error;
    });
    cached = { fetchedAt: Date.now(), promise };

    return promise;
  };
}

export const getJoysoundRanking = cachedRanking(
  async (joysoundApi: JoysoundAPI) => {
    const chart = parseJoysoundRanking(
      await fetchPage(JOYSOUND_RANKING_URL),
    ).slice(0, 100);

    // An empty parse means the page layout changed, not an empty chart —
    // surface it as an error so the remocon shows a retry instead of a
    // blank-but-successful page.
    if (chart.length === 0) {
      throw new Error("Failed to parse any songs out of the JOYSOUND ranking");
    }

    const entries = await mapWithConcurrency(chart, 6, (entry) =>
      resolveJoysoundEntry(joysoundApi, entry),
    );

    // No-match entries are expected (catalog gaps) and cacheable, but if
    // every catalog lookup errored the whole result is garbage — throw so
    // the failure eviction retries next visit instead of pinning a fully
    // unclickable chart for the TTL.
    if (
      entries.every((entry) => entry.searchFailed) &&
      entries.some((entry) => entry.searchFailed)
    ) {
      throw new Error("All JOYSOUND ranking catalog lookups failed");
    }

    return entries.map(({ searchFailed, ...entry }) => entry);
  },
);

export const getDamRanking = cachedRanking(async () => {
  const entries = parseDamRanking(await fetchPage(DAM_RANKING_URL));

  if (entries.length === 0) {
    throw new Error("Failed to parse any songs out of the DAM ranking");
  }

  return entries.slice(0, 100);
});
