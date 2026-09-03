import type { Innertube } from "youtubei.js";

// Karaoke channels whose uploads follow a fixed title grammar, searched as if
// they were catalogs.
//
// The point of naming channels rather than searching YouTube at large: these
// publish nothing *but* karaoke renders, and each one titles every video the
// same way, so a title can be parsed back into a real (song, artist) pair
// instead of being dumped into the queue as a raw video title. That is the
// whole difference between "Neon Trees - Everybody Talks (Karaoke Version)"
// sitting in the song history and "Everybody Talks" by "Neon Trees".
//
// Several of them publish the same master twice, once with the guide-melody
// synth in the mix and once without (JP: ガイドなし / No Guide Melody;
// KR: 멜로디제거). For singing along, the no-guide render is the one you
// want, since a loud synth doubling the vocal line fights the singer, so
// `rank` prefers it and the standard render is the fallback. Every variant is
// labelled on the row rather than hidden, because "why is this the quiet one"
// is a worse mystery than an extra word in the list.

// Lower rank wins when the same song shows up as several renders on one
// channel. 0 is "the render you actually want to sing to".
const RANK_PREFERRED = 0;
const RANK_STANDARD = 1;
const RANK_ALTERNATE = 2;
const RANK_NOVELTY = 3;

export interface ParsedKaraokeTitle {
  readonly name: string;
  readonly artistName: string;
  // Short tag shown on the row ("no guide", "female key"). Null for a
  // channel's plain, unmarked render, where there is nothing to say about it.
  readonly variant: string | null;
  // The channel's own catalog number where it publishes one in the title
  // (KY.NNNNN). Display only; nothing keys off it.
  readonly catalogId: string | null;
  readonly rank: number;
}

export interface KaraokeChannelDef {
  readonly key: string;
  readonly label: string;
  readonly language: string;
  readonly channelId: string;
  // Returns null for a video that isn't a parseable karaoke render on this
  // channel: trailers, sheet-music videos, channel announcements. Those are
  // dropped rather than guessed at.
  readonly parse: (title: string) => ParsedKaraokeTitle | null;
}

function tidy(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Sing King: "Artist - Song (Karaoke Version)". The paren group is anchored to
// the end so a song whose own name carries brackets ("Song (feat. X)") keeps
// them instead of having the lazy match stop early.
const SING_KING_RE = /^(.+?)\s+-\s+(.+?)\s*\(([^()]*)\)\s*$/;

function parseSingKing(title: string): ParsedKaraokeTitle | null {
  const match = title.match(SING_KING_RE);
  if (!match) return null;

  const [, artistName, name, tag] = match;
  if (!/karaoke|backing track/i.test(tag)) return null;

  let variant: string | null = null;
  let rank = RANK_NOVELTY;
  if (/karaoke version/i.test(tag)) {
    rank = RANK_PREFERRED;
  } else if (/backing track/i.test(tag)) {
    variant = "backing track";
    rank = RANK_ALTERNATE;
  } else if (/piano/i.test(tag)) {
    variant = "piano";
  } else if (/acoustic/i.test(tag)) {
    variant = "acoustic";
  } else {
    variant = tidy(tag).toLowerCase();
  }

  return {
    name: tidy(name),
    artistName: tidy(artistName),
    variant,
    catalogId: null,
    rank,
  };
}

// カラオケ歌っちゃ王's romaji sibling: "Song – Artist (Romaji Karaoke no
// guide)". The separator is an en dash, not a hyphen.
const UTACCHAO_ROMAJI_RE =
  /^(.+?)\s+[–—-]\s+(.+?)\s*\(Romaji Karaoke\s+(with guide|no guide)\)\s*$/i;

function parseUtacchaoRomaji(title: string): ParsedKaraokeTitle | null {
  const match = title.match(UTACCHAO_ROMAJI_RE);
  if (!match) return null;

  const [, name, artistName, guide] = match;
  const noGuide = /no guide/i.test(guide);

  return {
    name: tidy(name),
    artistName: tidy(artistName),
    variant: noGuide ? "no guide" : "guide melody",
    catalogId: null,
    rank: noGuide ? RANK_PREFERRED : RANK_STANDARD,
  };
}

// カラオケ歌っちゃ王 proper: "【カラオケ】Song / Artist" with the guide, and
// "【ガイドなし】Song/Artist【カラオケ】" without it. Some uploads append a
// tie-up after a pipe ("... | 葬送のフリーレンOP"), and the binaural
// 【立体音響カラオケ】 re-renders are a different mix entirely, not a
// karaoke take anyone queues on purpose, so they're dropped.
const UTACCHAOH_RE = /^【([^】]+)】\s*(.+?)\s*(?:【[^】]*】\s*)?$/;

function parseUtacchaoh(title: string): ParsedKaraokeTitle | null {
  const match = title.match(UTACCHAOH_RE);
  if (!match) return null;

  const [, tag, rest] = match;
  if (/立体音響|生音|アニメ映像/.test(tag)) return null;

  const noGuide = /ガイドなし/.test(tag);
  if (!noGuide && !/カラオケ/.test(tag)) return null;

  const body = rest.split("|")[0];
  // Song names contain slashes far more often than artist names do, so split
  // on the last one.
  const slash = body.lastIndexOf("/");
  if (slash === -1) return null;

  return {
    name: tidy(body.slice(0, slash)),
    artistName: tidy(body.slice(slash + 1)),
    variant: noGuide ? "no guide" : "guide melody",
    catalogId: null,
    rank: noGuide ? RANK_PREFERRED : RANK_STANDARD,
  };
}

// EdKara: "練習用カラオケ♬ Song - Artist 【ガイドメロディ付】…" and
// "Karaoke♬ Song - Artist 【No Guide Melody】…" (the no-guide half is titled
// in romaji, the with-guide half in Japanese, which is why the two are hard
// to pair by title, and why edkara.jp's own song pages are the reliable way
// to find both). A leading 【原曲キー±8】 marks the hour-long every-key
// compilation; the duration filter would catch it anyway, but naming it here
// keeps the reason visible.
const EDKARA_RE =
  /^(?:練習用カラオケ|カラオケ|Karaoke)♬\s*(【[^】]*】)?\s*(.+?)\s+-\s+(.+?)\s*【([^】]+)】/;

function parseEdkara(title: string): ParsedKaraokeTitle | null {
  const match = title.match(EDKARA_RE);
  if (!match) return null;

  const [, keyTag, name, artistName, guideTag] = match;
  if (keyTag) return null;

  const noGuide = /No Guide Melody|ガイドメロディなし/i.test(guideTag);
  const withGuide = /ガイドメロディ付/.test(guideTag);
  if (!noGuide && !withGuide) return null;

  return {
    name: tidy(name),
    artistName: tidy(artistName),
    variant: noGuide ? "no guide" : "guide melody",
    catalogId: null,
    rank: noGuide ? RANK_PREFERRED : RANK_STANDARD,
  };
}

// TJ: "[TJ노래방] Song - Artist / TJ Karaoke", with an optional key shift in
// the bracket ("[TJ노래방 / 1키내림]"). TJ's 곡번호 lives in the description
// rather than the title, and fetching a description per row would cost one
// extra request per result, so these rows carry no catalog id.
const TJ_RE =
  /^\[TJ노래방\s*(?:\/\s*([^\]]+?))?\]\s*(.+?)\s+-\s+(.+?)\s*\/\s*TJ\s*Karaoke/i;

function parseTj(title: string): ParsedKaraokeTitle | null {
  const match = title.match(TJ_RE);
  if (!match) return null;

  const [, keyTag, name, artistName] = match;

  return {
    name: tidy(name),
    artistName: tidy(artistName),
    variant: keyTag ? tidy(keyTag) : null,
    catalogId: null,
    rank: keyTag ? RANK_ALTERNATE : RANK_PREFERRED,
  };
}

// KY: "Song - Artist (KY.71735) / KY Karaoke", optionally tagged. Unlike TJ,
// the catalog number is right there in the title. KY's plain render carries
// the guide melody, so [멜로디제거] is the one to prefer here.
const KY_RE = /^(?:\[([^\]]+)\]\s*)?(.+?)\s+-\s+(.+?)\s*\(KY\.(\d+)\)/;

function parseKy(title: string): ParsedKaraokeTitle | null {
  const match = title.match(KY_RE);
  if (!match) return null;

  const [, tag, name, artistName, catalogId] = match;

  let variant: string | null = null;
  let rank = RANK_STANDARD;
  if (tag && /멜로디제거/.test(tag)) {
    variant = "melody removed";
    rank = RANK_PREFERRED;
  } else if (tag && /악보영상/.test(tag)) {
    // A scrolling sheet-music video, not a backing track.
    return null;
  } else if (tag && /코러스/.test(tag)) {
    variant = "chorus";
    rank = RANK_ALTERNATE;
  } else if (tag && /남자키/.test(tag)) {
    variant = "male key";
    rank = RANK_NOVELTY;
  } else if (tag && /여자키/.test(tag)) {
    variant = "female key";
    rank = RANK_NOVELTY;
  }

  return {
    name: tidy(name),
    artistName: tidy(artistName),
    variant,
    catalogId,
    rank,
  };
}

// CC Karaoke: "Artist • Song (CC Karaoke / Instrumental)", with a bullet and
// artist first. Anything after the (CC…) group is decoration ([UVR], emoji).
const CC_RE = /^(.+?)\s*•\s*(.+?)\s*\(CC\b[^)]*\)/;

function parseCcKaraoke(title: string): ParsedKaraokeTitle | null {
  const match = title.match(CC_RE);
  if (!match) return null;

  const [, artistName, name] = match;

  return {
    name: tidy(name),
    artistName: tidy(artistName),
    variant: null,
    catalogId: null,
    rank: RANK_PREFERRED,
  };
}

// Funbox: "Artist - Song (Funbox Karaoke, 2006)". The year is the original
// song's, not the upload's, and isn't worth surfacing.
const FUNBOX_RE = /^(.+?)\s+-\s+(.+?)\s*\(Funbox Karaoke,?\s*\d*\)/i;

function parseFunbox(title: string): ParsedKaraokeTitle | null {
  const match = title.match(FUNBOX_RE);
  if (!match) return null;

  const [, artistName, name] = match;

  return {
    name: tidy(name),
    artistName: tidy(artistName),
    variant: null,
    catalogId: null,
    rank: RANK_PREFERRED,
  };
}

// Lemmy Caution: "Artist -  Song (karaoke)", often with a doubled space.
const LEMMY_RE = /^(.+?)\s+-\s+(.+?)\s*\(karaoke\)\s*$/i;

function parseLemmyCaution(title: string): ParsedKaraokeTitle | null {
  const match = title.match(LEMMY_RE);
  if (!match) return null;

  const [, artistName, name] = match;

  return {
    name: tidy(name),
    artistName: tidy(artistName),
    variant: null,
    catalogId: null,
    rank: RANK_PREFERRED,
  };
}

// KaraFun: "Song - Artist | Karaoke Version | KaraFun". Song first, and the
// two-pipe suffix is invariant across the whole catalog, so the separator is
// unambiguous even when the artist itself contains " - ". A song's own
// qualifier stays in the name ("Bohemian Rhapsody (Live Aid)"), which is the
// point: KaraFun publishes several distinct arrangements of a standard and
// the qualifier is the only thing telling them apart.
const KARAFUN_RE =
  /^(.+?)\s+-\s+(.+?)\s*\|\s*Karaoke Version\s*\|\s*KaraFun\s*$/i;

function parseKarafun(title: string): ParsedKaraokeTitle | null {
  const match = title.match(KARAFUN_RE);
  if (!match) return null;

  const [, name, artistName] = match;

  return {
    name: tidy(name),
    artistName: tidy(artistName),
    variant: null,
    catalogId: null,
    rank: RANK_PREFERRED,
  };
}

// Piano Karaoke: "Song (LOWER -3) - Artist - Piano Karaoke Instrumental",
// sometimes without "Instrumental" and sometimes with a trailing note
// ("(chill out version)"), so the tail after the tag is ignored rather than
// anchored. Unlike every other channel here the variant is non-null even for
// the plain render: on a full-band channel "no tag" means "the ordinary
// backing track", but a piano reduction of a rock song is a different thing
// to sing to and the row has to say so.
const PIANO_KARAOKE_RE =
  /^(.+?)\s*(?:\((LOWER|HIGHER)\s*[+-]?\s*\d+\)\s*)?-\s*(.+?)\s*-\s*Piano\s+Karaoke(?:\s+Instrumental)?\b/i;

function parsePianoKaraoke(title: string): ParsedKaraokeTitle | null {
  const match = title.match(PIANO_KARAOKE_RE);
  if (!match) return null;

  const [, name, keyTag, artistName] = match;

  return {
    name: tidy(name),
    artistName: tidy(artistName),
    variant: keyTag ? `piano, ${keyTag.toLowerCase()} key` : "piano",
    catalogId: null,
    rank: keyTag ? RANK_ALTERNATE : RANK_PREFERRED,
  };
}

// Sing2Piano titles the same render four different ways, and the tag itself
// flips word order between "Piano Karaoke" and "Karaoke Piano", so this one
// is a ladder of forms rather than a single regex. What it refuses to guess
// at is the traditional/carol uploads ("Silent Night (Piano Karaoke)"), which
// carry no artist in the title at all: there is nothing to parse, so they are
// dropped rather than attributed to nobody.
const SING2PIANO_TAG = "(?:Piano Karaoke|Karaoke Piano)(?:\\s+Instrumental)?";
const SING2PIANO_KEY = "\\((Lower|Higher) Key\\)";

// Each form says which capture is the song, the artist, and the key shift, so
// a form that moves the key tag can't silently drop it: Sing2Piano publishes
// as many transposed renders as plain ones, and a lower-key take served as if
// it were the original is the one failure here nobody notices until they are
// already singing.
interface Sing2PianoForm {
  readonly re: RegExp;
  readonly name: number;
  readonly artist: number;
  readonly key: number | null;
}

const SING2PIANO_FORMS: readonly Sing2PianoForm[] = [
  // "Song Karaoke | Artist (Karaoke Piano)"
  {
    re: new RegExp(
      `^(.+?)\\s+Karaoke\\s*\\|\\s*(.+?)\\s*(?:${SING2PIANO_KEY}\\s*)?\\(${SING2PIANO_TAG}\\)\\s*$`,
      "i",
    ),
    name: 1,
    artist: 2,
    key: 3,
  },
  // "Artist - Song (Lower Key) Piano Karaoke", the tag left unparenthesized.
  {
    re: new RegExp(
      `^(.+?)\\s+-\\s+(.+?)\\s*${SING2PIANO_KEY}\\s*${SING2PIANO_TAG}\\s*$`,
      "i",
    ),
    name: 2,
    artist: 1,
    key: 3,
  },
  // "Artist - Song (Piano Karaoke)", with the key shift, where there is one,
  // trailing the tag instead of preceding it.
  {
    re: new RegExp(
      `^(.+?)\\s+-\\s+(.+?)\\s*\\(${SING2PIANO_TAG}\\)\\s*(?:${SING2PIANO_KEY.slice(2, -2)})?\\s*$`,
      "i",
    ),
    name: 2,
    artist: 1,
    key: 3,
  },
  // Artist trailing the tag: "Song (Piano Karaoke Instrumental) Whitney
  // Houston". Last, because its shape is loose enough to swallow the others.
  {
    re: new RegExp(`^(.+?)\\s*\\(${SING2PIANO_TAG}\\)\\s*(.+?)\\s*$`, "i"),
    name: 1,
    artist: 2,
    key: null,
  },
];

// A "Demo" is a sample clip, not a backing track anyone can sing a whole song
// over, and it passes the duration filter, so it has to be named here.
const SING2PIANO_DEMO_RE = /\(\s*(?:Piano Karaoke|Karaoke Piano)\s+Demo\s*\)/i;
// Whichever form matched, a lazy capture can still leave the key tag glued to
// the end of the song name.
const SING2PIANO_TRAILING_KEY_RE = /^(.*?)\s*\((Lower|Higher) Key\)\s*$/i;

function parseSing2Piano(title: string): ParsedKaraokeTitle | null {
  if (SING2PIANO_DEMO_RE.test(title)) return null;

  for (const form of SING2PIANO_FORMS) {
    const match = title.match(form.re);
    if (!match) continue;

    let name = match[form.name];
    let key = form.key === null ? null : match[form.key] || null;

    const trailing = name.match(SING2PIANO_TRAILING_KEY_RE);
    if (trailing) {
      name = trailing[1];
      key = key || trailing[2];
    }

    return {
      name: tidy(name),
      artistName: tidy(match[form.artist]),
      variant: key ? `piano, ${key.toLowerCase()} key` : "piano",
      catalogId: null,
      rank: key ? RANK_ALTERNATE : RANK_PREFERRED,
    };
  }

  // What is left carries no artist in the title at all (the traditional and
  // carol uploads, "Silent Night (Piano Karaoke)"). Dropped rather than
  // attributed to nobody.
  return null;
}

// 廣東 KTV: "Karaoke - Song | Artist 【伴奏/伴唱】". The cleanest grammar of
// the Chinese-language channels by some distance, and the pipe means a song
// or artist containing a hyphen can't split the fields wrongly. Some uploads
// carry a romanized prefix before "Karaoke -" and a hashtag tail after the
// bracket, so neither end is anchored.
const GUANGDONG_KTV_RE =
  /(?:^|\s)Karaoke\s*-\s*(.+?)\s*\|\s*(.+?)\s*(?:【[^】]*】|#|$)/i;

function parseGuangdongKtv(title: string): ParsedKaraokeTitle | null {
  const match = title.match(GUANGDONG_KTV_RE);
  if (!match) return null;

  const artistName = tidy(match[2].replace(/#.*$/, ""));
  if (!artistName) return null;

  return {
    name: tidy(match[1]),
    artistName,
    variant: null,
    catalogId: null,
    rank: RANK_PREFERRED,
  };
}

// Jwee: "Artist 《Song》 Pinyin Karaoke Version Instrumental Music 拼音卡拉OK
// 伴奏 …". The 《》 corner brackets fence the song off unambiguously. Where
// they are missing the two fields are separated by nothing but a space, which
// only works because Chinese artist names carry no internal spaces; an
// underscore-joined duet credit has no boundary to find at all, so it drops.
const JWEE_BRACKETED_RE = /^(.+?)\s*《\s*(.+?)\s*》\s*.*?Pinyin\s+Karaoke/i;
const JWEE_BARE_RE = /^(\S+)\s+(.+?)\s*-?\s*Pinyin\s+Karaoke/i;

function parseJwee(title: string): ParsedKaraokeTitle | null {
  const bracketed = title.match(JWEE_BRACKETED_RE);
  if (bracketed) {
    return {
      name: tidy(bracketed[2]),
      artistName: tidy(bracketed[1]),
      variant: null,
      catalogId: null,
      rank: RANK_PREFERRED,
    };
  }

  if (title.includes("_")) return null;
  const bare = title.match(JWEE_BARE_RE);
  if (!bare) return null;

  return {
    name: tidy(bare[2]),
    artistName: tidy(bare[1]),
    variant: null,
    catalogId: null,
    rank: RANK_PREFERRED,
  };
}

// KTV中文&拼音: "Artist - Song <markers>". This channel publishes each song
// twice and only one of the two is a karaoke track: 原聲 is the original
// master with the vocal still in it, and it is roughly half the catalog. That
// one is dropped outright rather than ranked below the instrumental, because
// a backing track with the singer already on it isn't a worse karaoke render,
// it isn't one at all. The keeper is marked 無人聲 / 消除人聲 / 伴唱 / 伴奏.
const KTV_PINYIN_RE =
  /^(.+?)\s*[-－]\s*(.+?)\s*((?:【|✔|[-—]|無人聲|消除人聲|伴唱|原聲).*)$/;

function parseKtvPinyin(title: string): ParsedKaraokeTitle | null {
  const match = title.match(KTV_PINYIN_RE);
  if (!match) return null;

  const [, artistName, name, markers] = match;
  if (!/KTV/i.test(markers)) return null;
  if (/原聲/.test(markers)) return null;
  if (!/無人聲|消除人聲|伴唱|伴奏/.test(markers)) return null;

  return {
    name: tidy(name),
    artistName: tidy(artistName),
    variant: null,
    catalogId: null,
    rank: RANK_PREFERRED,
  };
}

export const KARAOKE_CHANNELS: readonly KaraokeChannelDef[] = [
  {
    key: "singKing",
    label: "Sing King",
    language: "English",
    channelId: "UCwTRjvjVge51X-ILJ4i22ew",
    parse: parseSingKing,
  },
  {
    // Party Tyme titles every upload "Artist - Song (Karaoke Version)", which
    // is Sing King's grammar exactly, so it reuses the parser rather than
    // carrying a byte-identical copy. If either channel's titling drifts,
    // split them then and not before.
    key: "partyTyme",
    label: "Party Tyme",
    language: "English",
    channelId: "UCWLqO9ztz16a_Ko4YB9PnFQ",
    parse: parseSingKing,
  },
  {
    key: "karafun",
    label: "KaraFun",
    language: "English",
    channelId: "UCbqcG1rdt9LMwOJN4PyGTKg",
    parse: parseKarafun,
  },
  {
    key: "ccKaraoke",
    label: "CC Karaoke",
    language: "English",
    channelId: "UCwXOPyNfdUIhsM4NykfhPFw",
    parse: parseCcKaraoke,
  },
  {
    key: "funbox",
    label: "Funbox",
    language: "English",
    channelId: "UCtPzvwooQ18YZ8Wq8Hka60g",
    parse: parseFunbox,
  },
  {
    key: "lemmyCaution",
    label: "Lemmy Caution",
    language: "English",
    channelId: "UCg0i5aSL_2rhf4iztlLmLUQ",
    parse: parseLemmyCaution,
  },
  {
    key: "pianoKaraoke",
    label: "Piano Karaoke",
    language: "English",
    channelId: "UCxFoINrmEZxOgWMofuWsQcg",
    parse: parsePianoKaraoke,
  },
  {
    key: "sing2piano",
    label: "Sing2Piano",
    language: "English",
    channelId: "UCIk6z4gxI5ADYK7HmNiJvNg",
    parse: parseSing2Piano,
  },
  {
    key: "utacchaoh",
    label: "歌っちゃ王",
    language: "Japanese",
    channelId: "UC1tk9F5-MGXEq4LWnjmrtpA",
    parse: parseUtacchaoh,
  },
  {
    key: "utacchaoRomaji",
    label: "歌っちゃ王 (romaji)",
    language: "Japanese",
    channelId: "UChTtssL_18nTaObYPhH8nAw",
    parse: parseUtacchaoRomaji,
  },
  {
    key: "edkara",
    label: "EdKara",
    language: "Japanese",
    channelId: "UCRrNOLvQ1LztDKbXtxvDAEQ",
    parse: parseEdkara,
  },
  {
    key: "guangdongKtv",
    label: "廣東 KTV",
    language: "Cantonese",
    channelId: "UCRM8u1OeKNcHmKojukYHGdA",
    parse: parseGuangdongKtv,
  },
  {
    key: "jwee",
    label: "Jwee Karaoke",
    language: "Mandarin",
    channelId: "UChEiQszl4J1H4GspBOr7R3A",
    parse: parseJwee,
  },
  {
    key: "ktvPinyin",
    label: "KTV 中文&拼音",
    language: "Mandarin",
    channelId: "UC20CS2LC_JcLr2poleimOSQ",
    parse: parseKtvPinyin,
  },
  {
    key: "tj",
    label: "TJ 노래방",
    language: "Korean",
    channelId: "UCZUhx8ClCv6paFW7qi3qljg",
    parse: parseTj,
  },
  {
    key: "ky",
    label: "KY 금영",
    language: "Korean",
    channelId: "UCDqaUIUSJP5EVMEI178Zfag",
    parse: parseKy,
  },
];

export interface KaraokeChannelSong {
  // Channel-qualified so Relay's store can't merge two channels' rows: a video
  // id is unique, but the id also has to change when the same song is found
  // again from a different channel or the row would normalize onto whichever
  // arrived last. Same reasoning as SearchedSong's source-qualified id.
  readonly id: string;
  readonly videoId: string;
  readonly channelKey: string;
  readonly channelLabel: string;
  readonly name: string;
  readonly artistName: string;
  readonly variant: string | null;
  readonly catalogId: string | null;
  readonly playtime: number | null;
}

export interface KaraokeChannelSearchResult {
  readonly songs: KaraokeChannelSong[];
  readonly unavailableChannels: string[];
}

interface YoutubeChannelVideoItem {
  readonly type?: string;
  readonly id?: string;
  readonly is_live?: boolean;
  readonly title?: { text?: string };
  readonly duration?: { seconds?: number };
}

// Shorts (lyric snippets, announcements) and the hour-long every-key
// compilations are both real uploads on these channels and neither is a song
// you can queue. A TV-size anime opening is ~90s, so the floor has to sit
// under that.
const MIN_PLAYTIME_SEC = 75;
const MAX_PLAYTIME_SEC = 20 * 60;

const MAX_ROWS_PER_CHANNEL = 10;

// getChannel() is a request of its own before the search request, so caching
// the channel object halves the traffic of the fan-out. Cached
// forever (channel ids don't move) but evicted on failure, per the same rule
// as memoizeWithFailureEviction: a channel fetched while the network was down
// must not stay broken for the session.
const channelCache = new Map<
  string,
  Promise<Awaited<ReturnType<Innertube["getChannel"]>>>
>();

function getChannel(
  youtube: Innertube,
  channelId: string,
): Promise<Awaited<ReturnType<Innertube["getChannel"]>>> {
  const cached = channelCache.get(channelId);
  if (cached) return cached;

  const promise = youtube.getChannel(channelId).catch((error) => {
    if (channelCache.get(channelId) === promise) {
      channelCache.delete(channelId);
    }
    throw error;
  });
  channelCache.set(channelId, promise);
  return promise;
}

// The remocon debounces typing, but the fan-out still turns one search into
// one request per channel, and backing up a character re-runs a search we
// just ran. Short TTL because a channel's catalog does change (these upload
// daily). This is about a burst of near-identical searches, not about
// caching a catalog.
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_CACHE_MAX_ENTRIES = 200;

const searchCache = new Map<
  string,
  { readonly at: number; readonly songs: KaraokeChannelSong[] }
>();

function readSearchCache(cacheKey: string): KaraokeChannelSong[] | null {
  const entry = searchCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.at > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(cacheKey);
    return null;
  }
  return entry.songs;
}

function writeSearchCache(cacheKey: string, songs: KaraokeChannelSong[]): void {
  if (searchCache.size >= SEARCH_CACHE_MAX_ENTRIES) {
    const oldest = searchCache.keys().next();
    if (!oldest.done) searchCache.delete(oldest.value);
  }
  searchCache.set(cacheKey, { at: Date.now(), songs });
}

// Strip to letters and digits so a bullet-separated title, a full-width
// comma, or "Mr." vs "Mr" can't decide whether a row matches.
function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

// YouTube's channel search pads every response out to ~25-30 videos whether or
// not it has that many relevant ones. Searching Sing King for "Weezer Buddy
// Holly" returns 9 videos, none of them Weezer. So relevance has to be decided
// here: every word the user typed must appear somewhere in the parsed song and
// artist. That is what makes these channels usable without a catalog behind
// them, and it's why the parse has to come first.
function matchesKeyword(
  song: Pick<KaraokeChannelSong, "name" | "artistName">,
  keyword: string,
): boolean {
  const haystack = normalizeForMatch(`${song.name} ${song.artistName}`);
  if (!haystack) return false;

  const tokens = keyword
    .split(/\s+/)
    .map(normalizeForMatch)
    .filter((token) => token.length >= 2);

  // A query of only one-character tokens (common for CJK) has nothing to
  // tokenize; fall back to the keyword as a single run.
  if (tokens.length === 0) {
    const whole = normalizeForMatch(keyword);
    return whole.length > 0 && haystack.includes(whole);
  }

  return tokens.every((token) => haystack.includes(token));
}

async function searchOneChannel(
  youtube: Innertube,
  channel: KaraokeChannelDef,
  keyword: string,
): Promise<KaraokeChannelSong[]> {
  const cacheKey = `${channel.key}:${keyword}`;
  const cached = readSearchCache(cacheKey);
  if (cached) return cached;

  const handle = await getChannel(youtube, channel.channelId);
  const results = await handle.search(keyword);
  const videos = (results.videos ?? []) as unknown as YoutubeChannelVideoItem[];

  const parsed: { song: KaraokeChannelSong; rank: number }[] = [];
  for (const video of videos) {
    if (!video.id || video.is_live) continue;

    const playtime = video.duration?.seconds ?? null;
    if (
      playtime !== null &&
      (playtime < MIN_PLAYTIME_SEC || playtime > MAX_PLAYTIME_SEC)
    ) {
      continue;
    }

    const title = video.title?.text;
    if (!title) continue;

    const fields = channel.parse(title);
    if (!fields) continue;
    if (!matchesKeyword(fields, keyword)) continue;

    parsed.push({
      song: {
        id: `${channel.key}:${video.id}`,
        videoId: video.id,
        channelKey: channel.key,
        channelLabel: channel.label,
        name: fields.name,
        artistName: fields.artistName,
        variant: fields.variant,
        catalogId: fields.catalogId,
        playtime,
      },
      rank: fields.rank,
    });
  }

  // One row per song per channel: the channels that publish a guide and a
  // no-guide render of the same master would otherwise fill the list with
  // pairs, and KY adds a chorus and both key shifts on top of that. The
  // preferred render wins and its variant tag says which one it is.
  const best = new Map<string, { song: KaraokeChannelSong; rank: number }>();
  for (const entry of parsed) {
    const key = `${normalizeForMatch(entry.song.name)}|${normalizeForMatch(
      entry.song.artistName,
    )}`;
    const existing = best.get(key);
    if (!existing || entry.rank < existing.rank) {
      best.set(key, entry);
    }
  }

  const songs = [...best.values()]
    .map(({ song }) => song)
    .slice(0, MAX_ROWS_PER_CHANNEL);

  writeSearchCache(cacheKey, songs);
  return songs;
}

// Round-robin rather than concatenate, so a channel that happens to answer
// with ten rows doesn't push every other channel below the fold. Same reason
// the merged DAM/JOYSOUND search interleaves.
function roundRobin<Item>(lists: Item[][]): Item[] {
  const merged: Item[] = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      if (i < list.length) merged.push(list[i]);
    }
  }
  return merged;
}

// The fan-out is the one place karafriends can look like a scraper to
// YouTube, so it is worth being explicit about what is and isn't known here.
//
// There is no published rate limit to design against. This path is InnerTube
// (youtubei.js), YouTube's own internal API, called unauthenticated; YouTube
// commits to no quota for it and enforces with adaptive bot detection (429s,
// "Sign in to confirm you're not a bot") whose thresholds are unpublished and
// change. The official Data API v3 is the only place with a committed number,
// and at 100 quota units per search against a 10,000/day default it would buy
// roughly seven of these fan-outs a day, which is why this doesn't use it.
//
// So the budget is empirical: measured at 195 sequential channel searches
// with zero failures and no latency drift, roughly three times the request
// rate of a busy room. Volume is not the concern. Two things still are, and
// neither shows up in that measurement: a burst of every channel at once
// multiplied by however many phones are searching, and the fact that this
// shares an exit IP with yt-dlp, so search reputation is download reputation
// (see the karaoke-service-troubleshooting skill).
//
// Hence a cap rather than an unbounded Promise.all. It is insurance, not a
// measured need, and it is not free: unbounded runs ~570ms, 8 runs ~1000ms,
// 5 runs ~1500ms, because the requests are parallel I/O and every wave is
// wall time. 8 halves the peak burst for one wave of added latency. If 429s
// ever do appear, raise SEARCH_CACHE_TTL_MS before lowering this; the cache
// is what actually removes requests.
const SEARCH_CONCURRENCY = 8;

async function mapWithConcurrency<Item, Result>(
  items: readonly Item[],
  run: (item: Item) => Promise<Result>,
): Promise<PromiseSettledResult<Result>[]> {
  const results: PromiseSettledResult<Result>[] = new Array(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = {
          status: "fulfilled",
          value: await run(items[index]),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(SEARCH_CONCURRENCY, items.length) }, worker),
  );
  return results;
}

export async function searchKaraokeChannels(
  youtube: Innertube,
  keyword: string,
  channelKeys: readonly string[] | null,
): Promise<KaraokeChannelSearchResult> {
  const channels = channelKeys
    ? KARAOKE_CHANNELS.filter((channel) => channelKeys.includes(channel.key))
    : KARAOKE_CHANNELS;

  const settled = await mapWithConcurrency(channels, (channel) =>
    searchOneChannel(youtube, channel, keyword),
  );

  // One channel failing is normal (a rate limit, a channel that renamed) and
  // must not fail the search: the room can still sing off the other eight.
  const unavailableChannels: string[] = [];
  const perChannel: KaraokeChannelSong[][] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      perChannel.push(result.value);
      return;
    }
    unavailableChannels.push(channels[index].label);
    console.error(
      `[karaokeChannels] ${channels[index].key} search failed for "${keyword}"`,
      result.reason,
    );
  });

  return { songs: roundRobin(perChannel), unavailableChannels };
}
