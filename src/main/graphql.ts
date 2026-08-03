// Aliased: `app` is the express Application in applyGraphQLMiddleware below.
import { app as electronApp } from "electron"; // tslint:disable-line:no-implicit-dependencies
import fs from "fs";
import { createServer } from "http";
import path from "path";
import { WebSocketServer } from "ws";

import { ApolloServer } from "@apollo/server"; // tslint:disable-line:no-submodule-imports
import {
  ApolloServerPluginCacheControlDisabled,
  ApolloServerPluginInlineTraceDisabled,
  ApolloServerPluginLandingPageDisabled,
  ApolloServerPluginSchemaReportingDisabled,
  ApolloServerPluginUsageReportingDisabled,
} from "@apollo/server/plugin/disabled"; // tslint:disable-line:no-submodule-imports
// tslint:disable-next-line:no-submodule-imports
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import { type Fetcher, type FetcherRequestInit } from "@apollo/utils.fetcher";
// tslint:disable-next-line:no-submodule-imports
import { expressMiddleware } from "@as-integrations/express5";
import { makeExecutableSchema } from "@graphql-tools/schema";
import isDev from "electron-is-dev";
import express, { Application } from "express";
import { PubSub } from "graphql-subscriptions";
import { useServer } from "graphql-ws/use/ws"; // tslint:disable-line:no-submodule-imports
import Kuroshiro from "kuroshiro";
import KuromojiAnalyzer from "kuroshiro-analyzer-kuromoji";
import { Nicovideo } from "niconico";
import nodeFetch from "node-fetch";
import tunnel from "tunnel";
import { Innertube } from "youtubei.js";

// tslint:disable-next-line:no-submodule-imports no-implicit-dependencies
import rawSchema from "inline-string:../common/schema.graphql";
import { BGM_TRACKS, SHUFFLE_VALUE } from "../common/bgmTracks";
import karafriendsConfig, { KarafriendsConfig } from "../common/config";
import {
  DEFAULT_MIC_RMS_GATE_THRESHOLD,
  HOSTNAME,
  MAX_MIC_RMS_GATE_THRESHOLD,
  MIN_MIC_RMS_GATE_THRESHOLD,
} from "../common/constants";
import ipAddresses from "../common/ipAddresses";
import {
  decodeJoysoundBase64Field,
  getSongDuration,
} from "../common/joysoundParser";
import { SCORING_FORMULA_VERSION } from "../common/scoring";
import { parseScoringData } from "../common/scoringData";
import {
  downloadDamVideo,
  downloadJoysoundData,
  downloadNicoVideo,
  downloadYoutubeVideo,
  getVideoDownloadProgress,
  TEMP_FOLDER,
} from "./../common/videoDownloader";
import { DkwebsysAPI, MinseiAPI, MinseiCredentialsProvider } from "./damApi";
import { JoysoundAPI, JoysoundCredentialsProvider } from "./joysoundApi";
import {
  ensureJoysoundGuideMelody,
  getJoysoundScoringData,
  hasCachedGuideMelody,
} from "./joysoundMelody";
import memoizeWithFailureEviction from "./memoizeWithFailureEviction";
import {
  claimPerson,
  createPerson,
  deletePerson,
  flushPeople,
  listPeople,
  loadPeople,
  Person,
  personByDevice,
  resolvePerson,
  touchPerson,
  updatePersonProfile,
} from "./people";
import {
  getDamArtistRanking,
  getDamRanking,
  getJoysoundArtistRanking,
  getJoysoundRanking,
  getJoysoundRankingMonths,
  getOriconWeeklyRanking,
  OriconWeeklyChart,
  primeRankings,
  RankingArtistEntry,
  RankingCategory,
  RankingMonth,
  RankingPeriod,
  RankingSongEntry,
} from "./rankings";
import {
  loadScores,
  recordScore as persistScore,
  scoreHistoryFor,
} from "./scores";

import "regenerator-runtime/runtime"; // tslint:disable-line:no-submodule-imports
import { isRomaji, toHiragana, toKana, toKatakana } from "wanakana";

export interface IDataSources {
  dataSources: {
    minsei: MinseiAPI;
    joysound: JoysoundAPI;
    dkwebsys: DkwebsysAPI;
    // Lazy: Innertube.create() hits youtube.com, and awaiting it in the
    // per-request context factory made EVERY GraphQL request (including
    // trivial local reads like bgmTrack right after launch) hang on YouTube
    // being reachable. Only the resolvers that actually talk to YouTube
    // await this.
    youtube: () => Promise<Innertube>;
  };
}

// Joysound's search API returns no reading data for song/artist names, unlike
// DAM's dkwebsys API. We fall back to guessing a reading via the same
// kuromoji dictionary-based analyzer already used for Joysound lyric
// furigana (see src/common/joysoundParser.ts), running it here in the main
// process so the dictionary never ships to the remocon's mobile bundle.
// Parcel bundles bake in each module's *source* directory as __dirname
// rather than its built location (see remoconReverseProxy.ts for the same
// pattern), so we have to walk back up to the repo root and back down into
// whichever build output directory is actually running.
const kuroshiro = new Kuroshiro();
const kuroshiroReady = kuroshiro.init(
  new KuromojiAnalyzer({
    dictPath: path.join(
      __dirname,
      "..",
      "..",
      "build",
      isDev ? "dev" : "prod",
      "main_",
      "dict",
    ),
  }),
);

// JOYSOUND artist strings frequently carry voice-actor / featured-artist
// metadata like "涼宮ハルヒ(C.V.平野綾)" or "○○ feat. △△". Beyond cluttering
// the helper romaji, the interposed Latin "(C.V." tokens actively derail
// kuromoji's tokenizer onto the wrong reading for the *surrounding* kanji:
// 平野 in "涼宮ハルヒ(C.V.平野綾)" mis-reads as ヘイヤ, yet 平野綾 on its own
// reads correctly as ひらのあや. Strip the noise before the reading guess so
// it neither corrupts adjacent names nor leaks into the output.
const READING_NOISE_PATTERNS = [
  // (C.V. …) / （Ｃ．Ｖ．…） / (CV：…) — round parens, half/full width, opening
  // with a C(.)V / CV voice-actor marker.
  /[(（]\s*[cCｃＣ][.．]?\s*[vVｖＶ][.．：:]*[^)）]*[)）]/g,
  // feat. / ft. / featuring … — consume to the end of the string (the guest
  // credit is always a trailing clause on the primary artist name).
  /\s*(?:feat|ft|featuring)\.?\s.*$/gi,
];

function stripReadingNoise(text: string): string {
  return READING_NOISE_PATTERNS.reduce(
    (acc, pattern) => acc.replace(pattern, ""),
    text,
  ).trim();
}

function normalizeForYomiMatch(name: string): string {
  // Strip dot-like separators too: DAM and JOYSOUND punctuate the same artist
  // differently (e.g. DAM "涼宮ハルヒ(CV.平野綾)" vs JOYSOUND "涼宮ハルヒ(C.V.平野綾)"),
  // which otherwise keys them separately and hides DAM's canonical reading
  // (スズミヤ) behind a kuromoji guess (リョウミヤ) on the JOYSOUND row.
  return name
    .normalize("NFKC")
    .replace(/[.・·]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

// Helper romaji is resolved from three sources of decreasing quality: DAM's
// human-curated katakana readings (canonical), a kuromoji IPADIC guess, and
// this cache of everything we've already resolved. Persisting the cache
// means a name we paid a DAM lookup or a kuromoji pass for once keeps its
// reading across restarts, and — together with the snapshot taken in
// pushSongToQueue — a queued song keeps the canonical reading its search
// found even after the app reloads. Keyed by normalized name; a canonical
// (DAM) entry is authoritative and never downgraded by a later guess.
interface CachedReading {
  yomi: string;
  canonical: boolean;
}
const readingCache = new Map<string, CachedReading>();
const READING_CACHE_PATH = path.resolve(TEMP_FOLDER, "reading-cache.json");

function loadReadingCache(): void {
  try {
    if (!fs.existsSync(READING_CACHE_PATH)) return;
    const parsed = JSON.parse(fs.readFileSync(READING_CACHE_PATH, "utf-8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (value && typeof (value as CachedReading).yomi === "string") {
        readingCache.set(key, value as CachedReading);
      }
    }
  } catch (e) {
    console.error("[yomi] failed to load reading cache", e);
  }
}

let readingCacheSaveTimer: ReturnType<typeof setTimeout> | null = null;
function writeReadingCacheToDisk(): void {
  try {
    if (!fs.existsSync(TEMP_FOLDER)) fs.mkdirSync(TEMP_FOLDER);
    fs.writeFileSync(
      READING_CACHE_PATH,
      JSON.stringify(Object.fromEntries(readingCache)),
      "utf-8",
    );
  } catch (e) {
    console.error("[yomi] failed to save reading cache", e);
  }
}

function scheduleReadingCacheSave(): void {
  if (readingCacheSaveTimer) return;
  // Debounced: one search primes dozens of entries at once, so coalesce them
  // into a single write rather than thrashing the disk per name.
  readingCacheSaveTimer = setTimeout(() => {
    readingCacheSaveTimer = null;
    writeReadingCacheToDisk();
  }, 2000);
}

// Called on process shutdown so a pending debounced write (or one that never
// got scheduled because the process died mid-sweep) isn't lost — otherwise
// every name resolved in the last 2s (or the whole in-flight primeRankings
// sweep, if killed before its first debounce fires) gets re-searched against
// DAM/JOYSOUND on the next launch instead of hitting the persisted cache.
export function flushReadingCacheOnShutdown(): void {
  if (readingCacheSaveTimer) {
    clearTimeout(readingCacheSaveTimer);
    readingCacheSaveTimer = null;
  }
  writeReadingCacheToDisk();
  // Same deal for the DAM prime markers (declared further down): losing them
  // means the next launch re-searches the whole ranking sweep.
  if (damPrimeMarkerSaveTimer) {
    clearTimeout(damPrimeMarkerSaveTimer);
    damPrimeMarkerSaveTimer = null;
  }
  writeDamPrimeMarkersToDisk();
  // And the people registry, whose lastSeenAt bumps are debounced the same
  // way. Losing one only misorders the picker, but it's a one-line flush.
  flushPeople();
}

function cacheReading(name: string, yomi: string, canonical: boolean): void {
  if (!name || !yomi) return;
  const key = normalizeForYomiMatch(name);
  const existing = readingCache.get(key);
  if (existing) {
    // Never let a kuromoji guess clobber a canonical reading, and skip no-op
    // writes so we don't schedule needless saves.
    if (existing.canonical && !canonical) return;
    if (existing.yomi === yomi && existing.canonical === canonical) return;
  }
  readingCache.set(key, { yomi, canonical });
  scheduleReadingCacheSave();
}

function getCachedReading(name: string): string | null {
  return readingCache.get(normalizeForYomiMatch(name))?.yomi ?? null;
}

async function toYomi(text: string): Promise<string> {
  const cached = getCachedReading(text);
  if (cached) return cached;

  await kuroshiroReady;
  const cleaned = stripReadingNoise(text) || text;
  const yomi = await kuroshiro.convert(cleaned, {
    to: "hiragana",
    mode: "normal",
  });
  cacheReading(text, yomi, false);
  return yomi;
}

// JOYSOUND's artist-search API returns no per-artist song count (unlike DAM's
// holdMusicCount), so it's derived by fetching a capped page of the artist's
// song list and counting results — an extra request per artist the first
// time it's shown. Cached to disk (keyed by artist id) so repeat searches
// are free; a count that hits the cap is an undercount for very prolific
// artists, which we accept rather than paginating the whole catalog.
const JOYSOUND_ARTIST_SONG_COUNT_CAP = 200;
const joysoundArtistSongCountCache = new Map<string, number>();
const JOYSOUND_ARTIST_SONG_COUNT_CACHE_PATH = path.resolve(
  TEMP_FOLDER,
  "joysound-artist-song-count-cache.json",
);

function loadJoysoundArtistSongCountCache(): void {
  try {
    if (!fs.existsSync(JOYSOUND_ARTIST_SONG_COUNT_CACHE_PATH)) return;
    const parsed = JSON.parse(
      fs.readFileSync(JOYSOUND_ARTIST_SONG_COUNT_CACHE_PATH, "utf-8"),
    );
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number") {
        joysoundArtistSongCountCache.set(key, value);
      }
    }
  } catch (e) {
    console.error("[joysound] failed to load artist song count cache", e);
  }
}

let joysoundArtistSongCountSaveTimer: ReturnType<typeof setTimeout> | null =
  null;
function scheduleJoysoundArtistSongCountCacheSave(): void {
  if (joysoundArtistSongCountSaveTimer) return;
  joysoundArtistSongCountSaveTimer = setTimeout(() => {
    joysoundArtistSongCountSaveTimer = null;
    try {
      if (!fs.existsSync(TEMP_FOLDER)) fs.mkdirSync(TEMP_FOLDER);
      fs.writeFileSync(
        JOYSOUND_ARTIST_SONG_COUNT_CACHE_PATH,
        JSON.stringify(Object.fromEntries(joysoundArtistSongCountCache)),
        "utf-8",
      );
    } catch (e) {
      console.error("[joysound] failed to save artist song count cache", e);
    }
  }, 2000);
}

const joysoundArtistSongCountInFlight = new Map<string, Promise<number>>();

function getJoysoundArtistSongCount(
  artistId: string,
  joysound: JoysoundAPI,
): Promise<number> {
  const cached = joysoundArtistSongCountCache.get(artistId);
  if (cached !== undefined) return Promise.resolve(cached);

  const inFlight = joysoundArtistSongCountInFlight.get(artistId);
  if (inFlight) return inFlight;

  const promise = joysound
    .getSongListByArtist(artistId, 1, JOYSOUND_ARTIST_SONG_COUNT_CAP)
    .then((result) => {
      const count = result.length;
      joysoundArtistSongCountCache.set(artistId, count);
      scheduleJoysoundArtistSongCountCacheSave();
      return count;
    })
    .finally(() => {
      joysoundArtistSongCountInFlight.delete(artistId);
    });

  joysoundArtistSongCountInFlight.set(artistId, promise);
  return promise;
}

// DAM's dkwebsys search returns human-curated katakana readings inline
// (titleYomi/artistYomi), including correct proper-noun readings that
// kuromoji's IPADIC dictionary simply doesn't carry (e.g. 涼宮→スズミヤ,
// where kuromoji shatters it into 涼(リョウ)+宮(ミヤ)). We issue the *same*
// keyword the user searched to DAM once and fold every returned title/artist
// into the reading cache as canonical, so JOYSOUND rows — and any song later
// queued — whose normalized name matches resolve to DAM's reading instead of
// kuromoji's guess (see the God knows.../涼宮ハルヒ case). One DAM search per
// query, deduped; failures are best-effort and leave the kuromoji fallback
// in place.
const damPrimeCache = new Map<string, Promise<boolean>>();

// DAM's keyword search matches by *reading*, not by string: searching
// リンゴの唄 returns songs titled りんごのうた and 林檎の唄, and Western titles
// come back with trailing katakana annotations ("Billie Jean [ビリー・ジーン]"
// for BILLIE JEAN). So a successful prime often caches canonical readings only
// under the *returned* titles' keys, never under the searched name's own key —
// which is what the ranking sweeps below key their already-done skip on. Left
// alone, those names get re-searched on every single launch forever. These
// markers persist "this exact name was primed recently, whatever came of it";
// the sweeps skip a marked name until the marker expires (the TTL keeps new
// DAM catalog additions reachable eventually).
const DAM_PRIME_MARKER_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const damPrimeMarkers = new Map<string, number>();
const DAM_PRIME_MARKER_PATH = path.resolve(
  TEMP_FOLDER,
  "dam-prime-markers.json",
);

function damPrimeMarkerKey(mode: "song" | "artist", name: string): string {
  return `${mode}:${normalizeForYomiMatch(name)}`;
}

function loadDamPrimeMarkers(): void {
  try {
    if (!fs.existsSync(DAM_PRIME_MARKER_PATH)) return;
    const parsed = JSON.parse(fs.readFileSync(DAM_PRIME_MARKER_PATH, "utf-8"));
    const cutoff = Date.now() - DAM_PRIME_MARKER_TTL_MS;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && value > cutoff) {
        damPrimeMarkers.set(key, value);
      }
    }
  } catch (e) {
    console.error("[yomi] failed to load DAM prime markers", e);
  }
}

let damPrimeMarkerSaveTimer: ReturnType<typeof setTimeout> | null = null;
function writeDamPrimeMarkersToDisk(): void {
  try {
    if (!fs.existsSync(TEMP_FOLDER)) fs.mkdirSync(TEMP_FOLDER);
    fs.writeFileSync(
      DAM_PRIME_MARKER_PATH,
      JSON.stringify(Object.fromEntries(damPrimeMarkers)),
      "utf-8",
    );
  } catch (e) {
    console.error("[yomi] failed to save DAM prime markers", e);
  }
}

function scheduleDamPrimeMarkerSave(): void {
  if (damPrimeMarkerSaveTimer) return;
  damPrimeMarkerSaveTimer = setTimeout(() => {
    damPrimeMarkerSaveTimer = null;
    writeDamPrimeMarkersToDisk();
  }, 2000);
}

function markDamPrimed(mode: "song" | "artist", name: string): void {
  damPrimeMarkers.set(damPrimeMarkerKey(mode, name), Date.now());
  scheduleDamPrimeMarkerSave();
}

function isDamPrimedRecently(mode: "song" | "artist", name: string): boolean {
  const primedAt = damPrimeMarkers.get(damPrimeMarkerKey(mode, name));
  return (
    primedAt !== undefined && primedAt > Date.now() - DAM_PRIME_MARKER_TTL_MS
  );
}

// Bracketed segments are annotations, not part of the name: DAM suffixes
// Western titles with katakana readings ("Billie Jean [ビリー・ジーン]") and
// its ranking entries carry the same style. Strip them before comparing two
// names so an annotation-only difference still counts as the same name;
// anything fuzzier (kana/kanji spelling variants) deliberately doesn't match.
function stripTitleAnnotations(text: string): string {
  return text.replace(/[[［][^\]］]*[\]］]/g, " ").trim();
}

type ReadingPair = readonly [string, string];

// Beyond folding in every returned name, credit the searched name itself
// when results differ from it only by bracket annotations: all such
// matches must agree on a single reading (else it's ambiguous and skipped).
// This is what lets a ranking entry like "BILLIE JEAN" pick up DAM's
// reading from "Billie Jean [ビリー・ジーン]" under its own cache key.
function withKeywordSelfCredit(
  keyword: string,
  pairs: ReadingPair[],
  matched: ReadingPair[],
): ReadingPair[] {
  const target = normalizeForYomiMatch(stripTitleAnnotations(keyword));
  if (!target) return pairs;

  const matchYomis = new Set(
    matched
      .filter(
        ([name]) =>
          normalizeForYomiMatch(stripTitleAnnotations(name)) === target,
      )
      .map(([, yomi]) => yomi),
  );
  return matchYomis.size === 1
    ? [...pairs, [keyword, [...matchYomis][0]] as const]
    : pairs;
}

// The name→reading pairs a DAM song/artist search yields. Split out from
// primeDamReadings so the merged search can fold in the readings from the DAM
// leg it already fetched, instead of paying a second identical request.
function damSongReadingPairs(
  keyword: string,
  list: ReadonlyArray<{
    title: string;
    titleYomi: string;
    artist: string;
    artistYomi: string;
  }>,
): ReadingPair[] {
  return withKeywordSelfCredit(
    keyword,
    list.flatMap((song) => [
      [song.title, song.titleYomi] as const,
      [song.artist, song.artistYomi] as const,
    ]),
    list.map((song) => [song.title, song.titleYomi] as const),
  );
}

function damArtistReadingPairs(
  keyword: string,
  list: ReadonlyArray<{ artist: string; artistYomi: string }>,
): ReadingPair[] {
  const pairs = list.map(
    (artist) => [artist.artist, artist.artistYomi] as const,
  );
  return withKeywordSelfCredit(keyword, pairs, pairs);
}

// Fold canonical readings into the cache and mark the keyword primed, so a
// later per-service search for the same keyword skips its own lookup.
function applyDamReadings(
  mode: "song" | "artist",
  keyword: string,
  pairs: ReadingPair[],
): void {
  for (const [name, yomi] of pairs) cacheReading(name, yomi, true);
  markDamPrimed(mode, keyword);
  damPrimeCache.set(`${mode}:${keyword}`, Promise.resolve(true));
}

// Resolves true when the DAM search itself succeeded (regardless of whether
// any result matched the keyword by name), false on failure.
function primeDamReadings(
  mode: "song" | "artist",
  keyword: string,
  dkwebsys: DkwebsysAPI,
): Promise<boolean> {
  const cacheKey = `${mode}:${keyword}`;
  const cached = damPrimeCache.get(cacheKey);
  if (cached) return cached;

  const pairsPromise =
    mode === "song"
      ? dkwebsys
          .getMusicByKeyword(keyword, 30, 0)
          .then((result) => damSongReadingPairs(keyword, result.list))
      : dkwebsys
          .getArtistByKeyword(keyword, 30, 0)
          .then((result) => damArtistReadingPairs(keyword, result.list));

  const promise = pairsPromise
    .then((pairs) => {
      for (const [name, yomi] of pairs) cacheReading(name, yomi, true);
      markDamPrimed(mode, keyword);
      return true;
    })
    .catch((e) => {
      // Don't poison the dedupe cache on a transient failure — drop it so a
      // later search retries instead of sticking with the failure.
      damPrimeCache.delete(cacheKey);
      console.error(
        `[yomi] DAM canonical-reading lookup failed for "${keyword}"`,
        e,
      );
      return false;
    });

  damPrimeCache.set(cacheKey, promise);
  return promise;
}

// Top 100 chart rows arrive off the public ranking pages with no reading
// data (JOYSOUND's JSON-LD and DAM's HTML both carry name/artist only), so
// their romaji would fall back to a kuromoji guess — unlike search rows, which
// mirror the user's keyword to DAM and pick up DAM's curated readings. There's
// no per-visit keyword to mirror here, so instead prime canonical readings for
// the chart itself: issue one DAM keyword search per charted title (deduped by
// normalized name, and skipped when the name already has a canonical reading),
// folding DAM's titleYomi/artistYomi into the persistent reading cache. Run in
// the background off the launch prefetch (and on-demand chart visits), so the
// ~hundreds of cold-start lookups are paid once — then only new chart entrants
// cost anything, since canonical readings never expire or downgrade. Names
// whose search can never yield a same-key canonical reading (DAM matches
// keywords by reading, so リンゴの唄 only returns りんごのうた/林檎の唄) are
// covered by the persisted prime markers instead — searched once per marker
// TTL, not once per launch. Throttled
// and best-effort: primeDamReadings already swallows its own failures, but the
// outer sweep is guarded too — an unhandled rejection in main takes down the
// whole app.
const RANKING_READING_CONCURRENCY = 4;

function primeRankingReadings(
  entries: RankingSongEntry[],
  dkwebsys: DkwebsysAPI,
): void {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of entries) {
    const key = normalizeForYomiMatch(entry.name);
    if (seen.has(key)) continue;
    seen.add(key);
    // Already have DAM's curated reading for this title — don't spend a search.
    if (readingCache.get(key)?.canonical) continue;
    // Searched this exact name recently and nothing DAM returned matched it
    // by name — don't re-pay the search on every launch.
    if (isDamPrimedRecently("song", entry.name)) continue;
    names.push(entry.name);
  }

  if (names.length === 0) return;

  void (async () => {
    let next = 0;
    const worker = async () => {
      while (next < names.length) {
        await primeDamReadings("song", names[next++], dkwebsys);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(RANKING_READING_CONCURRENCY, names.length) },
        worker,
      ),
    );
  })().catch((e) => console.error("[yomi] ranking reading prime failed", e));
}

// Artist-chart counterpart: the rows carry only an artist name, so prime DAM's
// curated artist readings the same throttled, best-effort way.
function primeRankingArtistReadings(
  entries: RankingArtistEntry[],
  dkwebsys: DkwebsysAPI,
): void {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of entries) {
    const key = normalizeForYomiMatch(entry.name);
    if (seen.has(key)) continue;
    seen.add(key);
    if (readingCache.get(key)?.canonical) continue;
    if (isDamPrimedRecently("artist", entry.name)) continue;
    names.push(entry.name);
  }

  if (names.length === 0) return;

  void (async () => {
    let next = 0;
    const worker = async () => {
      while (next < names.length) {
        await primeDamReadings("artist", names[next++], dkwebsys);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(RANKING_READING_CONCURRENCY, names.length) },
        worker,
      ),
    );
  })().catch((e) =>
    console.error("[yomi] ranking artist reading prime failed", e),
  );
}

// The DAM lookup is a best-effort enrichment layered on top of JOYSOUND's
// own results — never let a slow/unreachable DAM stall the search response
// the user is waiting on. Cap how long we'll wait, then fall back.
const DAM_YOMI_TIMEOUT_MS = 2500;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function dedupeBy<Item, Key>(items: Item[], key: (item: Item) => Key): Item[] {
  const seen = new Set<Key>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// DAM/Joysound's own search backends return results in their own relevance
// order (Joysound: raw popularity; unclear/unordered for DAM), which often
// buries an exact title match under loosely-related ones (e.g. searching
// "tonight tonight tonight" doesn't surface the song literally titled
// "TONIGHT，TONIGHT，TONIGHT" first). Stable-sort by match quality so exact
// and prefix matches float to the top while otherwise preserving the
// backend's own ordering within each tier.
//
// Titles routinely use full-width commas/spaces as separators (a common
// convention for repeated-word JP titles) where a typed query would use
// plain ASCII ones, so normalize punctuation/whitespace before comparing -
// otherwise an otherwise-exact match never registers as tier 0.
function normalizeForTitleMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[,，、]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleMatchTier(title: string, keyword: string): number {
  const normalizedTitle = normalizeForTitleMatch(title);
  const normalizedKeyword = normalizeForTitleMatch(keyword);

  if (!normalizedKeyword) return 2;
  if (normalizedTitle === normalizedKeyword) return 0;
  if (normalizedTitle.startsWith(normalizedKeyword)) return 1;
  return 2;
}

function sortByTitleMatchTier<Item>(
  items: Item[],
  keyword: string,
  getTitle: (item: Item) => string,
): Item[] {
  return [...items].sort(
    (a, b) =>
      titleMatchTier(getTitle(a), keyword) -
      titleMatchTier(getTitle(b), keyword),
  );
}

// Rows fetched per catalog per page of a merged search — so a page holds up
// to twice this many rows. Equal shares matter: JOYSOUND's own default was
// 100 against DAM's 30, which in one list reads as "JOYSOUND with a few DAM
// rows mixed in" rather than a merge.
const SEARCH_PAGE_SIZE = 30;

// Where one catalog's search is up to. Not just an offset: a romaji query is
// really searched as a kana reading of itself (see searchWithRomajiFallback),
// and the next page has to continue *that* keyword — resuming the literal one
// re-runs the search that found nothing and returns an empty page.
interface SearchPosition {
  readonly keyword: string;
  readonly offset: number;
}

// The two catalogs count rows from different origins: DAM from 0, JOYSOUND
// from 1 (its argument reads like a page number and isn't — passing 2 for the
// second page of 30 re-serves rows 2..31, the first page shifted by one).
const DAM_FIRST_OFFSET = 0;
const JOYSOUND_FIRST_OFFSET = 1;

// Cursors are base64 JSON: a keyword is arbitrary text with no separator safe
// to split on. They're opaque to clients, which only echo them back — decode
// one by hand with
// `JSON.parse(Buffer.from(cursor.split("#")[0], "base64").toString())`.
function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

// Edge cursors carry a "#<row>" suffix to stay distinct within a page, which
// is meaningless for resuming — a page is the smallest unit a catalog can be
// asked for — so it's dropped here. base64's alphabet has no "#", so the
// split is safe.
function decodeCursor(after: string | null): unknown {
  if (!after) return null;
  try {
    return JSON.parse(
      Buffer.from(after.split("#")[0], "base64").toString("utf8"),
    );
  } catch (e) {
    return null;
  }
}

function isSearchPosition(value: unknown): value is SearchPosition {
  const position = value as SearchPosition | null;
  return (
    !!position &&
    typeof position.keyword === "string" &&
    typeof position.offset === "number" &&
    Number.isFinite(position.offset)
  );
}

// A merged search advances both catalogs at once, so its cursor carries a
// position for each — independently, since the two may end up paging
// different readings of the same romaji query.
interface SearchCursor {
  readonly dam: SearchPosition;
  readonly joysound: SearchPosition;
}

function initialSearchCursor(keyword: string): SearchCursor {
  return {
    dam: { keyword, offset: DAM_FIRST_OFFSET },
    joysound: { keyword, offset: JOYSOUND_FIRST_OFFSET },
  };
}

function formatSearchCursor(cursor: SearchCursor): string {
  return encodeCursor(cursor);
}

function parseSearchCursor(
  after: string | null,
  keyword: string,
): SearchCursor {
  const initial = initialSearchCursor(keyword);
  const decoded = decodeCursor(after) as Partial<SearchCursor> | null;
  if (!decoded) return initial;

  return {
    dam: isSearchPosition(decoded.dam) ? decoded.dam : initial.dam,
    joysound: isSearchPosition(decoded.joysound)
      ? decoded.joysound
      : initial.joysound,
  };
}

// Each leg advances to the keyword its rows actually came from, at the next
// page of offsets. Only a catalog that answered advances — otherwise a failed
// leg would silently skip a page of its own results once it comes back.
function advanceSearchPosition<T>(
  position: SearchPosition,
  first: number,
  result: PromiseSettledResult<RomajiSearch<T>>,
): SearchPosition {
  return result.status === "fulfilled"
    ? {
        keyword: result.value.effectiveKeyword,
        offset: position.offset + first,
      }
    : position;
}

function advanceSearchCursor<D, J>(
  cursor: SearchCursor,
  first: number,
  damResult: PromiseSettledResult<RomajiSearch<D>>,
  joysoundResult: PromiseSettledResult<RomajiSearch<J>>,
): SearchCursor {
  return {
    dam: advanceSearchPosition(cursor.dam, first, damResult),
    joysound: advanceSearchPosition(cursor.joysound, first, joysoundResult),
  };
}

// The single-catalog searches have the same resume problem, minus the second
// leg.
function formatPositionCursor(position: SearchPosition): string {
  return encodeCursor(position);
}

function parsePositionCursor(
  after: string | null,
  keyword: string,
  firstOffset: number,
): SearchPosition {
  const decoded = decodeCursor(after);
  return isSearchPosition(decoded) ? decoded : { keyword, offset: firstOffset };
}

// Round-robin the two catalogs before the match-tier sort. That sort is
// stable, so whatever order it's handed survives within a tier — and handing
// it one catalog's whole block followed by the other's would render as two
// blocks with a seam rather than a merged list.
function interleave<Item>(a: Item[], b: Item[]): Item[] {
  const merged: Item[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) merged.push(a[i]);
    if (i < b.length) merged.push(b[i]);
  }
  return merged;
}

// A merged search reports which catalogs didn't answer instead of failing:
// a blocked exit IP takes DAM down routinely, and the room can still sing off
// JOYSOUND. Logged too — a silent half-empty list is miserable to diagnose.
function failedSources(
  keyword: string,
  damResult: PromiseSettledResult<unknown>,
  joysoundResult: PromiseSettledResult<unknown>,
): string[] {
  const sources: string[] = [];
  if (damResult.status === "rejected") {
    sources.push("DAM");
    console.error(
      `[search] DAM search failed for "${keyword}"`,
      damResult.reason,
    );
  }
  if (joysoundResult.status === "rejected") {
    sources.push("JOYSOUND");
    console.error(
      `[search] JOYSOUND search failed for "${keyword}"`,
      joysoundResult.reason,
    );
  }
  return sources;
}

// DAM and Joysound's search backends only match Japanese-script keywords;
// a pure-romaji query like "aidoru" returns zero results even though the
// target title is stored as "アイドル". But not every romaji-looking query
// is romanized Japanese — both catalogs also carry western songs/artists
// under their literal English names (e.g. "Queen"), which must keep
// matching, so the literal keyword is always searched. On top of that, a
// literal match doesn't rule out a *different*, Japanese-titled song also
// being what the user meant (e.g. "umapyoi" matching an English-titled
// cover on DAM as well as "ウマぴょい伝説") — so if the query looks like
// romaji, we also try a few kana readings and merge their results in
// rather than only falling back when the literal search is empty.
//
// The readings are only tried on the first page. Later pages continue a
// single keyword, and `effectiveKeyword` is which one: the caller stores it
// in its cursor and passes it back as `keyword`. Without that, page 2 of
// "aidoru" re-ran the *literal* search, which is exactly the search that
// found nothing in the first place — so a full first page was followed by an
// empty second one and a "More" button that loaded nothing.
interface RomajiSearch<T> {
  readonly result: T;
  // The keyword these rows actually came from — the literal one, or the kana
  // reading that produced the most of them. When several readings contribute
  // (uncommon: DAM and JOYSOUND both match by reading, so あいどる and
  // アイドル usually return the same rows and dedupe into one set), paging
  // follows the dominant one and the stragglers are dropped rather than
  // repeated.
  readonly effectiveKeyword: string;
}

async function searchWithRomajiFallback<T>(
  keyword: string,
  isFirstPage: boolean,
  count: (result: Awaited<T>) => number,
  merge: (a: Awaited<T>, b: Awaited<T>) => Awaited<T>,
  search: (keyword: string) => Promise<T>,
): Promise<RomajiSearch<Awaited<T>>> {
  const literalResult = await search(keyword);
  if (!isFirstPage || !keyword || !isRomaji(keyword)) {
    return { result: literalResult, effectiveKeyword: keyword };
  }

  // A romaji query is ambiguous about which mora should land in which kana
  // script — titles and artist names routinely mix hiragana, katakana, and
  // kanji (e.g. Uma Musume's "ウマぴょい伝説"), so a single fixed-casing
  // conversion often misses even when the reading is otherwise right. Try
  // a few reasonable readings and merge in whichever ones hit.
  // IMEMode mirrors how a real Japanese IME converts as you type — most
  // relevant here for a dangling trailing "n" (e.g. "shinjuku" mid-typing),
  // which it resolves to "ん" immediately instead of waiting to see if a
  // vowel follows.
  const candidates = [
    ...new Set(
      [
        toKana(keyword, { IMEMode: true }),
        toHiragana(keyword),
        toKatakana(keyword),
      ].filter((candidate) => candidate && candidate !== keyword),
    ),
  ];

  let result = literalResult;
  let effectiveKeyword = keyword;
  let bestCount = count(literalResult);

  for (const candidate of candidates) {
    const candidateResult = await search(candidate);
    const candidateCount = count(candidateResult);
    if (candidateCount === 0) continue;

    result =
      count(result) === 0 ? candidateResult : merge(result, candidateResult);
    if (candidateCount > bestCount) {
      effectiveKeyword = candidate;
      bestCount = candidateCount;
    }
  }
  return { result, effectiveKeyword };
}

// Auto-generated "- Topic" uploads are audio-only (album art, no MV) and
// show up in search alongside real uploads for the same track - never a
// good pick for a background video.
const TOPIC_CHANNEL_SUFFIX = " - Topic";

// When an artist has an Official Artist Channel (OAC), YouTube's search API
// misattributes their auto-generated Topic-channel tracks to the OAC's own
// identity - author.name comes back as the plain artist name (e.g. "Green
// Day", not "Green Day - Topic") with is_verified_artist: true, so
// TOPIC_CHANNEL_SUFFIX never sees the "- Topic" suffix and the audio-only
// track can win tier 0 outright. oEmbed hits the video's real watch-page
// metadata instead, which still reports the true uploader. It's a public,
// unauthenticated JSON endpoint - no player JS / signature work - so unlike
// yt-dlp/Innertube extraction it doesn't carry meaningful bot-wall risk, but
// it's still a network round trip, so only call it on the few candidates
// that actually make the final cut, not the whole raw search result set.
async function isTopicChannelVideo(videoId: string): Promise<boolean> {
  try {
    const res = await nodeFetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(
        `https://www.youtube.com/watch?v=${videoId}`,
      )}&format=json`,
    );
    if (!res.ok) return false;
    const data = (await res.json()) as { author_name?: string };
    return (data.author_name ?? "").endsWith(TOPIC_CHANNEL_SUFFIX);
  } catch (e) {
    console.warn(`Failed to verify uploader for video ${videoId}: ${e}`);
    return false;
  }
}

// Titles containing any of these are essentially never the official/full
// music video we want as a background video, even when duration happens to
// line up.
const EXCLUDED_TITLE_KEYWORDS = [
  "cover",
  "reaction",
  "instrumental",
  "off vocal",
  "karaoke",
  "nightcore",
  "8d audio",
  "midi",
  "dance practice",
  "lyrics",
  "lyric",
  "vietsub",
  "engsub",
  // Japanese-language equivalents - a huge fraction of covers/karaoke/lyric
  // videos for JP songs are titled in Japanese, not English.
  "カラオケ", // karaoke
  "カバー", // cover
  "歌ってみた", // "tried singing it" - amateur cover
  "弾いてみた", // "tried playing it" - amateur instrumental cover
  "弾き語り", // solo acoustic cover
  "歌詞付き", // "with lyrics" - lyrics video
  "歌詞動画", // lyrics video
  "歌詞あり", // "has lyrics" - lyrics video
  // JP songs are also heavily reposted with Korean fan subtitles/translations.
  "가사", // lyrics
  "번역", // translation
  "자막", // subtitles
  "커버", // cover
  "ซับไทย", // Thai subtitles
  "ライブ", // live performance
];

// "live" needs a word-boundary check rather than a plain substring match -
// unlike the other keywords above, it collides with ordinary words that can
// legitimately appear in a title ("alive", "delivery", "olive").
const EXCLUDED_TITLE_WORD_PATTERNS = [/\blive\b/i];

// MVs commonly run longer than the official track length (album-style
// intros/outros); a much *shorter* result is almost always a TV-size edit
// or truncated cover, which we want to exclude outright rather than just
// deprioritize.
const MAX_SHORTER_THAN_EXPECTED_SEC = 15;
const MAX_LONGER_THAN_EXPECTED_SEC = 45;

interface YoutubeSearchVideoItem {
  readonly type?: string;
  readonly id?: string;
  readonly is_live?: boolean;
  readonly title?: { text?: string };
  readonly author?: { name?: string; is_verified_artist?: boolean };
  readonly duration?: { seconds?: number };
  readonly view_count?: { text?: string };
}

// youtubei.js exposes the view count only as localized display text
// ("115,556,754回視聴"); the leading digit group is the full count.
function parseViewCountText(text: string | undefined): number {
  const match = (text ?? "").match(/[\d,]+/);
  return match ? parseInt(match[0].replace(/,/g, ""), 10) : 0;
}

// Official uploads routinely run 20-45s longer than Joysound's own catalog
// duration (extra intro/outro), which used to let a merely duration-closer
// repost/lyrics-translation video outrank the genuine artist-channel
// upload even after a same-size bonus/penalty - a fixed point bonus can
// always be outweighed by a big enough duration gap. Rank by tier first
// (how trustworthy the *source* is) and only use duration-closeness to
// break ties within a tier, so a real match from the artist's own channel
// always wins regardless of how long its intro is.
//
// A bare "official" substring in the title is not trustworthy on its own -
// anyone can (and does) put "Official Video" in a cover/reupload's title
// from an entirely unrelated channel (e.g. searching a Hige Dandism song
// surfaced a "Novelbright" upload titled as if it were the official video).
// The bracketed "[Official Video]" tag convention is a much stronger,
// independent signal though - it's a deliberate, widely-recognized
// first-party labeling convention that fan/cover channels don't typically
// imitate, so it's trusted even without a channel-name match. This also
// covers artists whose real channel uses a differently-scripted name than
// Joysound's stored artist name (e.g. "Official髭男dism" vs. the channel's
// own "OFFICIAL HIGE DANDISM"), where a text-based channel match can never
// succeed.
const OFFICIAL_VIDEO_TAG_PATTERN = /[([【（［]\s*official\b/i;

// Fan-made anime music videos are a deliberate, well-produced pairing of the
// song with edited footage - a reasonable background-video pick when no
// official/artist-channel upload is available, but still a fan work, so it
// should never outrank one. "AMV" isn't an English word, so a bare
// word-boundary match is safe; "MAD" (the Japanese-fandom term for the same
// thing) collides with the ordinary English word, so it's only trusted in
// its conventional bracketed-tag or suffixed ("MAD動画"/"MAD video") forms.
const MAD_AMV_TAG_PATTERN =
  /\bamv\b|[([【（［]\s*mad\b|\bmad動画|\bmad\s*(?:video|movie)\b/i;

// Joysound stores artist names in Japanese script (宇多田ヒカル) while many
// artists' official channels use a romanized name, usually in Western name
// order ("Hikaru Utada") - a plain substring comparison can never match, so
// the genuine artist-channel upload was ranked tier 2 and lost the
// duration tiebreak to AMVs/remixes. Compare on an order-insensitive,
// diacritic-stripped ASCII token set as well as the literal name; Japanese
// script normalizes to an empty key and simply never token-matches.
function romajiTokenKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

function musicVideoCandidateTier(
  candidate: {
    readonly author: string;
    readonly title: string;
    readonly isVerifiedArtist?: boolean;
  },
  artistNameVariants: string[],
): number {
  const lowerAuthor = candidate.author.toLowerCase().trim();
  const lowerTitle = candidate.title.toLowerCase();
  const lowerVariants = artistNameVariants
    .map((variant) => variant.toLowerCase().trim())
    .filter(Boolean);

  const authorTokenKey = romajiTokenKey(candidate.author);
  const authorTokens = new Set(authorTokenKey.split(" "));

  const isExactArtistChannel = lowerVariants.some(
    (variant) =>
      lowerAuthor === variant ||
      (!!authorTokenKey && authorTokenKey === romajiTokenKey(variant)),
  );
  const isRelatedArtistChannel = lowerVariants.some((variant) => {
    if (lowerAuthor.includes(variant)) return true;
    const variantTokens = romajiTokenKey(variant).split(" ").filter(Boolean);
    return (
      variantTokens.length > 0 &&
      variantTokens.every((token) => authorTokens.has(token))
    );
  });
  // Strip the artist's own name before checking for a bare "official"
  // mention - some artists (e.g. "Official髭男dism") have brand names that
  // themselves contain the word, which would otherwise look like a tag on
  // every single one of their videos regardless of who uploaded it.
  const titleWithoutArtistName = lowerVariants.reduce(
    (title, variant) => title.split(variant).join(""),
    lowerTitle,
  );
  const isOfficialTitle = titleWithoutArtistName.includes("official");
  const hasOfficialVideoTag = OFFICIAL_VIDEO_TAG_PATTERN.test(candidate.title);
  // YouTube's own "Official Artist Channel" badge is a stronger, independent
  // trust signal than name matching - it can't be spoofed by a plainly-named
  // reupload/bootleg channel the way a bare exact-string match can (e.g. an
  // unofficial "米津玄師"-named tour-footage channel exact-matching the
  // literal artist name while the real official channel, bilingually named
  // "Kenshi Yonezu 米津玄師", only exact-matches after stripping either
  // half). It also survives cases where our own romanization of the artist
  // name is wrong (kuromoji has no proper-noun dictionary, so e.g. 米津玄師
  // round-trips as "yonetsu gen shi" instead of "Yonezu Kenshi").
  const isVerifiedArtistChannel = candidate.isVerifiedArtist === true;

  if (
    isExactArtistChannel ||
    hasOfficialVideoTag ||
    (isRelatedArtistChannel && (isOfficialTitle || isVerifiedArtistChannel))
  ) {
    return 0;
  }

  if (isRelatedArtistChannel) {
    return 1;
  }

  if (MAD_AMV_TAG_PATTERN.test(candidate.title)) {
    return 2;
  }

  return 3;
}

async function pickMusicVideoCandidates(
  videos: YoutubeSearchVideoItem[],
  artistNameVariants: string[],
  songName: string,
  expectedDurationSec: number,
  maxCandidates: number,
): Promise<SuggestedYoutubeVideo[]> {
  const candidates = videos
    .filter((v) => v.type === "Video" && !v.is_live && v.id)
    .map((v) => ({
      videoId: v.id!,
      title: v.title?.text ?? "",
      author: v.author?.name ?? "",
      lengthSeconds: v.duration?.seconds ?? 0,
      viewCount: parseViewCountText(v.view_count?.text),
      isVerifiedArtist: v.author?.is_verified_artist === true,
    }))
    .filter((v) => v.lengthSeconds > 0)
    .filter((v) => !v.author.endsWith(TOPIC_CHANNEL_SUFFIX))
    // A channel whose name itself says "karaoke" is never the source of an
    // official MV, regardless of what any individual title says.
    .filter((v) => !/karaoke|カラオケ/i.test(v.author))
    .filter((v) => {
      const lowerTitle = v.title.toLowerCase();
      return (
        !EXCLUDED_TITLE_KEYWORDS.some((keyword) =>
          lowerTitle.includes(keyword),
        ) &&
        !EXCLUDED_TITLE_WORD_PATTERNS.some((pattern) => pattern.test(v.title))
      );
    })
    // A video whose title doesn't even mention the song is almost certainly
    // a different song entirely (e.g. another upload from the same artist's
    // channel) - this must be an outright exclusion, not just a lower tier,
    // otherwise it can still win a tie-break against a correctly-titled but
    // unverified-channel candidate purely on duration closeness.
    .filter((v) => {
      const normalizedSongName = normalizeForTitleMatch(songName);
      return (
        !normalizedSongName ||
        normalizeForTitleMatch(v.title).includes(normalizedSongName)
      );
    })
    .filter((v) => {
      const delta = v.lengthSeconds - expectedDurationSec;
      return (
        delta >= -MAX_SHORTER_THAN_EXPECTED_SEC &&
        delta <= MAX_LONGER_THAN_EXPECTED_SEC
      );
    });

  candidates.sort((a, b) => {
    const tierDiff =
      musicVideoCandidateTier(a, artistNameVariants) -
      musicVideoCandidateTier(b, artistNameVariants);

    if (tierDiff !== 0) return tierDiff;

    // Within a tier, prefer the most-viewed video. Duration closeness is a
    // bad discriminator between same-channel uploads - an artist's official
    // channel often carries a static album-art "audio" upload alongside the
    // real MV, and the audio track's length is *closer* to the karaoke
    // duration (One Last Kiss: 2M-view art track at Δ1s vs the 115M-view MV
    // at Δ8s). View count separates those by orders of magnitude; keep
    // duration only as the final tiebreak.
    if (a.viewCount !== b.viewCount) return b.viewCount - a.viewCount;

    return (
      Math.abs(a.lengthSeconds - expectedDurationSec) -
      Math.abs(b.lengthSeconds - expectedDurationSec)
    );
  });

  // Verify only as many candidates as needed to fill maxCandidates, stopping
  // as soon as we have enough - most songs' top picks are real videos, so
  // this rarely runs past the first one or two.
  const verifiedCandidates: typeof candidates = [];
  for (const candidate of candidates) {
    if (verifiedCandidates.length >= maxCandidates) break;
    if (await isTopicChannelVideo(candidate.videoId)) continue;
    verifiedCandidates.push(candidate);
  }

  return verifiedCandidates.map((candidate) => ({
    ...candidate,
    isLikelyOfficial:
      musicVideoCandidateTier(candidate, artistNameVariants) === 0,
  }));
}

// A pre-set nameYomi/artistNameYomi on the parent (e.g. DAM's canonical
// katakana reading attached at search time) wins over the kuromoji guess.
const nameYomiResolvers = {
  nameYomi(parent: { name: string; nameYomi?: string | null }) {
    return parent.nameYomi || toYomi(parent.name);
  },
  artistNameYomi(parent: {
    artistName: string;
    artistNameYomi?: string | null;
  }) {
    return parent.artistNameYomi || toYomi(parent.artistName);
  },
};

interface JoysoundSongParent {
  readonly id: string;
  readonly name: string;
  readonly artistName: string;
  readonly lyricsPreview?: string | null;
  readonly tieUp?: string | null;
}

interface JoysoundArtistParent {
  readonly id: string;
  readonly name: string;
}

interface SongParent {
  readonly id: string;
  readonly name: string;
  readonly nameYomi: string;
  readonly artistName: string;
  readonly artistNameYomi: string;
  readonly lyricsPreview?: string | null;
  readonly vocalTypes?: string[];
  readonly tieUp?: string | null;
  readonly playtime?: number | null;
}

// A row of a merged search. `id` is source-qualified so Relay's store keeps
// the two catalogs' overlapping numeric ids apart (see schema.graphql);
// `songId`/`artistId` is the raw one the routes and mutations take. Only DAM
// hands out readings at search time, so the yomi fields are optional and the
// JOYSOUND rows fall through to the reading cache like they do today.
interface SearchedSongParent {
  readonly id: string;
  readonly songId: string;
  readonly source: "DAM" | "JOYSOUND";
  readonly name: string;
  readonly nameYomi?: string | null;
  readonly artistName: string;
  readonly artistNameYomi?: string | null;
}

interface SearchedArtistParent {
  readonly id: string;
  readonly artistId: string;
  readonly source: "DAM" | "JOYSOUND";
  readonly name: string;
  readonly nameYomi?: string | null;
  readonly songCount?: number;
}

interface SearchedConnection<Node> {
  readonly edges: ReadonlyArray<{ node: Node; cursor: string }>;
  readonly pageInfo: {
    hasPreviousPage: boolean;
    hasNextPage: boolean;
    startCursor: string;
    endCursor: string;
  };
  readonly unavailableSources: string[];
}

interface ArtistParent {
  readonly id: string;
  readonly name: string;
  readonly nameYomi: string;
  readonly songCount: number;
}

interface Artist extends ArtistParent {
  readonly songs: Connection<SongParent, string>;
}

interface Connection<NodeType, CursorType> {
  readonly edges: Edge<NodeType, CursorType>[];
  readonly pageInfo: PageInfo<CursorType>;
}

interface Edge<NodeType, CursorType> {
  readonly node: NodeType;
  readonly cursor: CursorType;
}

interface PageInfo<CursorType> {
  readonly hasPreviousPage: boolean;
  readonly hasNextPage: boolean;
  readonly startCursor: CursorType;
  readonly endCursor: CursorType;
}

interface CaptionLanguage {
  code: string;
  name: string;
}

// Shapes we read off youtubei.js's getBasicInfo() result. youtubei.js doesn't
// re-export these as named types from its entry point, so we declare the
// (minimal) subset the resolver consumes here. The resolver already assumes
// these fields are present at runtime; capturing that as a type keeps the
// access sites checked without changing behavior.
interface YTCaptionTrackData {
  readonly vss_id: string;
  readonly language_code: string;
  readonly name: { readonly text: string };
}

interface YTVideoInfo {
  readonly playability_status: {
    readonly status: string;
    readonly reason: string;
    readonly embeddable?: boolean;
  };
  // The parsed /player response. basic_info doesn't surface the microformat's
  // region-availability list, so we read it off the raw page instead.
  readonly page?: readonly [
    | {
        readonly microformat?: {
          readonly available_countries?: string[];
        } | null;
      }
    | undefined,
  ];
  readonly captions?: { readonly caption_tracks?: YTCaptionTrackData[] };
  readonly player_config?: {
    readonly audio_config?: { readonly loudness_db?: number };
  };
  readonly basic_info: {
    readonly author: string;
    readonly channel_id: string;
    readonly duration: number;
    readonly short_description: string;
    readonly title: string;
    readonly view_count: number;
    readonly keywords: string[];
  };
}

interface VideoInfo {
  readonly author: string;
  readonly channelId: string;
  readonly lengthSeconds: number;
  readonly description: string;
  readonly title: string;
  readonly viewCount: number;
}

interface YoutubeVideoInfo extends VideoInfo {
  readonly __typename: "YoutubeVideoInfo";
  readonly captionLanguages: CaptionLanguage[];
  readonly keywords: string[];
  readonly availableInUs: boolean | null;
  readonly embeddable: boolean;
}

interface YoutubeVideoInfoError {
  readonly __typename: "YoutubeVideoInfoError";
  readonly reason: string;
}

type YoutubeVideoInfoResult = YoutubeVideoInfo | YoutubeVideoInfoError;

interface SuggestedYoutubeVideo {
  readonly videoId: string;
  readonly title: string;
  readonly author: string;
  readonly lengthSeconds: number;
  readonly isLikelyOfficial: boolean;
}

interface SuggestedYoutubeVideos {
  readonly __typename: "SuggestedYoutubeVideos";
  readonly videos: SuggestedYoutubeVideo[];
}

interface SuggestedYoutubeVideoError {
  readonly __typename: "SuggestedYoutubeVideoError";
  readonly reason: string;
}

type SuggestedYoutubeVideosResult =
  | SuggestedYoutubeVideos
  | SuggestedYoutubeVideoError;

interface NicoVideoInfo extends VideoInfo {
  readonly __typename: "NicoVideoInfo";
  readonly thumbnailUrl: string;
}

interface NicoVideoInfoError {
  readonly __typename: "NicoVideoInfoError";
  readonly reason: string;
}

type NicoVideoInfoResult = NicoVideoInfo | NicoVideoInfoError;

export interface UserIdentity {
  readonly deviceId: string;
  readonly nickname: string;
  // URL of the user's chosen profile picture (e.g. a PMDCollab portrait).
  // Absent on older clients/persisted queue items; null/undefined means the
  // classic colored nickname badge.
  readonly profilePictureUrl?: string | null;
  // PMD dialogue-portrait frame around the picture: "male" (blue) or
  // "female" (pink). Absent/null means male.
  readonly profilePictureFrame?: string | null;
  // The singer this device is acting as. Absent on pre-registry clients and
  // on queue items persisted before the registry existed.
  readonly personId?: string | null;
}

interface QueueItemInterface {
  readonly songId: string;
  readonly name: string;
  readonly artistName: string;
  readonly playtime?: number | null;
  readonly timestamp: string;
  readonly userIdentity: UserIdentity;
  // Reading snapshot taken at queue time from the reading cache (see
  // pushSongToQueue); persisted in queue.json so a queued song keeps the
  // canonical DAM reading its search found across restarts. Absent on older
  // persisted items, which fall back to the cache/kuromoji in
  // nameYomiResolvers.
  readonly nameYomi?: string | null;
  readonly artistNameYomi?: string | null;
}

export interface JoysoundQueueItem extends QueueItemInterface {
  readonly __typename: "JoysoundQueueItem";
  readonly isRomaji: boolean;
  readonly youtubeVideoId: string | null;
  // null/undefined (older clients and persisted queue items) means enabled.
  readonly youtubeVideoSyncEnabled?: boolean | null;
}

interface DamQueueItem extends QueueItemInterface {
  readonly __typename: "DamQueueItem";
  readonly streamingUrlIdx: string;
}

interface YoutubeQueueItem extends QueueItemInterface {
  readonly __typename: "YoutubeQueueItem";
  readonly hasAdhocLyrics: boolean;
  readonly hasCaptions: boolean;
  readonly gainValue: number;
}

interface NicoQueueItem extends QueueItemInterface {
  readonly __typename: "NicoQueueItem";
}

type QueueItem =
  | DamQueueItem
  | JoysoundQueueItem
  | YoutubeQueueItem
  | NicoQueueItem;

type QueueSongInfo = {
  readonly __typename: "QueueSongInfo";
  readonly eta: number;
};

interface QueueSongError {
  readonly __typename: "QueueSongError";
  readonly reason: string;
}

export type QueueSongResult = QueueSongInfo | QueueSongError;

type Emote = {
  readonly userIdentity: UserIdentity;
  readonly emote: string;
};

type QueueDamSongInput = {
  readonly songId: string;
  readonly name: string;
  readonly artistName: string;
  readonly playtime?: number | null;
  readonly streamingUrlIdx: string;
  readonly userIdentity: UserIdentity;
};

type QueueJoysoundSongInput = {
  readonly songId: string;
  readonly name: string;
  readonly artistName: string;
  readonly playtime?: number | null;
  readonly userIdentity: UserIdentity;
  readonly isRomaji: boolean;
  readonly youtubeVideoId: string | null;
  readonly youtubeVideoSyncEnabled?: boolean | null;
};

type QueueYoutubeSongInput = {
  readonly songId: string;
  readonly name: string;
  readonly artistName: string;
  readonly playtime?: number | null;
  readonly userIdentity: UserIdentity;
  readonly adhocSongLyrics: string;
  readonly captionCode: string | null;
  readonly gainValue: number;
};

type QueueNicoSongInput = {
  readonly songId: string;
  readonly name: string;
  readonly artistName: string;
  readonly playtime?: number | null;
  readonly userIdentity: UserIdentity;
};

interface SongHistoryItem {
  readonly song: QueueItem;
}

interface SubscriptionQueueChanged {
  readonly currentSong: QueueItem | null;
  readonly newQueue: QueueItem[];
}

enum PlaybackState {
  PAUSED = "PAUSED",
  PLAYING = "PLAYING",
  RESTARTING = "RESTARTING",
  SKIPPING = "SKIPPING",
  WAITING = "WAITING",
}

type PushAdhocLyricsInput = {
  readonly lyric: string;
  readonly lyricIndex: number;
};

type AdhocLyricsEntry = {
  readonly lyric: string;
  readonly lyricIndex: number;
};

export interface DownloadQueueItem {
  downloadType: number;
  userIdentity: UserIdentity;
  songId: string;
  suffix: string | null;
  progress: number;
}

interface VideoDownloadProgress {
  progress: number;
}

type NotARealDb = {
  bgmTrack: string | null;
  bgmVolume: number;
  // Epoch ms when the current break ends; null when not on break.
  breakEndsAt: number | null;
  // Custom message shown on the intermission screen while on break, and the
  // nickname of whoever set it (if any).
  breakMessageText: string | null;
  breakMessageAuthor: string | null;
  currentSong: QueueItem | null;
  currentSongAdhocLyrics: AdhocLyricsEntry[];
  guideMelodyVolume: number;
  // Whether a played song enters songHistory at all. Off under `run-dev`, on
  // in a packaged build (see DEFAULT_HISTORY_RECORDING), because testing a
  // download or a sync fix means queueing a dozen songs nobody sang, and those
  // otherwise land in the history — and in the play counts and scores that
  // hang off it — indistinguishable from a real party. Deliberately NOT
  // restored from disk; loadDb re-derives it every launch.
  historyRecordingEnabled: boolean;
  // "host:port" the QR codes encode. Null until someone picks one, in which
  // case the resolver serves defaultHostname() — the machine's LAN address
  // can change between launches, so a stale persisted value shouldn't win
  // over a freshly computed default unless it was chosen deliberately.
  hostname: string | null;
  idToAdhocLyrics: Record<string, string[]>;
  joysoundRomajiWordSegmentation: boolean;
  micOutputEnabled: boolean;
  micRmsGateEnabled: boolean;
  micRmsGateThreshold: number;
  experimentalScoringEnabled: boolean;
  oledFriendly: boolean;
  pianoRollOpacity: number;
  pianoRollSize: number;
  pitchShiftSemis: number;
  playbackState: PlaybackState;
  queueIntermissionEnabled: boolean;
  settingsCollapsed: boolean;
  sidebarCollapsed: boolean;
  songQueue: QueueItem[];
  downloadQueue: DownloadQueueItem[];
  songHistory: SongHistoryItem[];
  lastKnownGoodDamSongId: string | null;
  // The YouTube MV last queued with each JOYSOUND song (keyed by songId), so
  // picking the song again defaults to the same background video. Queuing
  // without a video is an explicit detach and clears the entry.
  joysoundYoutubeVideos: Record<
    string,
    { videoId: string; syncEnabled: boolean }
  >;
};

enum SubscriptionEvent {
  BgmTrackChanged = "BgmTrackChanged",
  BgmVolumeChanged = "BgmVolumeChanged",
  BreakEndsAtChanged = "BreakEndsAtChanged",
  BreakMessageChanged = "BreakMessageChanged",
  CurrentSongAdhocLyricsChanged = "CurrentSongAdhocLyricsChanged",
  CurrentSongChanged = "CurrentSongChanged",
  Emote = "Emote",
  GuideMelodyVolumeChanged = "GuideMelodyVolumeChanged",
  HistoryRecordingEnabledChanged = "HistoryRecordingEnabledChanged",
  JoysoundRomajiWordSegmentationChanged = "JoysoundRomajiWordSegmentationChanged",
  MicOutputEnabledChanged = "MicOutputEnabledChanged",
  MicRmsGateEnabledChanged = "MicRmsGateEnabledChanged",
  MicRmsGateThresholdChanged = "MicRmsGateThresholdChanged",
  ExperimentalScoringEnabledChanged = "ExperimentalScoringEnabledChanged",
  HostnameChanged = "HostnameChanged",
  OledFriendlyChanged = "OledFriendlyChanged",
  PianoRollOpacityChanged = "PianoRollOpacityChanged",
  PianoRollSizeChanged = "PianoRollSizeChanged",
  PitchShiftSemisChanged = "PitchShiftSemisChanged",
  PlaybackStateChanged = "PlaybackStateChanged",
  QueueIntermissionEnabledChanged = "QueueIntermissionEnabledChanged",
  SettingsCollapsedChanged = "SettingsCollapsedChanged",
  SidebarCollapsedChanged = "SidebarCollapsedChanged",
  QueueAdded = "QueueAdded",
  QueueChanged = "QueueChanged",
  PeopleChanged = "PeopleChanged",
}

// 1.0 = the standard 3.0-to-stereo downmix level Joysound's guide melody has
// always played at; see webAudio.ts.
const DEFAULT_GUIDE_MELODY_VOLUME = 1.0;
const MAX_GUIDE_MELODY_VOLUME = 1.5;
const DEFAULT_BGM_VOLUME = 0.3;
// BGM plays through a plain <audio> element, whose volume caps at 1.0.
const MAX_BGM_VOLUME = 1.0;

function clampVolume(volume: number, max: number): number {
  return Math.min(Math.max(volume, 0), max);
}

const DEFAULT_PIANO_ROLL_OPACITY = 1.0;
const MAX_PIANO_ROLL_OPACITY = 1.0;
// Height as a fraction of the player screen; the remocon offers
// off/small/medium/large presets (0 / 0.2 / 0.3 / 0.4). 0 is a special
// "hidden" value; any other requested size is clamped into this range.
const DEFAULT_PIANO_ROLL_SIZE = 0.2;
const MIN_PIANO_ROLL_SIZE = 0.1;
const MAX_PIANO_ROLL_SIZE = 0.5;

// Record history in a packaged build, don't under `run-dev`. That split is how
// the app is actually used — parties run the packaged build, development
// doesn't — so the safe behaviour needs nobody to remember a toggle.
const DEFAULT_HISTORY_RECORDING = !isDev;

// TODO: make this gql context instead of global
let db: NotARealDb = {
  bgmTrack: SHUFFLE_VALUE,
  bgmVolume: DEFAULT_BGM_VOLUME,
  breakEndsAt: null,
  breakMessageText: null,
  breakMessageAuthor: null,
  currentSong: null,
  currentSongAdhocLyrics: [],
  guideMelodyVolume: DEFAULT_GUIDE_MELODY_VOLUME,
  historyRecordingEnabled: DEFAULT_HISTORY_RECORDING,
  hostname: null,
  idToAdhocLyrics: {},
  joysoundRomajiWordSegmentation: true,
  micOutputEnabled: false,
  micRmsGateEnabled: false,
  micRmsGateThreshold: DEFAULT_MIC_RMS_GATE_THRESHOLD,
  experimentalScoringEnabled: true,
  oledFriendly: true,
  pianoRollOpacity: DEFAULT_PIANO_ROLL_OPACITY,
  pianoRollSize: DEFAULT_PIANO_ROLL_SIZE,
  pitchShiftSemis: 0,
  playbackState: PlaybackState.WAITING,
  queueIntermissionEnabled: true,
  settingsCollapsed: false,
  sidebarCollapsed: false,
  songQueue: [],
  downloadQueue: [],
  songHistory: [],
  lastKnownGoodDamSongId: null,
  joysoundYoutubeVideos: {},
};

// The address a phone on the same WiFi can actually reach, with the remocon
// port, so the QR codes are scannable out of the box. Prefer a private LAN
// IPv4; fall back to the mDNS hostname when this machine has none. This used
// to live in the renderer (over preload's ipAddresses()) — it moved here when
// hostname became a synced setting, so every window agrees on one default.
function defaultHostname(): string {
  const ipv4 = ipAddresses().filter((addr) =>
    /^\d{1,3}(\.\d{1,3}){3}$/.test(addr),
  );
  const preferred =
    ipv4.find((addr) => addr.startsWith("192.168.")) ??
    ipv4.find((addr) => addr.startsWith("10.")) ??
    ipv4.find((addr) => /^172\.(1[6-9]|2\d|3[01])\./.test(addr)) ??
    ipv4[0];
  return preferred ? `${preferred}:${karafriendsConfig.remoconPort}` : HOSTNAME;
}

function currentHostname(): string {
  return db.hostname ?? defaultHostname();
}

type ServiceHealthState = {
  damAvailable: boolean;
  joysoundAvailable: boolean;
  checkedAt: string;
};

let currentServiceHealth: ServiceHealthState | null = null;
let healthCheckInFlight: Promise<ServiceHealthState> | null = null;
let runHealthCheckOnce:
  | (() => Promise<{ damAvailable: boolean; joysoundAvailable: boolean }>)
  | null = null;

const DB_PATH = path.resolve(TEMP_FOLDER, "queue.json");

// queue.json lives in the OS temp dir, which macOS wipes on every boot — a
// reboot mid-party (2026-07-25 is the case on record) took the room's whole
// song history with it, along with the cached composites. The composites are
// a cache and can be re-fetched; the history can't. Mirror it to userData,
// for the same reason people.json and the score cards live there, and merge
// the two on load.
const HISTORY_MIRROR_PATH = path.resolve(
  electronApp.getPath("userData"),
  "song-history.json",
);
const HISTORY_MIRROR_VERSION = 1;

function historyKey(item: SongHistoryItem): string {
  return `${item.song.__typename}:${item.song.songId}:${item.song.timestamp}`;
}

let lastMirroredHistory: string | null = null;

function writeHistoryMirror(): void {
  // saveDb runs on every mutation — a slider drag included — but the history
  // only moves on popSong, so skip the write unless it actually changed.
  const fingerprint = `${db.songHistory.length}:${
    db.songHistory.length ? historyKey(db.songHistory[0]) : ""
  }`;
  if (fingerprint === lastMirroredHistory) return;

  try {
    fs.writeFileSync(
      HISTORY_MIRROR_PATH,
      JSON.stringify({
        version: HISTORY_MIRROR_VERSION,
        songHistory: db.songHistory,
      }),
      "utf-8",
    );
    lastMirroredHistory = fingerprint;
  } catch (e) {
    console.error("[history] failed to write mirror", e);
  }
}

function readHistoryMirror(): SongHistoryItem[] {
  try {
    if (!fs.existsSync(HISTORY_MIRROR_PATH)) return [];
    const parsed = JSON.parse(fs.readFileSync(HISTORY_MIRROR_PATH, "utf-8"));
    return Array.isArray(parsed?.songHistory) ? parsed.songHistory : [];
  } catch (e) {
    console.error("[history] failed to read mirror", e);
    return [];
  }
}

// A union rather than "fall back to the mirror when queue.json is empty":
// after a temp sweep queue.json holds whatever was sung since the relaunch
// and the mirror holds everything before it, and neither is a superset.
function mergeHistory(...sources: SongHistoryItem[][]): SongHistoryItem[] {
  const byKey = new Map<string, SongHistoryItem>();

  for (const item of sources.flat()) {
    if (!item?.song?.timestamp) continue;
    const key = historyKey(item);
    if (!byKey.has(key)) byKey.set(key, item);
  }

  return [...byKey.values()].sort(
    (a, b) => Number(b.song.timestamp) - Number(a.song.timestamp),
  );
}

// TODO: write a db interface and call these from within mutating methods instead of at their call sites
function saveDb() {
  if (!fs.existsSync(TEMP_FOLDER)) {
    fs.mkdirSync(TEMP_FOLDER);
  }
  fs.writeFileSync(
    DB_PATH,
    JSON.stringify({
      ...db,
      pitchShiftSemis: 0,
      currentSong: null,
      currentSongAdhocLyrics: [],
      // Re-queue the in-flight song so it survives a restart — but only if
      // there is one; a bare [db.currentSong, ...] spread persisted a null
      // on every idle-time save, which then broke the (non-nullable) queue
      // query on the next launch.
      songQueue: [db.currentSong, ...db.songQueue].filter(
        (song): song is QueueItem => song !== null,
      ),
      downloadQueue: [],
      // A fresh process is never mid-song; restoring a stale PLAYING from a
      // session killed mid-song left the renderer waiting forever (no BGM,
      // idle screen) for a song that isn't there.
      playbackState: PlaybackState.WAITING,
    }),
    "utf-8",
  );
  writeHistoryMirror();
}

function loadDb(): NotARealDb {
  const loaded: NotARealDb = {
    bgmTrack: SHUFFLE_VALUE,
    bgmVolume: DEFAULT_BGM_VOLUME,
    breakEndsAt: null,
    breakMessageText: null,
    breakMessageAuthor: null,
    currentSong: null,
    currentSongAdhocLyrics: [],
    guideMelodyVolume: DEFAULT_GUIDE_MELODY_VOLUME,
    historyRecordingEnabled: DEFAULT_HISTORY_RECORDING,
    hostname: null,
    idToAdhocLyrics: {},
    joysoundRomajiWordSegmentation: true,
    micOutputEnabled: false,
    micRmsGateEnabled: false,
    micRmsGateThreshold: DEFAULT_MIC_RMS_GATE_THRESHOLD,
    experimentalScoringEnabled: true,
    oledFriendly: true,
    pianoRollOpacity: DEFAULT_PIANO_ROLL_OPACITY,
    pianoRollSize: DEFAULT_PIANO_ROLL_SIZE,
    pitchShiftSemis: 0,
    playbackState: PlaybackState.WAITING,
    queueIntermissionEnabled: true,
    settingsCollapsed: false,
    sidebarCollapsed: false,
    songQueue: [],
    downloadQueue: [],
    songHistory: [],
    lastKnownGoodDamSongId: null,
    joysoundYoutubeVideos: {},
    ...(fs.existsSync(DB_PATH) &&
      JSON.parse(fs.readFileSync(DB_PATH, "utf-8"))),
  };
  // Heal artifacts written by older saveDb versions: stray nulls in
  // songQueue (from the unconditional currentSong prepend) and a stale
  // non-WAITING playbackState from a session killed mid-song.
  loaded.songQueue = loaded.songQueue.filter((song) => song !== null);
  loaded.playbackState = PlaybackState.WAITING;
  // Whichever of the two survived the last sweep, plus anything the other
  // one has that it doesn't.
  loaded.songHistory = mergeHistory(loaded.songHistory, readHistoryMirror());
  // A break doesn't survive a relaunch (and a stale past deadline is noise).
  loaded.breakEndsAt = null;
  // Re-derived per launch rather than restored, because `run-dev` and the
  // packaged build share one OS temp dir and so one queue.json: a `true`
  // persisted by the packaged app would otherwise spread over the dev
  // default and quietly turn test-queue recording back on. Erring the other
  // way is also better — a toggle flipped off for one test session can't
  // silently eat the next party's history.
  loaded.historyRecordingEnabled = DEFAULT_HISTORY_RECORDING;
  return loaded;
}

const pubsub = new PubSub();

const nicovideo = new Nicovideo();

interface WatchData {
  owner: {
    id: number;
    nickname: string;
  };
  video: {
    count: {
      view: number;
    };
    description: string;
    duration: number;
    title: string;
    thumbnail: {
      player: string;
    };
  };
}

// The identity a queue item should carry: the person's current name/avatar,
// stamped with their personId, but keeping the device that actually queued
// it. Replaces the old session-scoped latestIdentityByDevice map — the
// registry is the source of truth now, and it survives a relaunch.
function identityFromPerson(person: Person, deviceId: string): UserIdentity {
  return {
    deviceId,
    nickname: person.displayName,
    profilePictureUrl: person.profilePictureUrl,
    profilePictureFrame: person.profilePictureFrame,
    personId: person.personId,
  };
}

function publishPeopleChanged(): void {
  pubsub.publish(SubscriptionEvent.PeopleChanged, {
    peopleChanged: listPeople(),
  });
}

// Whether a queue/download item belongs to this singer. personId is the real
// key; the deviceIds fallback covers items persisted before the registry
// existed, which carry no personId at all.
function itemBelongsToPerson(
  itemIdentity: UserIdentity,
  person: Person,
): boolean {
  if (itemIdentity.personId) return itemIdentity.personId === person.personId;
  return person.deviceIds.includes(itemIdentity.deviceId);
}

function isAdmin(person: Person, userIdentity: UserIdentity): boolean {
  return (
    karafriendsConfig.adminNicks.includes(person.displayName) ||
    karafriendsConfig.adminNicks.includes(userIdentity.nickname) ||
    person.deviceIds.some((deviceId) =>
      karafriendsConfig.adminDeviceIds.includes(deviceId),
    ) ||
    karafriendsConfig.adminDeviceIds.includes(userIdentity.deviceId)
  );
}

function hasMaxSongsInQueue(userIdentity: UserIdentity): boolean {
  const person = resolvePerson(userIdentity);
  // Counted per person, not per device: one singer on a phone and a laptop
  // used to get double the limit, and two singers sharing a phone had to
  // split one.
  const owns = (x: { userIdentity: UserIdentity }) =>
    itemBelongsToPerson(x.userIdentity, person);

  // Not very efficient, but surely the queue won't ever get so big that this would be considered expensive
  const songsQueuedByUser: number = db.songQueue.filter(owns).length;

  const songsDownloadingByUser: number = db.downloadQueue.filter(owns).length;

  console.log(
    `hasMaxSongsInQueue: user ${person.displayName} has ${songsQueuedByUser}, ${songsDownloadingByUser} downloading`,
  );
  console.log(
    `adminNicks=${karafriendsConfig.adminNicks}, adminDeviceIds=${karafriendsConfig.adminDeviceIds}`,
  );

  return (
    !isAdmin(person, userIdentity) &&
    karafriendsConfig.paxSongQueueLimit > 0 &&
    songsQueuedByUser + songsDownloadingByUser >=
      karafriendsConfig.paxSongQueueLimit
  );
}

function canPushToHeadOfQueue(userIdentity: UserIdentity): boolean {
  return isAdmin(resolvePerson(userIdentity), userIdentity);
}

function pushSongToQueue(
  queueItem: QueueItem,
  pushToHead: boolean = false,
): QueueSongResult {
  // Snapshot the best reading we currently have onto the queue item so it
  // rides along in queue.json: a song queued right after its search keeps the
  // canonical DAM reading even across an app restart, and a later cache change
  // can't retroactively alter an already-queued song's romaji. Falls back to
  // the cache/kuromoji in nameYomiResolvers when nothing is cached yet.
  // Resolving through the registry both stamps the personId attribution hangs
  // off and picks up any profile edit made since this song was requested (a
  // song still downloading when someone renames themselves used to arrive
  // with the stale name).
  const person = resolvePerson(queueItem.userIdentity);
  touchPerson(person.personId);

  const enrichedItem: QueueItem = {
    ...queueItem,
    userIdentity: identityFromPerson(person, queueItem.userIdentity.deviceId),
    nameYomi: queueItem.nameYomi ?? getCachedReading(queueItem.name),
    artistNameYomi:
      queueItem.artistNameYomi ?? getCachedReading(queueItem.artistName),
  };

  const eta =
    (db.currentSong?.playtime || 0) +
    db.songQueue.reduce((acc, cur) => acc + (cur.playtime || 0), 0);

  console.log(
    `pushSongToQueue: pushing ${JSON.stringify(
      enrichedItem,
    )} with an eta of ${eta}; pushToHead=${pushToHead}`,
  );

  if (pushToHead === true) {
    // To give things time to download, we don't actually push to the front, but the second.
    // Due to :js:, this is OK regardless of the size of db.songQueue
    db.songQueue.splice(1, 0, enrichedItem);
  } else {
    db.songQueue.push(enrichedItem);
  }

  pubsub.publish(SubscriptionEvent.QueueChanged, {
    queueChanged: {
      currentSong: db.currentSong,
      newQueue: db.songQueue,
    },
  });

  pubsub.publish(SubscriptionEvent.QueueAdded, {
    queueAdded: enrichedItem,
  });

  saveDb();

  return {
    __typename: "QueueSongInfo",
    eta,
  };
}

function cleanupAdhocSongLyrics(lyrics: string): string[] {
  return lyrics.split("\n").filter((entry) => entry.trim() !== "");
}

// The pop path has to fail in seconds, not minutes: the room watches a spinner
// for as long as popSong is unresolved, the player's wedge watchdog is
// deliberately suppressed while a pop is in flight, and no skip can land until
// the mutation comes back. promise-retry's default (10 retries, ~17 minutes of
// backoff) therefore turned a DAM outage into an app that looked permanently
// hung, with no way out but a relaunch. A few quick retries still absorb the
// flakiness these endpoints are known for; anything worse is an outage, and an
// outage should reach Player.tsx as "unplayable, skip forward" right away.
const POP_RETRY_OPTIONS = { retries: 3, minTimeout: 500, maxTimeout: 2000 };

const resolvers = {
  JoysoundSong: {
    id(parent: JoysoundSongParent) {
      return parent.id;
    },
    name(parent: JoysoundSongParent) {
      return parent.name;
    },
    artistName(parent: JoysoundSongParent) {
      return parent.artistName;
    },
    lastYoutubeVideoId(parent: JoysoundSongParent) {
      return db.joysoundYoutubeVideos[parent.id]?.videoId ?? null;
    },
    lastYoutubeVideoSyncEnabled(parent: JoysoundSongParent) {
      return db.joysoundYoutubeVideos[parent.id]?.syncEnabled ?? null;
    },
    ...nameYomiResolvers,
  },

  // Ranking entries come off the public chart pages with no reading data, so
  // yomi falls back to the reading cache / kuromoji guess like JOYSOUND
  // search results do.
  RankingSong: {
    songId(parent: RankingSongEntry) {
      return parent.id;
    },
    ...nameYomiResolvers,
  },

  RankingArtist: {
    artistId(parent: RankingArtistEntry) {
      return parent.id;
    },
    // Only nameYomi here — RankingArtist has no artistName(Yomi), so it can't
    // reuse the full nameYomiResolvers spread (schema-building rejects a
    // resolver for a field the type doesn't declare).
    nameYomi(parent: RankingArtistEntry) {
      return toYomi(parent.name);
    },
  },

  Song: {
    id(parent: SongParent) {
      return parent.id;
    },
    name(parent: SongParent) {
      return parent.name;
    },
    nameYomi(parent: SongParent) {
      return parent.nameYomi;
    },
    artistName(parent: SongParent) {
      return parent.artistName;
    },
    artistNameYomi(parent: SongParent) {
      return parent.artistNameYomi;
    },
    lyricsPreview(parent: SongParent) {
      return parent.lyricsPreview || null;
    },
    vocalTypes(parent: SongParent) {
      return parent.vocalTypes || [];
    },
    tieUp(parent: SongParent) {
      return parent.tieUp || null;
    },
    playtime(parent: SongParent) {
      return parent.playtime || null;
    },
    streamingUrls(parent: SongParent, _: any, { dataSources }: IDataSources) {
      return dataSources.minsei.getMusicStreamingUrls(parent.id).then((data) =>
        data.list.map((info) => ({
          url: karafriendsConfig.useLowBitrateUrl
            ? info.lowBitrateUrl
            : info.highBitrateUrl,
        })),
      );
    },
    scoringData(parent: SongParent, _: any, { dataSources }: IDataSources) {
      return dataSources.minsei
        .getScoringData(parent.id)
        .then((data) => Array.from(new Uint8Array(data)));
    },
  },
  Artist: {
    id(parent: ArtistParent) {
      return parent.id;
    },
    name(parent: ArtistParent) {
      return parent.name;
    },
    nameYomi(parent: ArtistParent) {
      return parent.nameYomi;
    },
    songCount(parent: ArtistParent) {
      return parent.songCount;
    },
    songs(
      parent: ArtistParent,
      args: { first: number | null; after: string | null },
      { dataSources }: IDataSources,
    ) {
      const firstInt = args.first || 0;
      const afterInt = args.after ? parseInt(args.after, 10) : 0;

      return dataSources.dkwebsys
        .getMusicListByArtist(parent.id, firstInt, afterInt)
        .then((result) => ({
          edges: result.list.map((song, i) => ({
            node: {
              id: song.requestNo,
              name: song.title,
              nameYomi: song.titleYomi,
              artistName: song.artist,
              artistNameYomi: song.artistYomi,
            },
            cursor: (firstInt + 1).toString(),
          })),
          pageInfo: {
            hasPreviousPage: false,
            hasNextPage: firstInt + afterInt < result.data.totalCount,
            startCursor: "0",
            endCursor: (firstInt + afterInt).toString(),
          },
        }));
    },
  },
  JoysoundArtist: {
    nameYomi(parent: JoysoundArtistParent) {
      return toYomi(parent.name);
    },
    songCount(
      parent: JoysoundArtistParent,
      _: any,
      { dataSources }: IDataSources,
    ) {
      return getJoysoundArtistSongCount(parent.id, dataSources.joysound);
    },
  },

  SearchedSong: {
    ...nameYomiResolvers,
  },

  SearchedArtist: {
    // Only nameYomi, not the full spread — SearchedArtist has no artistName,
    // and schema-building rejects a resolver for a field the type doesn't
    // declare (same reason as RankingArtist above).
    nameYomi(parent: SearchedArtistParent) {
      return parent.nameYomi || toYomi(parent.name);
    },
    // DAM reports its catalog size in the search response; JOYSOUND doesn't,
    // so its rows pay the same per-artist (cached, in-flight-deduped) lookup
    // the JOYSOUND-only artist search already does.
    songCount(
      parent: SearchedArtistParent,
      _: any,
      { dataSources }: IDataSources,
    ) {
      return parent.source === "JOYSOUND"
        ? getJoysoundArtistSongCount(parent.artistId, dataSources.joysound)
        : (parent.songCount ?? 0);
    },
  },
  DamQueueItem: {
    // These are fetched live from DAM on every popSong call rather than
    // cached at queue time, since streaming URLs expire. If DAM is
    // unreachable, resolve to null instead of rejecting — a rejection here
    // would null out the entire (non-nullable-field-bearing) popSong
    // response under GraphQL's error-propagation rules, silently dropping
    // the song with no signal to the player. Player.tsx treats a null
    // result as "unplayable, skip forward."
    streamingUrls(parent: DamQueueItem, _: any, { dataSources }: IDataSources) {
      return dataSources.minsei
        .getMusicStreamingUrls(parent.songId, POP_RETRY_OPTIONS)
        .then((data) =>
          data.list.map((info) => ({
            url: karafriendsConfig.useLowBitrateUrl
              ? info.lowBitrateUrl
              : info.highBitrateUrl,
          })),
        )
        .catch((e) => {
          console.error(
            `Failed fetching DAM streaming URLs for ${parent.songId}, skipping`,
            e,
          );
          return null;
        });
    },
    scoringData(parent: DamQueueItem, _: any, { dataSources }: IDataSources) {
      return dataSources.minsei
        .getScoringData(parent.songId, POP_RETRY_OPTIONS)
        .then((data) => Array.from(new Uint8Array(data)))
        .catch((e) => {
          console.error(
            `Failed fetching DAM scoring data for ${parent.songId}, skipping`,
            e,
          );
          return null;
        });
    },
    ...nameYomiResolvers,
  },
  JoysoundQueueItem: {
    scoringData(parent: JoysoundQueueItem) {
      return getJoysoundScoringData(parent.songId);
    },
    ...nameYomiResolvers,
  },
  YoutubeQueueItem: {
    ...nameYomiResolvers,
  },
  NicoQueueItem: {
    ...nameYomiResolvers,
  },
  Query: {
    adhocLyrics(_: any, args: { id: string }): string[] {
      return db.idToAdhocLyrics[args.id];
    },
    joysoundRanking: (
      _: any,
      args: {
        category: RankingCategory;
        period: RankingPeriod;
        month: string | null;
      },
      { dataSources }: IDataSources,
    ): Promise<RankingSongEntry[]> =>
      getJoysoundRanking(
        dataSources.joysound,
        args.category,
        args.period,
        args.month,
      ).then((entries) => {
        // Enrich the chart's rows with DAM's canonical readings (background,
        // best-effort) so a visit that missed the launch prefetch still gets
        // them cached for the per-row nameYomi resolvers on the next render.
        primeRankingReadings(entries, dataSources.dkwebsys);
        return entries;
      }),
    damRanking: (
      _: any,
      args: { category: RankingCategory; period: RankingPeriod },
      { dataSources }: IDataSources,
    ): Promise<RankingSongEntry[]> =>
      getDamRanking(args.category, args.period).then((entries) => {
        primeRankingReadings(entries, dataSources.dkwebsys);
        return entries;
      }),
    joysoundArtistRanking: (
      _: any,
      args: { period: RankingPeriod; month: string | null },
      { dataSources }: IDataSources,
    ): Promise<RankingArtistEntry[]> =>
      getJoysoundArtistRanking(args.period, args.month).then((entries) => {
        primeRankingArtistReadings(entries, dataSources.dkwebsys);
        return entries;
      }),
    damArtistRanking: (
      _: any,
      args: { period: RankingPeriod },
      { dataSources }: IDataSources,
    ): Promise<RankingArtistEntry[]> =>
      getDamArtistRanking(args.period).then((entries) => {
        primeRankingArtistReadings(entries, dataSources.dkwebsys);
        return entries;
      }),
    joysoundRankingMonths: (): Promise<RankingMonth[]> =>
      getJoysoundRankingMonths(),
    // No reading prime here, unlike the DAM/JOYSOUND charts: Oricon rows
    // aren't catalog entries, so priming them would spend a DAM search per
    // row on names we never link by id anyway.
    oriconWeeklyRanking: (): Promise<OriconWeeklyChart> =>
      getOriconWeeklyRanking(),
    joysoundSongDetail: (
      _: any,
      args: { id: string },
      { dataSources }: IDataSources,
    ): Promise<JoysoundSongParent> => {
      return dataSources.joysound.getSongDetail(args.id).then((data) => ({
        id: args.id,
        ...data,
      }));
    },
    joysoundSongsByArtist: (
      _: any,
      args: { artistId: string; first: number | null; after: string | null },
      { dataSources }: IDataSources,
    ): Promise<Connection<JoysoundSongParent, string>> => {
      const firstInt = args.first || 100;
      const afterInt = args.after ? parseInt(args.after, 10) : 1;

      return dataSources.joysound
        .getSongListByArtist(args.artistId, afterInt, firstInt)
        .then((result) => ({
          edges: result.map((song, i) => ({
            node: {
              id: song.selSongNo,
              name: song.songName,
              artistName: song.artistName,
            },
            cursor: (firstInt + i).toString(),
          })),
          pageInfo: {
            hasPreviousPage: false,
            hasNextPage: result.length === firstInt,
            startCursor: "1",
            endCursor: (firstInt + afterInt).toString(),
          },
        }));
    },
    joysoundSongsByKeyword: (
      _: any,
      args: { keyword: string; first: number | null; after: string | null },
      { dataSources }: IDataSources,
    ): Promise<Connection<JoysoundSongParent, string>> => {
      const firstInt = args.first || 100;
      const position = parsePositionCursor(
        args.after,
        args.keyword,
        JOYSOUND_FIRST_OFFSET,
      );

      // Prime DAM's canonical readings into the cache in parallel with the
      // JOYSOUND search so it adds no latency of its own.
      const damPrimePromise = primeDamReadings(
        "song",
        args.keyword,
        dataSources.dkwebsys,
      );

      return searchWithRomajiFallback<
        Awaited<ReturnType<JoysoundAPI["getSongListByKeyword"]>>
      >(
        position.keyword,
        position.offset === JOYSOUND_FIRST_OFFSET,
        (result) => result.length,
        (a, b) =>
          dedupeBy([...a, ...b], (song) => song.selSongNo).slice(0, firstInt),
        (keyword) =>
          dataSources.joysound.getSongListByKeyword(
            keyword,
            position.offset,
            firstInt,
          ),
      ).then(async ({ result, effectiveKeyword }) => {
        const sorted = sortByTitleMatchTier(
          result as any[],
          args.keyword,
          (song) => song.songName,
        );

        // Ensure DAM's readings are cached before the per-row nameYomi field
        // resolvers run; time-boxed so a slow DAM can't stall the response.
        await withTimeout(damPrimePromise, DAM_YOMI_TIMEOUT_MS, undefined);

        const endCursor = formatPositionCursor({
          keyword: effectiveKeyword,
          offset: position.offset + firstInt,
        });

        return {
          edges: sorted.map((song, i) => ({
            node: {
              id: song.selSongNo,
              name: song.songName,
              artistName: song.artistName,
            },
            cursor: `${endCursor}#${i}`,
          })),
          pageInfo: {
            hasPreviousPage: false,
            hasNextPage: result.length === firstInt,
            startCursor: formatPositionCursor({
              keyword: args.keyword,
              offset: JOYSOUND_FIRST_OFFSET,
            }),
            endCursor,
          },
        };
      });
    },
    joysoundArtistsByKeyword: (
      _: any,
      args: { keyword: string; first: number | null; after: string | null },
      { dataSources }: IDataSources,
    ): Promise<Connection<JoysoundArtistParent, string>> => {
      const firstInt = args.first || 100;
      const position = parsePositionCursor(
        args.after,
        args.keyword,
        JOYSOUND_FIRST_OFFSET,
      );

      const damPrimePromise = primeDamReadings(
        "artist",
        args.keyword,
        dataSources.dkwebsys,
      );

      return searchWithRomajiFallback<
        Awaited<ReturnType<JoysoundAPI["getArtistListByKeyword"]>>
      >(
        position.keyword,
        position.offset === JOYSOUND_FIRST_OFFSET,
        (result) => result.length,
        (a, b) =>
          dedupeBy([...a, ...b], (artist) => artist.artistId_digi).slice(
            0,
            firstInt,
          ),
        (keyword) =>
          dataSources.joysound.getArtistListByKeyword(
            keyword,
            position.offset,
            firstInt,
          ),
      ).then(async ({ result, effectiveKeyword }) => {
        // Ensure DAM's readings are cached before the per-row nameYomi field
        // resolvers run; time-boxed so a slow DAM can't stall the response.
        await withTimeout(damPrimePromise, DAM_YOMI_TIMEOUT_MS, undefined);

        const endCursor = formatPositionCursor({
          keyword: effectiveKeyword,
          offset: position.offset + firstInt,
        });

        return {
          edges: result.map((artist, i) => ({
            node: {
              id: artist.artistId_digi,
              name: artist.artistName,
            },
            cursor: `${endCursor}#${i}`,
          })),
          pageInfo: {
            hasPreviousPage: false,
            hasNextPage: result.length === firstInt,
            startCursor: formatPositionCursor({
              keyword: args.keyword,
              offset: JOYSOUND_FIRST_OFFSET,
            }),
            endCursor,
          },
        };
      });
    },
    songsByName: (
      _: any,
      args: { name: string; first: number | null; after: string | null },
      { dataSources }: IDataSources,
    ): Promise<Connection<SongParent, string>> => {
      const firstInt = args.first || 0;
      const position = parsePositionCursor(
        args.after,
        args.name,
        DAM_FIRST_OFFSET,
      );

      return searchWithRomajiFallback<
        Awaited<ReturnType<DkwebsysAPI["getMusicByKeyword"]>>
      >(
        position.keyword,
        position.offset === DAM_FIRST_OFFSET,
        (result) => result.list.length,
        (a, b) => ({
          data: {
            totalCount: Math.max(a.data.totalCount, b.data.totalCount),
          },
          list: dedupeBy(
            [...a.list, ...b.list],
            (song) => song.requestNo,
          ).slice(0, firstInt),
        }),
        (keyword) =>
          dataSources.dkwebsys.getMusicByKeyword(
            keyword,
            firstInt,
            position.offset,
          ),
      ).then(({ result, effectiveKeyword }) => {
        const sorted = sortByTitleMatchTier(
          result.list,
          args.name,
          (song) => song.title,
        );

        const endCursor = formatPositionCursor({
          keyword: effectiveKeyword,
          offset: position.offset + firstInt,
        });

        return {
          edges: sorted.map((song, i) => ({
            node: {
              id: song.requestNo,
              name: song.title,
              nameYomi: song.titleYomi,
              artistName: song.artist,
              artistNameYomi: song.artistYomi,
            },
            cursor: `${endCursor}#${i}`,
          })),
          pageInfo: {
            hasPreviousPage: false, // We can always do this because we don't support backward pagination
            hasNextPage: position.offset + firstInt < result.data.totalCount,
            startCursor: formatPositionCursor({
              keyword: args.name,
              offset: DAM_FIRST_OFFSET,
            }),
            endCursor,
          },
        };
      });
    },
    searchSongs: (
      _: any,
      args: {
        keyword: string | null;
        first: number | null;
        after: string | null;
      },
      { dataSources }: IDataSources,
    ): Promise<SearchedConnection<SearchedSongParent>> => {
      const keyword = args.keyword || "";
      const first = args.first || SEARCH_PAGE_SIZE;
      const cursor = parseSearchCursor(args.after, keyword);

      return Promise.allSettled([
        searchWithRomajiFallback<
          Awaited<ReturnType<DkwebsysAPI["getMusicByKeyword"]>>
        >(
          cursor.dam.keyword,
          cursor.dam.offset === DAM_FIRST_OFFSET,
          (result) => result.list.length,
          (a, b) => ({
            data: {
              totalCount: Math.max(a.data.totalCount, b.data.totalCount),
            },
            list: dedupeBy(
              [...a.list, ...b.list],
              (song) => song.requestNo,
            ).slice(0, first),
          }),
          (candidate) =>
            dataSources.dkwebsys.getMusicByKeyword(
              candidate,
              first,
              cursor.dam.offset,
            ),
        ),
        searchWithRomajiFallback<
          Awaited<ReturnType<JoysoundAPI["getSongListByKeyword"]>>
        >(
          cursor.joysound.keyword,
          cursor.joysound.offset === JOYSOUND_FIRST_OFFSET,
          (result) => result.length,
          (a, b) =>
            dedupeBy([...a, ...b], (song) => song.selSongNo).slice(0, first),
          (candidate) =>
            dataSources.joysound.getSongListByKeyword(
              candidate,
              cursor.joysound.offset,
              first,
            ),
        ),
      ]).then(([damResult, joysoundResult]) => {
        const unavailableSources = failedSources(
          keyword,
          damResult,
          joysoundResult,
        );

        const damSongs =
          damResult.status === "fulfilled" ? damResult.value.result.list : [];
        const joysoundSongs =
          joysoundResult.status === "fulfilled"
            ? joysoundResult.value.result
            : [];

        // The DAM leg carries DAM's curated readings for both catalogs' rows,
        // so fold them in here rather than paying primeDamReadings' separate
        // (identical) request the way the per-service resolvers do. Ordered
        // before the return, so the JOYSOUND rows' nameYomi field resolvers
        // see the cache already warm. Keyed by the keyword the rows actually
        // came from, which for a romaji query is the kana reading — the
        // self-credit in damSongReadingPairs compares result titles against
        // it, and "aidoru" would never match one.
        if (damResult.status === "fulfilled") {
          const damKeyword = damResult.value.effectiveKeyword;
          if (damKeyword) {
            applyDamReadings(
              "song",
              damKeyword,
              damSongReadingPairs(damKeyword, damSongs),
            );
          }
        }

        const merged = sortByTitleMatchTier(
          interleave(
            joysoundSongs.map(
              (song): SearchedSongParent => ({
                id: `JOYSOUND:${song.selSongNo}`,
                songId: song.selSongNo,
                source: "JOYSOUND",
                name: song.songName,
                artistName: song.artistName,
              }),
            ),
            damSongs.map(
              (song): SearchedSongParent => ({
                id: `DAM:${song.requestNo}`,
                songId: song.requestNo,
                source: "DAM",
                name: song.title,
                nameYomi: song.titleYomi,
                artistName: song.artist,
                artistNameYomi: song.artistYomi,
              }),
            ),
          ),
          keyword,
          (song) => song.name,
        );

        const next = advanceSearchCursor(
          cursor,
          first,
          damResult,
          joysoundResult,
        );
        const endCursor = formatSearchCursor(next);
        const hasNextPage =
          (damResult.status === "fulfilled" &&
            cursor.dam.offset + first <
              damResult.value.result.data.totalCount) ||
          (joysoundResult.status === "fulfilled" &&
            joysoundResult.value.result.length === first);

        return {
          edges: merged.map((node, i) => ({
            node,
            cursor: `${endCursor}#${i}`,
          })),
          pageInfo: {
            hasPreviousPage: false,
            hasNextPage,
            startCursor: formatSearchCursor(initialSearchCursor(keyword)),
            endCursor,
          },
          unavailableSources,
        };
      });
    },
    searchArtists: (
      _: any,
      args: {
        keyword: string | null;
        first: number | null;
        after: string | null;
      },
      { dataSources }: IDataSources,
    ): Promise<SearchedConnection<SearchedArtistParent>> => {
      const keyword = args.keyword || "";
      const first = args.first || SEARCH_PAGE_SIZE;
      const cursor = parseSearchCursor(args.after, keyword);

      return Promise.allSettled([
        searchWithRomajiFallback<
          Awaited<ReturnType<DkwebsysAPI["getArtistByKeyword"]>>
        >(
          cursor.dam.keyword,
          cursor.dam.offset === DAM_FIRST_OFFSET,
          (result) => result.list.length,
          (a, b) => ({
            data: {
              totalCount: Math.max(a.data.totalCount, b.data.totalCount),
            },
            list: dedupeBy(
              [...a.list, ...b.list],
              (artist) => artist.artistCode,
            ).slice(0, first),
          }),
          (candidate) =>
            dataSources.dkwebsys.getArtistByKeyword(
              candidate,
              first,
              cursor.dam.offset,
            ),
        ),
        searchWithRomajiFallback<
          Awaited<ReturnType<JoysoundAPI["getArtistListByKeyword"]>>
        >(
          cursor.joysound.keyword,
          cursor.joysound.offset === JOYSOUND_FIRST_OFFSET,
          (result) => result.length,
          (a, b) =>
            dedupeBy([...a, ...b], (artist) => artist.artistId_digi).slice(
              0,
              first,
            ),
          (candidate) =>
            dataSources.joysound.getArtistListByKeyword(
              candidate,
              cursor.joysound.offset,
              first,
            ),
        ),
      ]).then(([damResult, joysoundResult]) => {
        const unavailableSources = failedSources(
          keyword,
          damResult,
          joysoundResult,
        );

        const damArtists =
          damResult.status === "fulfilled" ? damResult.value.result.list : [];
        const joysoundArtists =
          joysoundResult.status === "fulfilled"
            ? joysoundResult.value.result
            : [];

        if (damResult.status === "fulfilled") {
          const damKeyword = damResult.value.effectiveKeyword;
          if (damKeyword) {
            applyDamReadings(
              "artist",
              damKeyword,
              damArtistReadingPairs(damKeyword, damArtists),
            );
          }
        }

        // Artist names aren't titles, but the same exact/prefix/other tiering
        // is what floats a literal name match over the catalogs' own ordering.
        const merged = sortByTitleMatchTier(
          interleave(
            joysoundArtists.map(
              (artist): SearchedArtistParent => ({
                id: `JOYSOUND:${artist.artistId_digi}`,
                artistId: artist.artistId_digi,
                source: "JOYSOUND",
                name: artist.artistName,
              }),
            ),
            damArtists.map(
              (artist): SearchedArtistParent => ({
                id: `DAM:${artist.artistCode}`,
                artistId: artist.artistCode.toString(),
                source: "DAM",
                name: artist.artist,
                nameYomi: artist.artistYomi,
                songCount: artist.holdMusicCount,
              }),
            ),
          ),
          keyword,
          (artist) => artist.name,
        );

        const next = advanceSearchCursor(
          cursor,
          first,
          damResult,
          joysoundResult,
        );
        const endCursor = formatSearchCursor(next);
        const hasNextPage =
          (damResult.status === "fulfilled" &&
            cursor.dam.offset + first <
              damResult.value.result.data.totalCount) ||
          (joysoundResult.status === "fulfilled" &&
            joysoundResult.value.result.length === first);

        return {
          edges: merged.map((node, i) => ({
            node,
            cursor: `${endCursor}#${i}`,
          })),
          pageInfo: {
            hasPreviousPage: false,
            hasNextPage,
            startCursor: formatSearchCursor(initialSearchCursor(keyword)),
            endCursor,
          },
          unavailableSources,
        };
      });
    },
    songById: (
      _: any,
      args: { id: string },
      { dataSources }: IDataSources,
    ): Promise<SongParent> =>
      dataSources.dkwebsys.getMusicDetailsInfo(args.id).then((data) => ({
        id: args.id,
        name: data.data.title,
        nameYomi: data.data.titleYomi_Kana,
        artistName: data.data.artist,
        artistNameYomi: "",
        lyricsPreview: data.data.firstLine,
        vocalTypes: data.list[0].mModelMusicInfoList[0].guideVocal
          .split(",")
          .map((vocalType) => {
            switch (vocalType) {
              case "0":
                return "NORMAL";
              case "1":
                return "GUIDE_MALE";
              case "2":
                return "GUIDE_FEMALE";
              default:
                console.warn(`unknown vocal type ${vocalType}`);
                return "UNKNOWN";
            }
          }),
        tieUp: data.list[0].mModelMusicInfoList[0].highlightTieUp,
        playtime: parseInt(data.list[0].mModelMusicInfoList[0].playtime, 10),
      })),
    artistsByName: (
      _: any,
      args: { name: string; first: number | null; after: string | null },
      { dataSources }: IDataSources,
    ): Promise<Connection<ArtistParent, string>> => {
      const firstInt = args.first || 0;
      const position = parsePositionCursor(
        args.after,
        args.name,
        DAM_FIRST_OFFSET,
      );

      return searchWithRomajiFallback<
        Awaited<ReturnType<DkwebsysAPI["getArtistByKeyword"]>>
      >(
        position.keyword,
        position.offset === DAM_FIRST_OFFSET,
        (result) => result.list.length,
        (a, b) => ({
          data: {
            totalCount: Math.max(a.data.totalCount, b.data.totalCount),
          },
          list: dedupeBy(
            [...a.list, ...b.list],
            (artist) => artist.artistCode,
          ).slice(0, firstInt),
        }),
        (keyword) =>
          dataSources.dkwebsys.getArtistByKeyword(
            keyword,
            firstInt,
            position.offset,
          ),
      ).then(({ result, effectiveKeyword }) => {
        const endCursor = formatPositionCursor({
          keyword: effectiveKeyword,
          offset: position.offset + firstInt,
        });

        return {
          edges: result.list.map((artist, i) => ({
            node: {
              id: artist.artistCode.toString(),
              name: artist.artist,
              nameYomi: artist.artistYomi,
              songCount: artist.holdMusicCount,
            },
            cursor: `${endCursor}#${i}`,
          })),
          pageInfo: {
            hasPreviousPage: false, // We can always do this because we don't support backward pagination
            hasNextPage: position.offset + firstInt < result.data.totalCount,
            startCursor: formatPositionCursor({
              keyword: args.name,
              offset: DAM_FIRST_OFFSET,
            }),
            endCursor,
          },
        };
      });
    },
    artistById: (
      _: any,
      args: { id: string; first: number | null; after: string | null },
      { dataSources }: IDataSources,
    ): Promise<ArtistParent> => {
      const firstInt = args.first || 0;
      const afterInt = args.after ? parseInt(args.after, 10) : 0;

      return dataSources.dkwebsys
        .getMusicListByArtist(args.id, firstInt, afterInt)
        .then((data) => ({
          id: args.id,
          name: data.data.artist,
          nameYomi: data.data.artistYomi_Kana,
          songCount: data.data.totalCount,
        }));
    },
    currentSong: () => {
      return db.currentSong;
    },
    people: (): Person[] => listPeople(),
    personByDevice: (_: any, args: { deviceId: string }): Person | null =>
      personByDevice(args.deviceId),
    queue: () => {
      if (!db.songQueue.length) return [];
      return db.songQueue;
    },
    serviceHealth: (): ServiceHealthState =>
      currentServiceHealth ?? {
        damAvailable: true,
        joysoundAvailable: true,
        checkedAt: "0",
      },
    config: () => {
      return {
        ...karafriendsConfig,
        __typename: "KarafriendsConfig",
      };
    },
    // Counted server-side rather than by paging songHistory to the client: the
    // history only grows, and the card wants one number.
    scoreHistory: (
      _: any,
      args: {
        songType: string;
        songId: string;
        nickname: string;
        personId: string | null;
      },
    ) =>
      scoreHistoryFor(
        args.songType,
        args.songId,
        args.nickname,
        args.personId,
        SCORING_FORMULA_VERSION,
      ),
    songPlayCount: (
      _: any,
      args: {
        songType: string;
        songId: string;
        nickname: string;
        personId: string | null;
      },
    ): number =>
      db.songHistory.filter(({ song }) => {
        if (song.__typename !== args.songType || song.songId !== args.songId) {
          return false;
        }
        const singer = song.userIdentity;
        // personId is the real identity -- a phone handed around, or a cleared
        // localStorage, still resolves to the same singer. It is absent on
        // entries from before the registry existed, and on those the nickname
        // is the best available answer.
        if (args.personId && singer.personId) {
          return singer.personId === args.personId;
        }
        return singer.nickname === args.nickname;
      }).length,
    songHistory: (
      _: any,
      args: { first: number | null; after: string | null },
    ): Connection<SongHistoryItem, string> => {
      const firstInt = args.first || 0;
      const afterInt = args.after ? parseInt(args.after, 10) : 0;

      // `first` is a count, not an end index: slice(afterInt, firstInt) made
      // every page after the first empty (page 2 is slice(30, 30)), so the
      // remocon's "More" fetched nothing and then hid itself — capping the
      // visible history at 30 no matter how much of it we'd kept.
      const edges = db.songHistory
        .slice(afterInt, afterInt + firstInt)
        .map((songHistoryItem, i) => ({
          node: songHistoryItem,
          // Cursors are "resume from here", so the next page's `after` is
          // one past this row.
          cursor: (afterInt + i + 1).toString(),
        }));

      return {
        edges,
        pageInfo: {
          hasPreviousPage: afterInt > 0,
          hasNextPage: afterInt + edges.length < db.songHistory.length,
          startCursor: (afterInt + 1).toString(),
          endCursor: (afterInt + edges.length).toString(),
        },
      };
    },
    youtubeVideoInfo: (
      _: any,
      args: { videoId: string },
      { dataSources }: IDataSources,
    ): Promise<YoutubeVideoInfoResult> => {
      return dataSources
        .youtube()
        .then((youtube) => youtube.getBasicInfo(args.videoId))
        .then((rawData) => {
          // youtubei.js types most basic_info fields as optionally undefined,
          // but getBasicInfo() reliably populates the ones we read; assert the
          // narrower shape we depend on (see YTVideoInfo above).
          const data = rawData as unknown as YTVideoInfo;
          if (data.playability_status.status !== "OK") {
            return {
              __typename: "YoutubeVideoInfoError",
              reason: data.playability_status.reason,
            };
          }

          const captionTracks: YTCaptionTrackData[] =
            data.captions?.caption_tracks || [];
          const captionLanguages: CaptionLanguage[] = captionTracks
            .filter(
              (captionTrack: YTCaptionTrackData) =>
                !captionTrack.vss_id.startsWith("a"),
            )
            .map((captionTrack: YTCaptionTrackData) => ({
              code: captionTrack.language_code,
              name: captionTrack.name.text,
            }));

          const loudnessDb =
            data.player_config?.audio_config?.loudness_db || 0.0;

          // The microformat lists every country a video is watchable in
          // (~249 entries when unrestricted), so a missing "US" means the
          // label region-locked it — an embed on a non-VPN US phone would
          // show "Video unavailable". Downloads still work (they run on the
          // VPN'd host), so this only gates the remocon preview.
          const availableCountries =
            data.page?.[0]?.microformat?.available_countries;

          return {
            __typename: "YoutubeVideoInfo",
            availableInUs:
              Array.isArray(availableCountries) && availableCountries.length > 0
                ? availableCountries.includes("US")
                : null,
            embeddable: data.playability_status.embeddable !== false,
            author: data.basic_info.author,
            captionLanguages,
            channelId: data.basic_info.channel_id,
            keywords: data.basic_info.keywords,
            lengthSeconds: data.basic_info.duration,
            description: data.basic_info.short_description,
            title: data.basic_info.title,
            viewCount: data.basic_info.view_count,
            gainValue: 10 ** ((-1 * loudnessDb) / 20),
          };
        });
    },
    nicoVideoInfo: async (
      _: any,
      args: { videoId: string },
    ): Promise<NicoVideoInfoResult> => {
      try {
        // @ts-ignore
        const watchData: WatchData = await nicovideo.watch(args.videoId);
        return {
          __typename: "NicoVideoInfo",
          author: watchData.owner.nickname,
          channelId: watchData.owner.id.toString(10),
          description: watchData.video.description,
          lengthSeconds: watchData.video.duration,
          title: watchData.video.title,
          thumbnailUrl: watchData.video.thumbnail.player,
          viewCount: watchData.video.count.view,
        };
      } catch (e) {
        return {
          __typename: "NicoVideoInfoError",
          reason: "Failed getting video info. Maybe an invalid VideoID?",
        };
      }
    },
    suggestedYoutubeVideos: async (
      _: any,
      args: { songId: string },
      { dataSources }: IDataSources,
    ): Promise<SuggestedYoutubeVideosResult> => {
      // The telop is only needed for expectedDurationSec, not for the search
      // query itself. A previous download of this song already left it on
      // disk — reading that beats re-fetching the multi-megabyte getFME
      // payload (telop + ogg) just to compute a duration. When it's missing,
      // kick the raw-data fetch off alongside the YouTube search rather than
      // waiting for it before even starting the search.
      const cachedTelopFilename = path.resolve(
        TEMP_FOLDER,
        `joysound-${args.songId}.joy_02`,
      );
      const telopBufferPromise: Promise<Uint8Array> = fs.existsSync(
        cachedTelopFilename,
      )
        ? fs.promises.readFile(cachedTelopFilename)
        : dataSources.joysound
            .getSongRawData(args.songId)
            .then((rawData) => decodeJoysoundBase64Field(rawData.telop));
      const songDetail = await dataSources.joysound.getSongDetail(args.songId);

      const query = `${songDetail.artistName} ${songDetail.name}`;
      const searchResultsPromise = dataSources
        .youtube()
        .then((youtube) => youtube.search(query, { type: "video" }));

      const [telopBuffer, searchResults] = await Promise.all([
        telopBufferPromise,
        searchResultsPromise,
      ]);

      const expectedDurationSec = getSongDuration(
        telopBuffer.buffer as ArrayBuffer,
      );

      const videos = (searchResults.videos ??
        []) as unknown as YoutubeSearchVideoItem[];

      // Also match the artist's romanized name so official channels named in
      // Latin script ("Hikaru Utada" for 宇多田ヒカル) rank as artist
      // channels; see romajiTokenKey. Best-effort - a kuromoji misreading
      // just means no extra variant matches.
      const artistNameVariants = [songDetail.artistName];
      try {
        await kuroshiroReady;
        const romajiArtistName = await kuroshiro.convert(
          songDetail.artistName,
          { to: "romaji", mode: "spaced" },
        );
        if (romajiArtistName) artistNameVariants.push(romajiArtistName);
      } catch (e) {
        console.warn(`Failed to romanize artist name for MV suggestion: ${e}`);
      }

      const candidates = await pickMusicVideoCandidates(
        videos,
        artistNameVariants,
        songDetail.name,
        expectedDurationSec,
        6,
      );

      if (candidates.length === 0) {
        return {
          __typename: "SuggestedYoutubeVideoError",
          reason: `No suitable music video found for "${query}"`,
        };
      }

      return { __typename: "SuggestedYoutubeVideos", videos: candidates };
    },
    bgmTrack: () => db.bgmTrack,
    bgmVolume: () => db.bgmVolume,
    breakEndsAt: () => db.breakEndsAt,
    breakMessage: () =>
      db.breakMessageText !== null
        ? { text: db.breakMessageText, author: db.breakMessageAuthor }
        : null,
    guideMelodyVolume: () => db.guideMelodyVolume,
    historyRecordingEnabled: () => db.historyRecordingEnabled,
    hostname: () => currentHostname(),
    joysoundRomajiWordSegmentation: () => db.joysoundRomajiWordSegmentation,
    micOutputEnabled: () => db.micOutputEnabled,
    micRmsGateEnabled: () => db.micRmsGateEnabled,
    micRmsGateThreshold: () => db.micRmsGateThreshold,
    experimentalScoringEnabled: () => db.experimentalScoringEnabled,
    oledFriendly: () => db.oledFriendly,
    pianoRollOpacity: () => db.pianoRollOpacity,
    pianoRollSize: () => db.pianoRollSize,
    pitchShiftSemis: () => db.pitchShiftSemis,
    queueIntermissionEnabled: () => db.queueIntermissionEnabled,
    settingsCollapsed: () => db.settingsCollapsed,
    sidebarCollapsed: () => db.sidebarCollapsed,
    playbackState: () => db.playbackState,
    videoDownloadProgress: (
      _: any,
      args: {
        videoDownloadType: number;
        songId: string;
        suffix: string | null;
      },
    ): VideoDownloadProgress => {
      const progress = getVideoDownloadProgress(
        db.downloadQueue,
        args.videoDownloadType,
        args.songId,
        args.suffix,
      );

      return { progress };
    },
  },
  Mutation: {
    sendEmote: (_: any, args: { emote: Emote }): boolean => {
      pubsub.publish(SubscriptionEvent.Emote, { emote: args.emote });
      return true;
    },
    queueJoysoundSong: (
      _: any,
      args: { input: QueueJoysoundSongInput; tryHeadOfQueue: boolean },
      { dataSources }: IDataSources,
    ): QueueSongResult => {
      const queueItem: JoysoundQueueItem = {
        __typename: "JoysoundQueueItem",
        timestamp: Date.now().toString(),
        ...args.input,
      };

      if (hasMaxSongsInQueue(queueItem.userIdentity)) {
        return {
          __typename: "QueueSongError",
          reason: `${queueItem.userIdentity.nickname} already has ${karafriendsConfig.paxSongQueueLimit} song(s) in the queue or downloading`,
        };
      }

      const pushToHead =
        args.tryHeadOfQueue && canPushToHeadOfQueue(queueItem.userIdentity);
      console.log(`queueJoysoundSong: pushToHead=${pushToHead}`);

      if (queueItem.youtubeVideoId) {
        db.joysoundYoutubeVideos[queueItem.songId] = {
          videoId: queueItem.youtubeVideoId,
          syncEnabled: queueItem.youtubeVideoSyncEnabled !== false,
        };
      } else {
        delete db.joysoundYoutubeVideos[queueItem.songId];
      }
      saveDb();

      downloadJoysoundData(
        db.downloadQueue,
        queueItem.userIdentity,
        dataSources.joysound,
        queueItem,
        pushToHead,
        pushSongToQueue,
      );

      return {
        __typename: "QueueSongInfo",
        eta: db.songQueue.reduce((acc, cur) => acc + (cur.playtime || 0), 0),
      };
    },
    queueDamSong: (
      _: any,
      args: { input: QueueDamSongInput; tryHeadOfQueue: boolean },
      { dataSources }: IDataSources,
    ): QueueSongResult => {
      const queueItem: DamQueueItem = {
        timestamp: Date.now().toString(),
        ...args.input,
        __typename: "DamQueueItem",
      };

      if (hasMaxSongsInQueue(queueItem.userIdentity)) {
        return {
          __typename: "QueueSongError",
          reason: `${queueItem.userIdentity.nickname} already has ${karafriendsConfig.paxSongQueueLimit} song(s) in the queue or downloading`,
        };
      }

      const pushToHead =
        args.tryHeadOfQueue && canPushToHeadOfQueue(queueItem.userIdentity);
      console.log(`queueDamSong: pushToHead=${pushToHead}`);

      console.log(`Starting offline download of ${queueItem.songId}`);
      dataSources.minsei
        .getMusicStreamingUrls(queueItem.songId)
        .then((data) => {
          // XXX: This should be already be a number but typescript tells me it is not
          const selectedIndex = data.list[+queueItem.streamingUrlIdx];
          // Streaming-absent songs (physical-machine-only licenses) return an
          // empty list; leave the song queued and let the guarded
          // streamingUrls read resolver handle it at play time.
          if (!selectedIndex) {
            throw new Error(
              `no streaming URL at index ${queueItem.streamingUrlIdx}`,
            );
          }
          const url = karafriendsConfig.useLowBitrateUrl
            ? selectedIndex.lowBitrateUrl
            : selectedIndex.highBitrateUrl;
          downloadDamVideo(url, queueItem.songId, queueItem.streamingUrlIdx);
        })
        .catch((e) => {
          console.error(
            `Failed predownloading DAM ${queueItem.songId}, skipping predownload`,
            e,
          );
        });

      return pushSongToQueue(queueItem, pushToHead);
    },
    queueYoutubeSong: (
      _: any,
      args: { input: QueueYoutubeSongInput; tryHeadOfQueue: boolean },
    ): QueueSongResult => {
      const queueItem: YoutubeQueueItem = {
        timestamp: Date.now().toString(),
        ...args.input,
        hasAdhocLyrics: args.input.adhocSongLyrics ? true : false,
        hasCaptions: args.input.captionCode ? true : false,
        gainValue: args.input.gainValue,
        __typename: "YoutubeQueueItem",
      };

      if (hasMaxSongsInQueue(queueItem.userIdentity)) {
        return {
          __typename: "QueueSongError",
          reason: `${queueItem.userIdentity.nickname} already has ${karafriendsConfig.paxSongQueueLimit} song(s) in the queue or downloading`,
        };
      }

      const pushToHead =
        args.tryHeadOfQueue && canPushToHeadOfQueue(queueItem.userIdentity);
      console.log(`queueDamSong: pushToHead=${pushToHead}`);

      if (args.input.adhocSongLyrics) {
        db.idToAdhocLyrics[args.input.songId] = cleanupAdhocSongLyrics(
          args.input.adhocSongLyrics,
        );
      }

      downloadYoutubeVideo(
        db.downloadQueue,
        queueItem.userIdentity,
        args.input.songId,
        args.input.captionCode,
        pushSongToQueue.bind(null, queueItem, pushToHead),
      );

      // The song likely hasn't actually been added to the queue yet since it needs to download,
      // but let's optimistically return the eta assuming it will successfully queue
      return {
        __typename: "QueueSongInfo",
        eta:
          db.songQueue.reduce((acc, cur) => acc + (cur.playtime || 0), 0) +
          (args.input.playtime || 0),
      };
    },
    queueNicoSong: (
      _: any,
      args: { input: QueueNicoSongInput; tryHeadOfQueue: boolean },
    ): QueueSongResult => {
      const queueItem: NicoQueueItem = {
        timestamp: Date.now().toString(),
        ...args.input,
        __typename: "NicoQueueItem",
      };

      if (hasMaxSongsInQueue(queueItem.userIdentity)) {
        return {
          __typename: "QueueSongError",
          reason: `${queueItem.userIdentity.nickname} already has ${karafriendsConfig.paxSongQueueLimit} song(s) in the queue or downloading`,
        };
      }

      const pushToHead =
        args.tryHeadOfQueue && canPushToHeadOfQueue(queueItem.userIdentity);
      console.log(`queueDamSong: pushToHead=${pushToHead}`);

      downloadNicoVideo(
        db.downloadQueue,
        queueItem.userIdentity,
        args.input.songId,
        pushSongToQueue.bind(null, queueItem, pushToHead),
      );
      // The song likely hasn't actually been added to the queue yet since it needs to download,
      // but let's optimistically return the eta assuming it will successfully queue
      return {
        __typename: "QueueSongInfo",
        eta:
          db.songQueue.reduce((acc, cur) => acc + (cur.playtime || 0), 0) +
          (args.input.playtime || 0),
      };
    },
    pushAdhocLyrics: (
      _: any,
      args: { input: PushAdhocLyricsInput },
    ): boolean => {
      db.currentSongAdhocLyrics.push({
        lyric: args.input.lyric,
        lyricIndex: args.input.lyricIndex,
      });
      pubsub.publish(SubscriptionEvent.CurrentSongAdhocLyricsChanged, {
        currentSongAdhocLyricsChanged: db.currentSongAdhocLyrics,
      });
      saveDb();
      return true;
    },
    popSong: (_: any, args: {}): QueueItem | null => {
      const newSong = db.songQueue.shift() || null;

      db.currentSongAdhocLyrics = [];

      if (
        db.currentSong &&
        db.currentSong.__typename === "YoutubeQueueItem" &&
        db.currentSong.hasAdhocLyrics
      ) {
        delete db.idToAdhocLyrics[db.currentSong.songId];
      }

      pubsub.publish(SubscriptionEvent.CurrentSongAdhocLyricsChanged, {
        currentSongAdhocLyricsChanged: db.currentSongAdhocLyrics,
      });

      db.currentSong = newSong;
      pubsub.publish(SubscriptionEvent.CurrentSongChanged, {
        currentSongChanged: db.currentSong,
      });

      pubsub.publish(SubscriptionEvent.QueueChanged, {
        queueChanged: {
          currentSong: db.currentSong,
          newQueue: db.songQueue,
        },
      });

      // The one place a song enters the history, so the one place the
      // recording gate has to sit — play counts and anything else keyed off
      // songHistory inherit it for free.
      if (db.currentSong && db.historyRecordingEnabled) {
        const prevSong: QueueItem | null = db.songHistory[0]?.song || null;

        if (
          !prevSong ||
          db.currentSong.__typename !== prevSong.__typename ||
          db.currentSong.songId !== prevSong.songId ||
          db.currentSong.timestamp !== prevSong.timestamp
        ) {
          db.songHistory.unshift({ song: db.currentSong });
        }
      }

      saveDb();
      // Player.tsx polls popSong every few seconds whenever the queue is
      // idle/empty — only trigger a health check on an actual song
      // transition, not on every empty-queue poll.
      if (newSong) triggerHealthCheck();
      return newSong;
    },
    recheckServiceHealth: async (): Promise<ServiceHealthState> => {
      return triggerHealthCheck(true);
    },
    updateUserIdentity: (_: any, args: { identity: UserIdentity }): boolean => {
      const { identity } = args;
      // Write the edit through to the registry first, so a rename sticks
      // across this person's other devices and across relaunches rather than
      // living only on the queue items it happened to touch.
      const person =
        updatePersonProfile(resolvePerson(identity).personId, {
          displayName: identity.nickname,
          profilePictureUrl: identity.profilePictureUrl ?? null,
          profilePictureFrame: identity.profilePictureFrame ?? null,
        }) ?? resolvePerson(identity);
      publishPeopleChanged();

      // Everything this *person* has queued, not just this device — they may
      // have queued from a phone and renamed themselves on a laptop.
      const rewritten = (item: QueueItem): QueueItem => ({
        ...item,
        userIdentity: identityFromPerson(person, item.userIdentity.deviceId),
      });
      const needsUpdate = (item: QueueItem) =>
        itemBelongsToPerson(item.userIdentity, person) &&
        JSON.stringify(item.userIdentity) !==
          JSON.stringify(rewritten(item).userIdentity);

      let changed = false;
      db.songQueue = db.songQueue.map((item) => {
        if (!needsUpdate(item)) return item;
        changed = true;
        return rewritten(item);
      });
      // Update the playing song's snapshot too, but only announce it through
      // queueChanged — publishing currentSongChanged would poke the renderer's
      // playback machinery mid-song.
      if (db.currentSong && needsUpdate(db.currentSong)) {
        db.currentSong = rewritten(db.currentSong);
        changed = true;
      }

      if (changed) {
        pubsub.publish(SubscriptionEvent.QueueChanged, {
          queueChanged: {
            currentSong: db.currentSong,
            newQueue: db.songQueue,
          },
        });
        saveDb();
      }
      return changed;
    },
    createPerson: (
      _: any,
      args: {
        input: {
          displayName: string;
          deviceId: string;
          profilePictureUrl?: string | null;
          profilePictureFrame?: string | null;
        };
      },
    ): Person => {
      const person = createPerson({
        deviceId: args.input.deviceId,
        nickname: args.input.displayName,
        profilePictureUrl: args.input.profilePictureUrl,
        profilePictureFrame: args.input.profilePictureFrame,
      });
      publishPeopleChanged();
      return person;
    },
    claimPerson: (
      _: any,
      args: { personId: string; deviceId: string },
    ): Person => {
      const person = claimPerson(args.personId, args.deviceId);
      if (!person) {
        // The registry was edited out from under this phone (a stale gate
        // left open across a people.json reset). Throwing sends the client
        // back through resolution rather than silently attaching nobody.
        throw new Error(`No such person: ${args.personId}`);
      }
      publishPeopleChanged();
      return person;
    },
    deletePerson: (_: any, args: { personId: string }): boolean => {
      const deleted = deletePerson(args.personId);
      if (deleted) publishPeopleChanged();
      return deleted;
    },
    removeSong: (
      _: any,
      args: { songId: string; timestamp: string },
    ): boolean => {
      const songIdx = db.songQueue.findIndex(
        (item) =>
          item.songId === args.songId && item.timestamp === args.timestamp,
      );
      db.songQueue.splice(songIdx, 1);
      pubsub.publish(SubscriptionEvent.QueueChanged, {
        queueChanged: {
          currentSong: db.currentSong,
          newQueue: db.songQueue,
        },
      });
      saveDb();
      return true;
    },
    moveSong: (
      _: any,
      args: { songId: string; timestamp: string; offset: number },
    ): boolean => {
      const songIdx = db.songQueue.findIndex(
        (item) =>
          item.songId === args.songId && item.timestamp === args.timestamp,
      );
      if (songIdx === -1) return false;
      const newIdx = Math.min(
        Math.max(songIdx + args.offset, 0),
        db.songQueue.length - 1,
      );
      if (newIdx === songIdx) return false;
      const [song] = db.songQueue.splice(songIdx, 1);
      db.songQueue.splice(newIdx, 0, song);
      pubsub.publish(SubscriptionEvent.QueueChanged, {
        queueChanged: {
          currentSong: db.currentSong,
          newQueue: db.songQueue,
        },
      });
      saveDb();
      return true;
    },
    clearQueue: (): boolean => {
      // Empty the pending queue first, then skip whatever's playing. The
      // renderer's Player observes SKIPPING (seeks the current video to its
      // end -> pollQueue -> popSong), which now finds an empty queue and
      // settles into WAITING, so the current song stops too.
      db.songQueue = [];
      pubsub.publish(SubscriptionEvent.QueueChanged, {
        queueChanged: {
          currentSong: db.currentSong,
          newQueue: db.songQueue,
        },
      });
      if (db.currentSong) {
        db.playbackState = PlaybackState.SKIPPING;
        pubsub.publish(SubscriptionEvent.PlaybackStateChanged, {
          playbackStateChanged: db.playbackState,
        });
      }
      saveDb();
      return true;
    },
    setQueueIntermissionEnabled: (
      _: any,
      args: { enabled: boolean },
    ): boolean => {
      db.queueIntermissionEnabled = args.enabled;
      pubsub.publish(SubscriptionEvent.QueueIntermissionEnabledChanged, {
        queueIntermissionEnabledChanged: db.queueIntermissionEnabled,
      });
      saveDb();
      return true;
    },
    setSettingsCollapsed: (_: any, args: { collapsed: boolean }): boolean => {
      db.settingsCollapsed = args.collapsed;
      pubsub.publish(SubscriptionEvent.SettingsCollapsedChanged, {
        settingsCollapsedChanged: db.settingsCollapsed,
      });
      saveDb();
      return true;
    },
    setMicOutputEnabled: (_: any, args: { enabled: boolean }): boolean => {
      db.micOutputEnabled = args.enabled;
      pubsub.publish(SubscriptionEvent.MicOutputEnabledChanged, {
        micOutputEnabledChanged: db.micOutputEnabled,
      });
      saveDb();
      return true;
    },
    setMicRmsGateEnabled: (_: any, args: { enabled: boolean }): boolean => {
      db.micRmsGateEnabled = args.enabled;
      pubsub.publish(SubscriptionEvent.MicRmsGateEnabledChanged, {
        micRmsGateEnabledChanged: db.micRmsGateEnabled,
      });
      saveDb();
      return true;
    },
    setMicRmsGateThreshold: (_: any, args: { threshold: number }): boolean => {
      db.micRmsGateThreshold = Math.min(
        Math.max(args.threshold, MIN_MIC_RMS_GATE_THRESHOLD),
        MAX_MIC_RMS_GATE_THRESHOLD,
      );
      pubsub.publish(SubscriptionEvent.MicRmsGateThresholdChanged, {
        micRmsGateThresholdChanged: db.micRmsGateThreshold,
      });
      saveDb();
      return true;
    },
    setExperimentalScoringEnabled: (
      _: any,
      args: { enabled: boolean },
    ): boolean => {
      db.experimentalScoringEnabled = args.enabled;
      pubsub.publish(SubscriptionEvent.ExperimentalScoringEnabledChanged, {
        experimentalScoringEnabledChanged: db.experimentalScoringEnabled,
      });
      saveDb();
      return true;
    },
    // Rebuilds one song's guide melody without downloading a video or touching
    // the queue. The melody cache used to live only in the temp dir, which
    // macOS sweeps by age, and losing it strands every recorded performance in
    // probe-logs/: a sung take can't be scored without the melody it was sung
    // against. This is how a lost cache is rebuilt from a list of songIds.
    recordScore: (
      _: any,
      args: {
        input: {
          personId: string | null;
          nickname: string;
          songType: string;
          songId: string;
          songName: string;
          artistName: string | null;
          display: number;
          band: string;
          overall: number;
          pitch: number;
          longTone: number | null;
          timing: number | null;
          compensationMs: number;
        };
      },
    ): boolean => {
      // Same gate as the history itself: a song queued to test a download
      // must not leave a personal best behind.
      if (!db.historyRecordingEnabled) return false;
      persistScore({
        ...args.input,
        timestamp: Date.now(),
        // Stamped here rather than sent by the renderer: the formula that
        // produced the number is a property of this build, not of the caller.
        formulaVersion: SCORING_FORMULA_VERSION,
      });
      return true;
    },
    backfillGuideMelody: async (
      _: any,
      args: { songId: string },
      { dataSources }: IDataSources,
    ): Promise<{
      songId: string;
      noteCount: number;
      alreadyCached: boolean;
    }> => {
      const countNotes = (data: number[] | null): number =>
        data === null ? 0 : parseScoringData(data).notes.length;

      const existing = await getJoysoundScoringData(args.songId);
      if (existing !== null) {
        return {
          songId: args.songId,
          noteCount: countNotes(existing),
          alreadyCached: true,
        };
      }

      // The ogg is the whole point of the fetch; getFME returns it beside the
      // telop, and extraction reads the guide melody off its FC channel.
      const rawData = await dataSources.joysound.getSongRawData(args.songId);
      ensureJoysoundGuideMelody(args.songId, {
        oggBuffer: Buffer.from(decodeJoysoundBase64Field(rawData.ogg)),
      });

      // Awaits the in-flight extraction rather than returning immediately, so a
      // caller working through a list learns the outcome before moving on.
      const scoringData = await getJoysoundScoringData(args.songId);

      // A cached result means the extraction ran, and zero notes is then a real
      // answer about the song. No cache file means it never got that far --
      // ffmpeg missing is the usual reason (running the app outside run-dev
      // resolves extraResources into Electron's own bundle). Those are worth
      // retrying and a song with no melody channel is not, so they must not
      // report the same thing.
      if (!hasCachedGuideMelody(args.songId)) {
        throw new Error(
          `Guide melody extraction produced nothing for ${args.songId} — check the app log for an ffmpeg spawn failure.`,
        );
      }

      return {
        songId: args.songId,
        noteCount: countNotes(scoringData),
        alreadyCached: false,
      };
    },
    setHistoryRecordingEnabled: (
      _: any,
      args: { enabled: boolean },
    ): boolean => {
      db.historyRecordingEnabled = args.enabled;
      pubsub.publish(SubscriptionEvent.HistoryRecordingEnabledChanged, {
        historyRecordingEnabledChanged: db.historyRecordingEnabled,
      });
      // Saved like every other setting even though loadDb re-derives it: the
      // spread in saveDb writes the whole db, and leaving it out would be a
      // special case to maintain for no benefit.
      saveDb();
      return true;
    },
    setHostname: (_: any, args: { hostname: string }): boolean => {
      db.hostname = args.hostname;
      pubsub.publish(SubscriptionEvent.HostnameChanged, {
        hostnameChanged: currentHostname(),
      });
      saveDb();
      return true;
    },
    setOledFriendly: (_: any, args: { oledFriendly: boolean }): boolean => {
      db.oledFriendly = args.oledFriendly;
      pubsub.publish(SubscriptionEvent.OledFriendlyChanged, {
        oledFriendlyChanged: db.oledFriendly,
      });
      saveDb();
      return true;
    },
    setJoysoundRomajiWordSegmentation: (
      _: any,
      args: { enabled: boolean },
    ): boolean => {
      db.joysoundRomajiWordSegmentation = args.enabled;
      pubsub.publish(SubscriptionEvent.JoysoundRomajiWordSegmentationChanged, {
        joysoundRomajiWordSegmentationChanged:
          db.joysoundRomajiWordSegmentation,
      });
      saveDb();
      return true;
    },
    setSidebarCollapsed: (_: any, args: { collapsed: boolean }): boolean => {
      db.sidebarCollapsed = args.collapsed;
      pubsub.publish(SubscriptionEvent.SidebarCollapsedChanged, {
        sidebarCollapsedChanged: db.sidebarCollapsed,
      });
      saveDb();
      return true;
    },
    setBgmTrack: (_: any, args: { track: string | null }): boolean => {
      const track = args.track || null;
      const isKnownTrack =
        track === null ||
        track === SHUFFLE_VALUE ||
        BGM_TRACKS.some((t) => t.filename === track);
      if (!isKnownTrack) {
        return false;
      }
      db.bgmTrack = track;
      pubsub.publish(SubscriptionEvent.BgmTrackChanged, {
        bgmTrackChanged: db.bgmTrack,
      });
      saveDb();
      return true;
    },
    setBreakEndsAt: (_: any, args: { endsAt: number | null }): boolean => {
      db.breakEndsAt = args.endsAt ?? null;
      pubsub.publish(SubscriptionEvent.BreakEndsAtChanged, {
        breakEndsAtChanged: db.breakEndsAt,
      });
      saveDb();
      return true;
    },
    setBreakMessage: (
      _: any,
      args: { text: string | null; author: string | null },
    ): boolean => {
      db.breakMessageText = args.text || null;
      db.breakMessageAuthor = db.breakMessageText ? args.author || null : null;
      pubsub.publish(SubscriptionEvent.BreakMessageChanged, {
        breakMessageChanged: db.breakMessageText
          ? { text: db.breakMessageText, author: db.breakMessageAuthor }
          : null,
      });
      saveDb();
      return true;
    },
    setBgmVolume: (_: any, args: { volume: number }): boolean => {
      db.bgmVolume = clampVolume(args.volume, MAX_BGM_VOLUME);
      pubsub.publish(SubscriptionEvent.BgmVolumeChanged, {
        bgmVolumeChanged: db.bgmVolume,
      });
      saveDb();
      return true;
    },
    setGuideMelodyVolume: (_: any, args: { volume: number }): boolean => {
      db.guideMelodyVolume = clampVolume(args.volume, MAX_GUIDE_MELODY_VOLUME);
      pubsub.publish(SubscriptionEvent.GuideMelodyVolumeChanged, {
        guideMelodyVolumeChanged: db.guideMelodyVolume,
      });
      saveDb();
      return true;
    },
    setPianoRollOpacity: (_: any, args: { opacity: number }): boolean => {
      db.pianoRollOpacity = clampVolume(args.opacity, MAX_PIANO_ROLL_OPACITY);
      pubsub.publish(SubscriptionEvent.PianoRollOpacityChanged, {
        pianoRollOpacityChanged: db.pianoRollOpacity,
      });
      saveDb();
      return true;
    },
    setPianoRollSize: (_: any, args: { size: number }): boolean => {
      db.pianoRollSize =
        args.size <= 0
          ? 0
          : Math.min(
              Math.max(args.size, MIN_PIANO_ROLL_SIZE),
              MAX_PIANO_ROLL_SIZE,
            );
      pubsub.publish(SubscriptionEvent.PianoRollSizeChanged, {
        pianoRollSizeChanged: db.pianoRollSize,
      });
      saveDb();
      return true;
    },
    setPitchShiftSemis: (_: any, args: { semis: number }): boolean => {
      db.pitchShiftSemis = args.semis;
      pubsub.publish(SubscriptionEvent.PitchShiftSemisChanged, {
        pitchShiftSemisChanged: args.semis,
      });
      return true;
    },
    setPlaybackState: (
      _: any,
      args: { playbackState: PlaybackState },
    ): boolean => {
      db.playbackState = args.playbackState;
      pubsub.publish(SubscriptionEvent.PlaybackStateChanged, {
        playbackStateChanged: args.playbackState,
      });
      saveDb();
      return true;
    },
  },
  Subscription: {
    bgmTrackChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([SubscriptionEvent.BgmTrackChanged]),
    },
    queueIntermissionEnabledChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([
          SubscriptionEvent.QueueIntermissionEnabledChanged,
        ]),
    },
    settingsCollapsedChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([
          SubscriptionEvent.SettingsCollapsedChanged,
        ]),
    },
    micOutputEnabledChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([
          SubscriptionEvent.MicOutputEnabledChanged,
        ]),
    },
    micRmsGateEnabledChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([
          SubscriptionEvent.MicRmsGateEnabledChanged,
        ]),
    },
    micRmsGateThresholdChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([
          SubscriptionEvent.MicRmsGateThresholdChanged,
        ]),
    },
    peopleChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([SubscriptionEvent.PeopleChanged]),
    },
    experimentalScoringEnabledChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([
          SubscriptionEvent.ExperimentalScoringEnabledChanged,
        ]),
    },
    historyRecordingEnabledChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([
          SubscriptionEvent.HistoryRecordingEnabledChanged,
        ]),
    },
    hostnameChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([SubscriptionEvent.HostnameChanged]),
    },
    oledFriendlyChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([SubscriptionEvent.OledFriendlyChanged]),
    },
    joysoundRomajiWordSegmentationChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([
          SubscriptionEvent.JoysoundRomajiWordSegmentationChanged,
        ]),
    },
    sidebarCollapsedChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([
          SubscriptionEvent.SidebarCollapsedChanged,
        ]),
    },
    bgmVolumeChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([SubscriptionEvent.BgmVolumeChanged]),
    },
    breakEndsAtChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([SubscriptionEvent.BreakEndsAtChanged]),
    },
    breakMessageChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([SubscriptionEvent.BreakMessageChanged]),
    },
    guideMelodyVolumeChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([
          SubscriptionEvent.GuideMelodyVolumeChanged,
        ]),
    },
    currentSongAdhocLyricsChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([
          SubscriptionEvent.CurrentSongAdhocLyricsChanged,
        ]),
    },
    currentSongChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([SubscriptionEvent.CurrentSongChanged]),
    },
    emote: {
      subscribe: () => pubsub.asyncIterableIterator([SubscriptionEvent.Emote]),
    },
    pianoRollOpacityChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([
          SubscriptionEvent.PianoRollOpacityChanged,
        ]),
    },
    pianoRollSizeChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([SubscriptionEvent.PianoRollSizeChanged]),
    },
    pitchShiftSemisChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([
          SubscriptionEvent.PitchShiftSemisChanged,
        ]),
    },
    playbackStateChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([SubscriptionEvent.PlaybackStateChanged]),
    },
    queueAdded: {
      subscribe: () =>
        pubsub.asyncIterableIterator([SubscriptionEvent.QueueAdded]),
    },
    queueChanged: {
      subscribe: () =>
        pubsub.asyncIterableIterator([SubscriptionEvent.QueueChanged]),
    },
  },
};

const schema = makeExecutableSchema({
  typeDefs: rawSchema,
  resolvers,
});

export const minseiCredentialsProvider = memoizeWithFailureEviction(
  async () => {
    const { damUsername, damPassword } = karafriendsConfig;
    const minseiLoginResult = await MinseiAPI.login(damUsername, damPassword);
    return {
      userCode: damUsername,
      authToken: minseiLoginResult.data.authToken,
    };
  },
);

export const joysoundCredentialsProvider = memoizeWithFailureEviction(
  async () => {
    const joysoundEmail = encodeURIComponent(karafriendsConfig.joysoundEmail);
    const joysoundPassword = encodeURIComponent(
      karafriendsConfig.joysoundPassword,
    );
    return JoysoundAPI.login(joysoundEmail, joysoundPassword);
  },
);

// Failure eviction so one failed Innertube.create (e.g. launching offline or
// mid-VPN-flap) doesn't poison YouTube search until relaunch.
const innertubeApiProvider = memoizeWithFailureEviction(async () => {
  // Ask YouTube for Japanese-locale results: with the default en-US locale,
  // search results for JP songs come back with machine-romanized titles
  // (e.g. tuki.'s 晩餐歌 as "tuki.『Bansanka』Official Music Video"), which
  // breaks the MV picker's song-name-in-title filter and hides JP keywords
  // (カラオケ, 弾き語り, ...) from its exclusion list.
  return Innertube.create({ lang: "ja", location: "JP" });
});

// Known-good DAM song, per DAM-DEBUG-HANDOFF.md, used as a health check
// canary when there's no last-known-good id persisted yet.
const DAM_HEALTH_CHECK_CANARY_SONG_ID = "3246-51"; // Lemon / 米津玄師

// The health check exists to tell the user quickly whether the services are
// reachable, so it must fail fast: one retry after 500ms instead of
// promise-retry's default 10-retry/~17-minute exponential backoff (which is
// what made the "Check now" spinner hang while geo-blocked).
const HEALTH_CHECK_RETRY_OPTIONS = { retries: 1, minTimeout: 500 };

// Hard ceiling on each service's health probe, so a hung socket (no HTTP
// error, just silence) can't pin the spinner either. On timeout the service
// is reported unavailable; the abandoned probe settles harmlessly in the
// background (its rejections are handled, per the main-process rule).
// Sized for a slow residential link + VPN, not just fiber: the probe is
// RTT-bound (fresh TLS handshakes for login + streaming API + a 1-byte CDN
// fetch, worst case ×2 attempts), which at a few hundred ms per round trip
// can legitimately take >20s — a timeout that fires on a *working* slow
// connection would falsely report the service down. Real failures (403,
// DNS, refused) still return in a few seconds; the ceiling only guards
// silent hangs.
const HEALTH_CHECK_TIMEOUT_MS = 30 * 1000;

function healthProbeWithTimeout(
  probe: Promise<boolean>,
  serviceName: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error(
        `[healthcheck] ${serviceName} check timed out after ${HEALTH_CHECK_TIMEOUT_MS}ms`,
      );
      resolve(false);
    }, HEALTH_CHECK_TIMEOUT_MS);
    probe.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (err) => {
        clearTimeout(timer);
        console.error(`[healthcheck] ${serviceName} check failed:`, err);
        resolve(false);
      },
    );
  });
}

async function checkDamStreamingUrl(
  minsei: MinseiAPI,
  fetcher: Fetcher,
  songId: string,
): Promise<boolean> {
  const streamingUrls = await minsei.getMusicStreamingUrls(
    songId,
    HEALTH_CHECK_RETRY_OPTIONS,
  );
  const url = karafriendsConfig.useLowBitrateUrl
    ? streamingUrls.list[0].lowBitrateUrl
    : streamingUrls.list[0].highBitrateUrl;
  // Probe a single byte: this is the real video URL, and node-fetch only
  // backpressure-pauses an unconsumed body rather than cancelling it, so a
  // bare GET leaves a socket slowly pulling video in the background — which
  // matters on slow (e.g. 40Mbps) connections where the periodic checks
  // would contend with an active download. 206 counts as ok; a CDN that
  // ignores Range just degrades to the old full-GET behavior.
  const response = await fetcher(url, {
    method: "GET",
    headers: { Range: "bytes=0-0" },
  });
  return response.ok;
}

async function checkDamHealth(
  minsei: MinseiAPI,
  dkwebsys: DkwebsysAPI,
  fetcher: Fetcher,
): Promise<boolean> {
  const candidateIds = [
    db.lastKnownGoodDamSongId,
    DAM_HEALTH_CHECK_CANARY_SONG_ID,
  ].filter((id): id is string => id !== null);

  for (const id of candidateIds) {
    try {
      if (await checkDamStreamingUrl(minsei, fetcher, id)) {
        if (db.lastKnownGoodDamSongId !== id) {
          db.lastKnownGoodDamSongId = id;
          saveDb();
        }
        return true;
      }
    } catch (err) {
      console.error(`[healthcheck] DAM check failed for song ${id}:`, err);
    }
  }

  // Neither the last-known-good id nor the canary worked (possibly
  // delisted) — fall back to a live search so this check never
  // permanently breaks.
  try {
    const searchResult = await dkwebsys.getMusicByKeyword("a", 1, 0);
    const fallbackId = searchResult.list[0]?.requestNo;
    if (
      fallbackId &&
      (await checkDamStreamingUrl(minsei, fetcher, fallbackId))
    ) {
      db.lastKnownGoodDamSongId = fallbackId;
      saveDb();
      return true;
    }
  } catch (err) {
    console.error("[healthcheck] DAM fallback search check failed:", err);
  }

  return false;
}

async function checkJoysoundHealth(joysound: JoysoundAPI): Promise<boolean> {
  try {
    await joysound.getSongListByKeyword("a", 0, 1);
    return true;
  } catch (err) {
    console.error("[healthcheck] Joysound check failed:", err);
    return false;
  }
}

async function runHealthCheck(
  server: ApolloServer<IDataSources>,
  fetcher: Fetcher,
): Promise<{ damAvailable: boolean; joysoundAvailable: boolean }> {
  const minsei = new MinseiAPI(minseiCredentialsProvider, {
    cache: server.cache,
    fetch: fetcher,
  });
  const dkwebsys = new DkwebsysAPI({ cache: server.cache, fetch: fetcher });
  const joysound = new JoysoundAPI(joysoundCredentialsProvider, {
    cache: server.cache,
    fetch: fetcher,
  });

  const [damAvailable, joysoundAvailable] = await Promise.all([
    healthProbeWithTimeout(checkDamHealth(minsei, dkwebsys, fetcher), "DAM"),
    healthProbeWithTimeout(checkJoysoundHealth(joysound), "Joysound"),
  ]);

  console.log(
    `[healthcheck] DAM available=${damAvailable}, Joysound available=${joysoundAvailable}`,
  );

  return { damAvailable, joysoundAvailable };
}

// Dedupes overlapping triggers (periodic timer, per-song, and a manual
// "check now" click could otherwise all fire a real network check at once).
// A manual "check now" passes force=true to start a fresh check immediately
// instead of joining an in-flight one — the whole point of the button is
// "my network just changed, re-probe NOW", and the in-flight check may have
// started before the change (or, historically, be sitting in retry backoff).
// The run counter lets a superseded run finish without clobbering the shared
// state with its stale result.
let latestHealthCheckRun = 0;

function triggerHealthCheck(force = false): Promise<ServiceHealthState> {
  if (healthCheckInFlight && !force) return healthCheckInFlight;

  if (!runHealthCheckOnce) {
    return Promise.resolve(
      currentServiceHealth ?? {
        damAvailable: true,
        joysoundAvailable: true,
        checkedAt: "0",
      },
    );
  }

  if (force) {
    // A manual "check now" re-probes everything from scratch, including the
    // logins: a cached success may hold an auth token the service has since
    // expired, and without this the button couldn't recover from that.
    // Periodic/per-song checks keep the cached creds — re-logging-in every
    // 3 minutes would be needless load on the services.
    minseiCredentialsProvider.reset();
    joysoundCredentialsProvider.reset();
  }

  const thisRun = ++latestHealthCheckRun;
  // runHealthCheckOnce never rejects: both service probes resolve false on
  // error/timeout (healthProbeWithTimeout), so this chain needs no .catch().
  healthCheckInFlight = runHealthCheckOnce().then((result) => {
    const state = { ...result, checkedAt: Date.now().toString() };
    if (thisRun === latestHealthCheckRun) {
      currentServiceHealth = state;
      healthCheckInFlight = null;
    }
    return state;
  });

  return healthCheckInFlight;
}

const HEALTH_CHECK_INTERVAL_MS = 3 * 60 * 1000;

export function applyGraphQLMiddleware(app: Application) {
  const httpServer = createServer(app);

  const wsServer = new WebSocketServer({
    server: httpServer,
    path: "/graphql",
  });

  const serverCleanup = useServer({ schema }, wsServer);

  db = loadDb();
  // Write the mirror once up front rather than waiting for the first saveDb:
  // a launch that gets rebooted out from under it before anyone touches a
  // setting would otherwise leave no mirror at all, which is precisely the
  // case this exists for.
  writeHistoryMirror();
  // Bootstrap from history the first time only (no people.json yet), so the
  // room's existing songs keep their attribution instead of everyone showing
  // up as a stranger. songHistory is newest-first, which is the order
  // loadPeople wants for picking each device's latest name/avatar.
  loadPeople(() =>
    db.songHistory.map(({ song }) => ({
      deviceId: song.userIdentity.deviceId,
      nickname: song.userIdentity.nickname,
      profilePictureUrl: song.userIdentity.profilePictureUrl,
      profilePictureFrame: song.userIdentity.profilePictureFrame,
      lastSeenAt: parseInt(song.timestamp, 10) || undefined,
    })),
  );
  loadScores();
  loadReadingCache();
  loadDamPrimeMarkers();
  loadJoysoundArtistSongCountCache();

  const server = new ApolloServer<IDataSources>({
    schema,
    plugins: [
      ApolloServerPluginDrainHttpServer({ httpServer }),
      ApolloServerPluginCacheControlDisabled(),
      ApolloServerPluginInlineTraceDisabled(),
      ApolloServerPluginLandingPageDisabled(),
      ApolloServerPluginSchemaReportingDisabled(),
      ApolloServerPluginUsageReportingDisabled(),
    ],
  });

  if (isDev) {
    app.use("/graphql", (req, res, next) => {
      res.append("Access-Control-Allow-Origin", "*");
      res.append("Access-Control-Allow-Headers", "*");
      if (req.method === "OPTIONS") {
        res.sendStatus(200);
        return;
      }
      next();
    });
  }

  const tunnelAgent = karafriendsConfig.proxyEnable
    ? tunnel.httpsOverHttp({
        proxy: {
          host: karafriendsConfig.proxyHost,
          port: karafriendsConfig.proxyPort,
          proxyAuth: `${karafriendsConfig.proxyUser}:${karafriendsConfig.proxyPass}`,
        },
      })
    : undefined;

  const fetcher = async (url: string, init?: FetcherRequestInit) => {
    return nodeFetch(url, { ...init, agent: tunnelAgent });
  };

  runHealthCheckOnce = () => runHealthCheck(server, fetcher);
  triggerHealthCheck();
  setInterval(triggerHealthCheck, HEALTH_CHECK_INTERVAL_MS);

  server.start().then(() => {
    app.use(
      "/graphql",
      express.json(),
      expressMiddleware(server, {
        context: async () => {
          return {
            dataSources: {
              minsei: new MinseiAPI(minseiCredentialsProvider, {
                cache: server.cache,
                fetch: fetcher,
              }),
              joysound: new JoysoundAPI(joysoundCredentialsProvider, {
                cache: server.cache,
                fetch: fetcher,
              }),
              dkwebsys: new DkwebsysAPI({
                cache: server.cache,
                fetch: fetcher,
              }),
              youtube: innertubeApiProvider,
            },
          };
        },
      }),
    );
    httpServer.listen(karafriendsConfig.remoconPort, () => {
      console.log(
        `Server is now running on http://localhost:${karafriendsConfig.remoconPort}`,
      );
    });

    // Warm the Top 100 charts in the background so they're ready (and, after
    // the first run, persisted) before anyone opens the ranking pages. Prime
    // DAM's canonical readings for each resolved chart's rows too, so the
    // romaji is cached before anyone opens a page rather than on first visit.
    const rankingDkwebsys = new DkwebsysAPI({
      cache: server.cache,
      fetch: fetcher,
    });
    primeRankings(
      new JoysoundAPI(joysoundCredentialsProvider, {
        cache: server.cache,
        fetch: fetcher,
      }),
      (entries) => primeRankingReadings(entries, rankingDkwebsys),
      (entries) => primeRankingArtistReadings(entries, rankingDkwebsys),
    );
  });
}
