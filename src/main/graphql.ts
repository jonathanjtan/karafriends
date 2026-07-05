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
import {
  CaptionTrackData,
  Innertube,
  VideoInfo as YTVideoInfo,
} from "youtubei.js";

// tslint:disable-next-line:no-submodule-imports no-implicit-dependencies
import rawSchema from "inline-string:../common/schema.graphql";
import karafriendsConfig, { KarafriendsConfig } from "../common/config";
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

import { memoize } from "lodash";
import "regenerator-runtime/runtime"; // tslint:disable-line:no-submodule-imports
import { isRomaji, toKana } from "wanakana";

export interface IDataSources {
  dataSources: {
    minsei: MinseiAPI;
    joysound: JoysoundAPI;
    dkwebsys: DkwebsysAPI;
    youtube: Innertube;
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

async function toYomi(text: string): Promise<string> {
  await kuroshiroReady;
  return kuroshiro.convert(text, { to: "hiragana", mode: "normal" });
}

// DAM and Joysound's search backends only match Japanese-script keywords;
// a pure-romaji query like "aidoru" returns zero results even though the
// target title is stored as "アイドル". But not every romaji-looking query
// is romanized Japanese — both catalogs also carry western songs/artists
// under their literal English names (e.g. "Queen"), which must keep
// matching. So we always search the literal keyword first (unchanged
// behavior), and only retry with a kana transliteration if that literal
// search comes back empty. Only attempted on the first page of a search;
// later pages of a real (non-empty) result set are left alone.
async function searchWithRomajiFallback<T>(
  keyword: string,
  isFirstPage: boolean,
  isEmpty: (result: T) => boolean,
  search: (keyword: string) => Promise<T>,
): Promise<T> {
  const result = await search(keyword);
  if (!isFirstPage || !keyword || !isRomaji(keyword) || !isEmpty(result)) {
    return result;
  }
  // IMEMode mirrors how a real Japanese IME converts as you type — most
  // relevant here for a dangling trailing "n" (e.g. "shinjuku" mid-typing),
  // which it resolves to "ん" immediately instead of waiting to see if a
  // vowel follows.
  const kana = toKana(keyword, { IMEMode: true });
  return kana && kana !== keyword ? search(kana) : result;
}

const nameYomiResolvers = {
  nameYomi(parent: { name: string }) {
    return toYomi(parent.name);
  },
  artistNameYomi(parent: { artistName: string }) {
    return toYomi(parent.artistName);
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
}

interface YoutubeVideoInfoError {
  readonly __typename: "YoutubeVideoInfoError";
  readonly reason: string;
}

type YoutubeVideoInfoResult = YoutubeVideoInfo | YoutubeVideoInfoError;

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
}

interface QueueItemInterface {
  readonly songId: string;
  readonly name: string;
  readonly artistName: string;
  readonly playtime?: number | null;
  readonly timestamp: string;
  readonly userIdentity: UserIdentity;
}

export interface JoysoundQueueItem extends QueueItemInterface {
  readonly __typename: "JoysoundQueueItem";
  readonly isRomaji: boolean;
  readonly youtubeVideoId: string | null;
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
  currentSong: QueueItem | null;
  currentSongAdhocLyrics: AdhocLyricsEntry[];
  idToAdhocLyrics: Record<string, string[]>;
  pitchShiftSemis: number;
  playbackState: PlaybackState;
  songQueue: QueueItem[];
  downloadQueue: DownloadQueueItem[];
  songHistory: SongHistoryItem[];
  lastKnownGoodDamSongId: string | null;
};

enum SubscriptionEvent {
  CurrentSongAdhocLyricsChanged = "CurrentSongAdhocLyricsChanged",
  CurrentSongChanged = "CurrentSongChanged",
  Emote = "Emote",
  PitchShiftSemisChanged = "PitchShiftSemisChanged",
  PlaybackStateChanged = "PlaybackStateChanged",
  QueueAdded = "QueueAdded",
  QueueChanged = "QueueChanged",
}

// TODO: make this gql context instead of global
let db: NotARealDb = {
  currentSong: null,
  currentSongAdhocLyrics: [],
  idToAdhocLyrics: {},
  pitchShiftSemis: 0,
  playbackState: PlaybackState.WAITING,
  songQueue: [],
  downloadQueue: [],
  songHistory: [],
  lastKnownGoodDamSongId: null,
};

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
      songQueue: [db.currentSong, ...db.songQueue],
      downloadQueue: [],
    }),
    "utf-8",
  );
}

function loadDb(): NotARealDb {
  return {
    currentSong: null,
    currentSongAdhocLyrics: [],
    idToAdhocLyrics: {},
    pitchShiftSemis: 0,
    playbackState: PlaybackState.WAITING,
    songQueue: [],
    downloadQueue: [],
    songHistory: [],
    lastKnownGoodDamSongId: null,
    ...(fs.existsSync(DB_PATH) &&
      JSON.parse(fs.readFileSync(DB_PATH, "utf-8"))),
  };
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

function hasMaxSongsInQueue(userIdentity: UserIdentity): boolean {
  // Not very efficient, but surely the queue won't ever get so big that this would be considered expensive
  const songsQueuedByUser: number = db.songQueue.filter(
    (x) => x.userIdentity.deviceId === userIdentity.deviceId,
  ).length;

  const songsDownloadingByUser: number = db.downloadQueue.filter(
    (x) => x.userIdentity.deviceId === userIdentity.deviceId,
  ).length;

  console.log(
    `hasMaxSongsInQueue: user ${userIdentity.nickname} has ${songsQueuedByUser}, ${songsDownloadingByUser} downloading`,
  );
  console.log(
    `adminNicks=${karafriendsConfig.adminNicks}, adminDeviceIds=${karafriendsConfig.adminDeviceIds}`,
  );

  return (
    !karafriendsConfig.adminNicks.includes(userIdentity.nickname) &&
    !karafriendsConfig.adminDeviceIds.includes(userIdentity.deviceId) &&
    karafriendsConfig.paxSongQueueLimit > 0 &&
    songsQueuedByUser + songsDownloadingByUser >=
      karafriendsConfig.paxSongQueueLimit
  );
}

function canPushToHeadOfQueue(userIdentity: UserIdentity): boolean {
  return (
    karafriendsConfig.adminNicks.includes(userIdentity.nickname) ||
    karafriendsConfig.adminDeviceIds.includes(userIdentity.deviceId)
  );
}

function pushSongToQueue(
  queueItem: QueueItem,
  pushToHead: boolean = false,
): QueueSongResult {
  const eta =
    (db.currentSong?.playtime || 0) +
    db.songQueue.reduce((acc, cur) => acc + (cur.playtime || 0), 0);

  console.log(
    `pushSongToQueue: pushing ${JSON.stringify(
      queueItem,
    )} with an eta of ${eta}; pushToHead=${pushToHead}`,
  );

  if (pushToHead === true) {
    // To give things time to download, we don't actually push to the front, but the second.
    // Due to :js:, this is OK regardless of the size of db.songQueue
    db.songQueue.splice(1, 0, queueItem);
  } else {
    db.songQueue.push(queueItem);
  }

  pubsub.publish(SubscriptionEvent.QueueChanged, {
    queueChanged: {
      currentSong: db.currentSong,
      newQueue: db.songQueue,
    },
  });

  pubsub.publish(SubscriptionEvent.QueueAdded, {
    queueAdded: queueItem,
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
    ...nameYomiResolvers,
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
        .getMusicStreamingUrls(parent.songId)
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
        .getScoringData(parent.songId)
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
      const afterInt = args.after ? parseInt(args.after, 10) : 1;

      return searchWithRomajiFallback(
        args.keyword,
        afterInt === 1,
        (result) => result.length === 0,
        (keyword) =>
          dataSources.joysound.getSongListByKeyword(
            keyword,
            afterInt,
            firstInt,
          ),
      ).then((result) => ({
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
    joysoundArtistsByKeyword: (
      _: any,
      args: { keyword: string; first: number | null; after: string | null },
      { dataSources }: IDataSources,
    ): Promise<Connection<JoysoundArtistParent, string>> => {
      const firstInt = args.first || 100;
      const afterInt = args.after ? parseInt(args.after, 10) : 1;

      return searchWithRomajiFallback(
        args.keyword,
        afterInt === 1,
        (result) => result.length === 0,
        (keyword) =>
          dataSources.joysound.getArtistListByKeyword(
            keyword,
            afterInt,
            firstInt,
          ),
      ).then((result) => ({
        edges: result.map((artist, i) => ({
          node: {
            id: artist.artistId_digi,
            name: artist.artistName,
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
    songsByName: (
      _: any,
      args: { name: string; first: number | null; after: string | null },
      { dataSources }: IDataSources,
    ): Promise<Connection<SongParent, string>> => {
      const firstInt = args.first || 0;
      const afterInt = args.after ? parseInt(args.after, 10) : 0;

      return searchWithRomajiFallback(
        args.name,
        afterInt === 0,
        (result) => result.list.length === 0,
        (keyword) =>
          dataSources.dkwebsys.getMusicByKeyword(keyword, firstInt, afterInt),
      ).then((result) => ({
        edges: result.list.map((song, i) => ({
          node: {
            id: song.requestNo,
            name: song.title,
            nameYomi: song.titleYomi,
            artistName: song.artist,
            artistNameYomi: song.artistYomi,
          },
          cursor: (firstInt + i).toString(),
        })),
        pageInfo: {
          hasPreviousPage: false, // We can always do this because we don't support backward pagination
          hasNextPage: firstInt + afterInt < result.data.totalCount,
          startCursor: "0",
          endCursor: (firstInt + afterInt).toString(),
        },
      }));
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
      const afterInt = args.after ? parseInt(args.after, 10) : 0;

      return searchWithRomajiFallback(
        args.name,
        afterInt === 0,
        (result) => result.list.length === 0,
        (keyword) =>
          dataSources.dkwebsys.getArtistByKeyword(keyword, firstInt, afterInt),
      ).then((result) => ({
        edges: result.list.map((artist, i) => ({
          node: {
            id: artist.artistCode.toString(),
            name: artist.artist,
            nameYomi: artist.artistYomi,
            songCount: artist.holdMusicCount,
          },
          cursor: (firstInt + i).toString(),
        })),
        pageInfo: {
          hasPreviousPage: false, // We can always do this because we don't support backward pagination
          hasNextPage: firstInt + afterInt < result.data.totalCount,
          startCursor: "0",
          endCursor: (firstInt + afterInt).toString(),
        },
      }));
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
    songHistory: (
      _: any,
      args: { first: number | null; after: string | null },
    ): Connection<SongHistoryItem, string> => {
      const firstInt = args.first || 0;
      const afterInt = args.after ? parseInt(args.after, 10) : 0;

      return {
        edges: db.songHistory
          .slice(afterInt, firstInt)
          .map((songHistoryItem, i) => ({
            node: songHistoryItem,
            cursor: (firstInt + i).toString(),
          })),
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: firstInt + afterInt < db.songHistory.length,
          startCursor: "0",
          endCursor: (firstInt + afterInt).toString(),
        },
      };
    },
    youtubeVideoInfo: (
      _: any,
      args: { videoId: string },
      { dataSources }: IDataSources,
    ): Promise<YoutubeVideoInfoResult> => {
      return dataSources.youtube
        .getBasicInfo(args.videoId)
        .then((data: YTVideoInfo) => {
          if (data.playability_status.status !== "OK") {
            return {
              __typename: "YoutubeVideoInfoError",
              reason: data.playability_status.reason,
            };
          }

          const captionTracks: CaptionTrackData[] =
            data.captions?.caption_tracks || [];
          const captionLanguages: CaptionLanguage[] = captionTracks
            .filter(
              (captionTrack: CaptionTrackData) =>
                !captionTrack.vss_id.startsWith("a"),
            )
            .map((captionTrack: CaptionTrackData) => ({
              code: captionTrack.language_code,
              name: captionTrack.name.text,
            }));

          const loudnessDb =
            data.player_config?.audio_config?.loudness_db || 0.0;

          return {
            __typename: "YoutubeVideoInfo",
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
    pitchShiftSemis: () => db.pitchShiftSemis,
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
          const url = karafriendsConfig.useLowBitrateUrl
            ? selectedIndex.lowBitrateUrl
            : selectedIndex.highBitrateUrl;
          downloadDamVideo(url, queueItem.songId, queueItem.streamingUrlIdx);
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

      if (db.currentSong) {
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
      return triggerHealthCheck();
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

export const minseiCredentialsProvider = memoize(async () => {
  const { damUsername, damPassword } = karafriendsConfig;
  const minseiLoginResult = await MinseiAPI.login(damUsername, damPassword);
  return {
    userCode: damUsername,
    authToken: minseiLoginResult.data.authToken,
  };
});

export const joysoundCredentialsProvider = memoize(async () => {
  const joysoundEmail = encodeURIComponent(karafriendsConfig.joysoundEmail);
  const joysoundPassword = encodeURIComponent(
    karafriendsConfig.joysoundPassword,
  );
  return JoysoundAPI.login(joysoundEmail, joysoundPassword);
});

const innertubeApiProvider = memoize(async () => {
  return Innertube.create();
});

// Known-good DAM song, per DAM-DEBUG-HANDOFF.md, used as a health check
// canary when there's no last-known-good id persisted yet.
const DAM_HEALTH_CHECK_CANARY_SONG_ID = "3246-51"; // Lemon / 米津玄師

async function checkDamStreamingUrl(
  minsei: MinseiAPI,
  fetcher: Fetcher,
  songId: string,
): Promise<boolean> {
  const streamingUrls = await minsei.getMusicStreamingUrls(songId);
  const url = karafriendsConfig.useLowBitrateUrl
    ? streamingUrls.list[0].lowBitrateUrl
    : streamingUrls.list[0].highBitrateUrl;
  const response = await fetcher(url, { method: "GET" });
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
    checkDamHealth(minsei, dkwebsys, fetcher),
    checkJoysoundHealth(joysound),
  ]);

  console.log(
    `[healthcheck] DAM available=${damAvailable}, Joysound available=${joysoundAvailable}`,
  );

  return { damAvailable, joysoundAvailable };
}

// Dedupes overlapping triggers (periodic timer, per-song, and a manual
// "check now" click could otherwise all fire a real network check at once).
function triggerHealthCheck(): Promise<ServiceHealthState> {
  if (healthCheckInFlight) return healthCheckInFlight;

  if (!runHealthCheckOnce) {
    return Promise.resolve(
      currentServiceHealth ?? {
        damAvailable: true,
        joysoundAvailable: true,
        checkedAt: "0",
      },
    );
  }

  healthCheckInFlight = runHealthCheckOnce().then((result) => {
    currentServiceHealth = { ...result, checkedAt: Date.now().toString() };
    healthCheckInFlight = null;
    return currentServiceHealth;
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
          const innertubeApiInstance = await innertubeApiProvider();

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
              youtube: innertubeApiInstance,
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
  });
}
