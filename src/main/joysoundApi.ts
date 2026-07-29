import { DataSourceConfig, RESTDataSource } from "@apollo/datasource-rest";
import type { KeyValueCache } from "@apollo/utils.keyvaluecache";
import nodeFetch from "node-fetch";
import promiseRetry from "promise-retry";
import invariant from "ts-invariant";

import proxyAgent from "./proxyAgent";

const COOKIE_IDS: string[] = ["AWSALB", "AWSALBCORS", "JSESSIONID"];

export type JoysoundCredentialsProvider = () => Promise<{
  cookies: JoysoundCookies;
  csrfToken: string;
}>;

interface JoysoundCookies {
  AWSALB: string;
  AWSALBCORS: string;
  JSESSIONID: string;
}

interface JoysoundArtistListItem {
  selSongNo: null;
  songName: null;
  artistName: string;
  serviceTypeList: null;
  artistId_digi: string;
}

interface JoysoundMovieList {
  slc: string;
  movie: JoysoundMovieUrlList;
}

interface JoysoundMovieUrlList {
  [index: string]: string;
}

interface JoysoundSongDetail {
  name: string;
  artistName: string;
  lyricsPreview: string;
  tieUp: string;
}

interface JoysoundSongListItem {
  selSongNo: string;
  songName: string;
  artistName: string;
  serviceTypeList: ServiceTypeData[];
  artistId_digi: string;
}

export interface JoysoundSongRawData {
  slc: string;
  telop: string;
  ogg: string;
  streaming_wifi_url: string;
}

interface ServiceTypeData {
  serviceType: string;
}

function generateCookieString(cookies: JoysoundCookies) {
  return COOKIE_IDS.map(
    (cookieId) => cookieId + "=" + cookies[cookieId as keyof JoysoundCookies],
  ).join("; ");
}

function parseCookies(setCookie: string, target: JoysoundCookies) {
  for (const cookieId of COOKIE_IDS) {
    const re = new RegExp(cookieId + "=([^;]+);");

    const matchData = setCookie.match(re);
    invariant(matchData);

    target[cookieId as keyof JoysoundCookies] = matchData[1];
  }
}

// Song detail is static catalog data, and the remocon re-requests it on every
// song-page visit (plus suggestedYoutubeVideos fetches it again right after).
// JoysoundAPI instances are per-GraphQL-request, so memoize across instances
// at module level; failures are evicted so an error doesn't stick.
const songDetailCache: Map<string, Promise<JoysoundSongDetail>> = new Map();

function unescapeJoysoundString(str: string) {
  const htmlEntities = {
    nbsp: " ",
    cent: "¢",
    pound: "£",
    yen: "¥",
    euro: "€",
    copy: "©",
    reg: "®",
    lt: "<",
    gt: ">",
    quot: '"',
    amp: "&",
    apos: "'",
  };

  return str.replace(/\&([^;]+);/g, (entity: string, entityCode: string) => {
    let match;

    if (htmlEntities[entityCode as keyof typeof htmlEntities] !== undefined) {
      return htmlEntities[entityCode as keyof typeof htmlEntities];
    }

    match = entityCode.match(/^#x([\da-fA-F]+)$/);

    if (match) {
      return String.fromCharCode(parseInt(match[1], 16));
    }

    match = entityCode.match(/^#(\d+)$/);

    if (match) {
      return String.fromCharCode(parseInt(match[1], 10));
    }

    return entity;
  });
}

export class JoysoundAPI extends RESTDataSource {
  override baseURL = "https://www.sound-cafe.jp";
  credsProvider: JoysoundCredentialsProvider;

  constructor(
    credsProvider: JoysoundCredentialsProvider,
    options: DataSourceConfig,
  ) {
    super(options);
    this.credsProvider = credsProvider;
  }

  async post<T>(url: string, data: object): Promise<T> {
    // Values must be percent-encoded: raw UTF-8 Japanese happens to survive
    // an x-www-form-urlencoded body, but a literal % (e.g. searching
    // 勇気100%), & or = corrupts it — sound-cafe answers 400.
    const body = Object.entries(data)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");

    const creds = await this.credsProvider();

    console.debug(
      `[joysound] curl ${
        this.baseURL
      }${url} -d "${body}" -H "Content-Type: application/x-www-form-urlencoded; charset=UTF-8" -H "Cookie: ${generateCookieString(
        creds.cookies,
      )}" -H "X-CSRF-TOKEN: ${creds.csrfToken}"`,
    );

    return super.post(url, {
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Cookie: generateCookieString(creds.cookies),
        Referer: "https://www.sound-cafe.jp/player",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/112.0",
        "X-CSRF-TOKEN": creds.csrfToken,
      },
    });
  }

  getArtistListByKeyword(keyword: string, start: number, count: number) {
    return this.post<JoysoundArtistListItem[]>("/search/artist/list", {
      keyword,
      match: "partial",
      sort: "name",
      order: "asc",
      start: start.toString(),
      count: count.toString(),
    });
  }

  async getMovieUrls(id: string) {
    return promiseRetry((retryFn, retryCount: number) => {
      console.log(`contentsInfo for songId: ${id}, retry no. ${retryCount}`);

      return this.post<JoysoundMovieList>("/player/contentsInfo", {
        songNumber: id,
        serviceType: "003000761",
      }).catch(retryFn);
    });
  }

  getSongDetail(id: string): Promise<JoysoundSongDetail> {
    const cached = songDetailCache.get(id);
    if (cached) return cached;

    const promise = this.fetchSongDetail(id).catch((error) => {
      songDetailCache.delete(id);
      throw error;
    });
    songDetailCache.set(id, promise);

    return promise;
  }

  private async fetchSongDetail(id: string) {
    const creds = await this.credsProvider();

    const data = await this.get(`songdetail/${id}`, {
      headers: { Cookie: generateCookieString(creds.cookies) },
    });

    const re = new RegExp(
      /<div class="flex items-center w-full border-b border-gray">([^<>]*)/,
      "g",
    );

    const results: string[] = [];

    for (const matchData of data.matchAll(re)) {
      results.push(matchData[1]);
    }

    const name = results[0];
    invariant(name);

    const artistName = results[1];
    invariant(artistName);

    const tieUp = results[2];
    invariant(tieUp !== undefined);

    const lyricsPreview = data.match(
      /<div class="flex items-center w-full border-b select-none border-gray">([^<>]*)/,
    )[1];
    invariant(lyricsPreview !== undefined);

    const payload: JoysoundSongDetail = {
      name: unescapeJoysoundString(name),
      artistName: unescapeJoysoundString(artistName),
      lyricsPreview: unescapeJoysoundString(lyricsPreview),
      tieUp: unescapeJoysoundString(tieUp),
    };

    return payload;
  }

  getSongListByArtist(artistId: string, start: number, count: number) {
    return this.post<JoysoundSongListItem[]>("/search/artist/song/list", {
      artistId,
      sort: "popular",
      order: "asc",
      start: start.toString(),
      count: count.toString(),
    });
  }

  getSongListByKeyword(keyword: string, start: number, count: number) {
    return this.post<JoysoundSongListItem[]>("/search/song/list", {
      keyword,
      match: "partial",
      sort: "popular",
      order: "asc",
      start: start.toString(),
      count: count.toString(),
    });
  }

  async getSongRawData(id: string) {
    return promiseRetry((retryFn, retryCount: number) => {
      console.log(`getFME for songId: ${id}, retry no. ${retryCount}`);

      return this.post<JoysoundSongRawData>("/player/getFME", {
        songNumber: id,
        serviceType: "003000761",
      }).catch(retryFn);
    });
  }

  static async login(email: string, password: string) {
    const loginCookies: JoysoundCookies = {
      AWSALB: "",
      AWSALBCORS: "",
      JSESSIONID: "",
    };

    const csrfToken = await nodeFetch("https://www.sound-cafe.jp/login", {
      agent: proxyAgent,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/112.0",
      },
    })
      .then((resp) => {
        const setCookie = resp.headers.get("set-cookie");
        invariant(setCookie);

        parseCookies(setCookie, loginCookies);

        return resp.text();
      })
      .then((respBody) => {
        const matchData = respBody.match(
          /<meta name="_csrf" content="([^"]+)" \/>/,
        );
        invariant(matchData);

        return matchData[1];
      });

    return nodeFetch("https://www.sound-cafe.jp/login/check", {
      agent: proxyAgent,
      method: "POST",
      body: `mailAddress=${email}&password=${password}`,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Cookie: generateCookieString(loginCookies),
        Origin: "https://www.sound-cafe.jp",
        Referer: "https:/www.sound-cafe.jp/login",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/112.0",
        "X-CSRF-TOKEN": csrfToken,
        "X-Requested-With": "XMLHttpRequest",
      },
    })
      .then((resp) => {
        const setCookie = resp.headers.get("set-cookie");
        invariant(setCookie);

        parseCookies(setCookie, loginCookies);

        return nodeFetch("https://www.sound-cafe.jp/login", {
          agent: proxyAgent,
          method: "POST",
          body: `_csrf=${csrfToken}&mailAddress=${email}&password=${password}`,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: generateCookieString(loginCookies),
            Origin: "https://www.sound-cafe.jp",
            Referer: "https:/www.sound-cafe.jp/login",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/112.0",
          },
          redirect: "manual",
        });
      })
      .then((resp) => {
        const setCookie = resp.headers.get("set-cookie");
        invariant(setCookie);

        parseCookies(setCookie, loginCookies);

        return nodeFetch("https://www.sound-cafe.jp", {
          agent: proxyAgent,
          headers: {
            Cookie: generateCookieString(loginCookies),
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/112.0",
          },
        });
      })
      .then((resp) => {
        const setCookie = resp.headers.get("set-cookie");
        invariant(setCookie);

        parseCookies(setCookie, loginCookies);

        return resp.text();
      })
      .then((respBody) => {
        const matchData = respBody.match(
          /<meta name="_csrf" content="([^"]+)" \/>/,
        );
        invariant(matchData);

        return {
          cookies: loginCookies,
          csrfToken: matchData[1],
        };
      });
  }
}
