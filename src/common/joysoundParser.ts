/* tslint:disable:no-bitwise */
import invariant from "ts-invariant";

import Kuroshiro from "kuroshiro";
import KuromojiAnalyzer, { AnalyzerResult } from "kuroshiro-analyzer-kuromoji";

import { toKatakana } from "wanakana";

import { RUBY_FONT_SIZE, RUBY_FONT_STROKE } from "../common/constants";
import kanjiToReading from "./dictionary.json";

type DictionaryKanji = keyof typeof kanjiToReading;

export interface KuroshiroSingleton {
  kuroshiro: Kuroshiro;
  analyzer: KuromojiAnalyzer;
  analyzerInitPromise: Promise<void>;
}

export interface JoysoundPaletteColor {
  id: number;
  rgb: number[];
}

export interface JoysoundMetadata {
  musicName: string;
  artistName: string;
  lyricistName: string;
  composerName: string;
  musicNameReading: string;
  artistNameReading: string;
  fadeoutTime: number;
}

interface JoysoundLyricsChar {
  font: number;
  width: number;
  charCode: number;
  furiganaIndex: number;
}

interface JoysoundLyricsFurigana {
  length: number;
  xPos: number;
  chars: number[];
}

interface JoysoundLyricsRomaji {
  phrase: string;
  xPos: number;
  sourceWidth: number;
}

interface JoysoundScrollEvent {
  time: number;
  speed: number;
}

export interface JoysoundLyricsBlock {
  blockSize: number;
  flags: number;
  xPos: number;
  yPos: number;
  preFill: JoysoundPaletteColor;
  postFill: JoysoundPaletteColor;
  preBorder: JoysoundPaletteColor;
  postBorder: JoysoundPaletteColor;
  chars: JoysoundLyricsChar[];
  furigana: JoysoundLyricsFurigana[];
  romaji: JoysoundLyricsRomaji[];
  scrollEvents: JoysoundScrollEvent[];
  fadeinTime: number;
  fadeoutTime: number;
}

interface JoysoundTimelineEvent {
  currTime: number;
  payload: number[];
}

export interface JoysoundTelopData {
  metadata: JoysoundMetadata;
  lyrics: JoysoundLyricsBlock[];
  timeline: JoysoundTimelineEvent[];
}

const SUTEGANA = [
  "ぁ",
  "ぃ",
  "ぅ",
  "ぇ",
  "ぉ",
  "ゃ",
  "ゅ",
  "ょ",
  "ゎ",
  "ゕ",
  "ゖ",
];

const sjisDecoder = new TextDecoder("sjis");
const eucKrDecoder = new TextDecoder("euc-kr");

export function decodeJoysoundText(
  charCode: number,
  fontCode: number = 0,
  flags: number = 0,
): string {
  switch (fontCode) {
    case 0:
      return decodeSJIS(charCode, flags);
      break;
    case 1:
      return decodeEucKR(charCode);
      break;
    default:
      return decodeSJIS(charCode, flags);
  }
}

function decodeSJIS(charCode: number, flags: number): string {
  if (charCode <= 0xff) {
    return sjisDecoder.decode(new Uint8Array([charCode]));
  }

  if (flags === 255) {
    if (charCode === 0x819b) {
      return "♦";
    } else if (charCode === 0x819c) {
      return "♥";
    } else if (charCode === 0x819e) {
      return "♣";
    } else if (charCode === 0x819f) {
      return "♠";
    }
  }

  const bytes = new Uint8Array([Math.floor(charCode / 256), charCode % 256]);

  return sjisDecoder.decode(bytes);
}

function decodeEucKR(charCode: number): string {
  const bytes = new Uint8Array([Math.floor(charCode / 256), charCode % 256]);

  return eucKrDecoder.decode(bytes);
}

function isKatakanaUnicodeChar(unicodeChar: string) {
  const charCode = unicodeChar.charCodeAt(0);

  return charCode >= 0x30a0 && charCode <= 0x30ff;
}

function isKanaUnicodeChar(unicodeChar: string) {
  const charCode = unicodeChar.charCodeAt(0);

  return charCode >= 0x3040 && charCode <= 0x30ff;
}

function isKanjiUnicodeChar(unicodeChar: string) {
  return Kuroshiro.Util.hasKanji(unicodeChar) || unicodeChar === "々";
}

// Some JOYSOUND telops place literal space glyphs (half- or full-width)
// between characters purely for on-screen kerning (e.g. 少[space]年,
// still one word, 少年). Feeding those to kuromoji verbatim breaks its
// tokenization — a bare space is a hard boundary, so it saw 少 as a
// prefix and 年 as a separate noun instead of the compound 少年 (a real
// case: joysound-9630, block 1). Tokenization runs on the space-stripped
// text; every walk that steps tokenizedLyrics in lockstep with `chars`
// must skip these glyphs to stay aligned with it — see the `isSpaceUnicodeChar`
// guards in getMainRomajiBlocks, getNonKanaRomajiBlocks, and
// getTokenIndexByXPos.
function isSpaceUnicodeChar(unicodeChar: string) {
  return unicodeChar === " " || unicodeChar === "　";
}

function kanaReadingToRomaji(kanaReading: string) {
  // currPhrase mixes scripts glyph by glyph: a kuromoji token with
  // pronunciation data contributes katakana, one without (kuromoji has no
  // entry for it — common for onomatopoeia, e.g. ひゅるひゅるり in
  // HYURURIRAPAPPA) falls back to the literal hiragana source character.
  // kanaToRomaji only recognizes a small-kana digraph (ひゅ/ヒュ -> "hyu")
  // when both characters share a script — ヒ (katakana) + ゅ (hiragana)
  // romanizes as two morae, "hi" + "yu", instead of one. Normalize to a
  // single script first so a token-boundary script mismatch can't split a
  // digraph that direct-hiragana or direct-katakana readings render fine.
  const normalized = toKatakana(kanaReading);

  if (normalized.slice(-1) === "ッ") {
    return Kuroshiro.Util.kanaToRomaji(normalized.slice(0, -1), "hepburn");
  } else if (normalized === "ンー") {
    return "n";
  }

  return Kuroshiro.Util.kanaToRomaji(normalized, "hepburn");
}

function kanjiPhraseToRomaji(
  kanjiPhrase: string,
  hiraganaPhrase: string,
): string {
  if (kanjiToReading[kanjiPhrase as DictionaryKanji] !== undefined) {
    return kanaReadingToRomaji(kanjiToReading[kanjiPhrase as DictionaryKanji]);
  }

  return kanaReadingToRomaji(hiraganaPhrase);
}

function getRawLyrics(chars: JoysoundLyricsChar[]): string {
  let lyrics = "";

  for (const char of chars) {
    const unicodeChar = decodeJoysoundText(char.charCode, char.font);

    lyrics += unicodeChar;
  }

  return lyrics;
}

function getMainRomajiBlocks(
  chars: JoysoundLyricsChar[],
  tokenizedLyrics: AnalyzerResult[],
  wordSegmentation: boolean,
): JoysoundLyricsRomaji[] {
  const mainRomajiBlocks = [];

  let currXPos = 0;
  let currPhrase = "";
  let currPhraseWidth = 0;
  let prevGlyph = null;
  // Which tokenizedLyrics index the previous glyph belonged to, so
  // wordSegmentation can tell a same-word mora transition (glue) apart from
  // a word-boundary one (flush). Read at the bottom of the loop body, before
  // tokenizedLyricsIndex advances past a glyph that completed its token —
  // see the comment below on why that ordering makes it "current at time of
  // use" for the *next* iteration's prevUnicodeChar.
  let prevGlyphTokenIndex: number | null = null;

  let tokenizedLyricsIndex = 0;
  let tokenizedLyricsCharIndex = 0;

  for (const currGlyph of chars) {
    const unicodeChar = decodeJoysoundText(currGlyph.charCode, currGlyph.font);
    const prevUnicodeChar =
      prevGlyph !== null
        ? decodeJoysoundText(prevGlyph.charCode, currGlyph.font)
        : null;

    // Without this, every kana glyph flushes as its own single-mora block
    // (see the four unconditional checks below) and only reads as one word
    // because adjacent blocks are drawn with zero gap. In word-segmentation
    // mode, mora kuromoji tokenized as the same word (e.g. ある, もの) stay
    // glued into one block instead, so あるもの renders as "aru" + "mono"
    // (two independently-positioned blocks) rather than one "arumono" run.
    // Katakana is deliberately excluded — IPADIC is known to shatter
    // loanwords/proper nouns into bogus sub-word tokens (see the 涼宮
    // tokenizer note in nameYomi resolution) — so katakana runs keep the
    // existing blanket glue below instead of trusting kuromoji's split.
    const isContinuationOfSameKanaWord =
      wordSegmentation &&
      prevUnicodeChar !== null &&
      isKanaUnicodeChar(prevUnicodeChar) &&
      isKanaUnicodeChar(unicodeChar) &&
      !(
        isKatakanaUnicodeChar(prevUnicodeChar) &&
        isKatakanaUnicodeChar(unicodeChar)
      ) &&
      tokenizedLyricsIndex === prevGlyphTokenIndex;

    if (
      prevUnicodeChar !== null &&
      isKanaUnicodeChar(prevUnicodeChar) &&
      !(isKanaUnicodeChar(unicodeChar) && prevUnicodeChar === "っ") &&
      !SUTEGANA.includes(unicodeChar) &&
      !(
        isKatakanaUnicodeChar(prevUnicodeChar) &&
        isKatakanaUnicodeChar(unicodeChar)
      ) &&
      unicodeChar !== "ー" &&
      !isContinuationOfSameKanaWord
    ) {
      mainRomajiBlocks.push({
        phrase: kanaReadingToRomaji(currPhrase),
        xPos: currXPos,
        sourceWidth: currPhraseWidth,
      });

      currXPos += currPhraseWidth;
      currPhrase = "";
      currPhraseWidth = 0;
    }

    // XXX: Welcome hell
    if (!isKanaUnicodeChar(unicodeChar) || unicodeChar === "・") {
      currXPos += currGlyph.width;
    } else {
      if (
        tokenizedLyrics[tokenizedLyricsIndex].pronunciation &&
        !Kuroshiro.Util.hasKanji(
          tokenizedLyrics[tokenizedLyricsIndex].surface_form,
        ) &&
        tokenizedLyrics[tokenizedLyricsIndex].pronunciation[
          tokenizedLyricsCharIndex
        ] !== undefined &&
        tokenizedLyrics[tokenizedLyricsIndex].pronunciation[
          tokenizedLyricsCharIndex
        ] !== "ー" &&
        !(
          tokenizedLyricsIndex === 0 &&
          tokenizedLyrics[tokenizedLyricsIndex].surface_form === "は"
        )
      ) {
        currPhrase +=
          tokenizedLyrics[tokenizedLyricsIndex].pronunciation[
            tokenizedLyricsCharIndex
          ];
      } else if (
        tokenizedLyrics[tokenizedLyricsIndex].pronunciation &&
        tokenizedLyrics[tokenizedLyricsIndex].surface_form.length > 1 &&
        tokenizedLyricsCharIndex ===
          tokenizedLyrics[tokenizedLyricsIndex].surface_form.length - 1 &&
        tokenizedLyrics[tokenizedLyricsIndex].surface_form.slice(-1) === "は"
      ) {
        currPhrase +=
          tokenizedLyrics[tokenizedLyricsIndex].pronunciation.slice(-1);
      } else {
        currPhrase += unicodeChar;
      }

      currPhraseWidth += currGlyph.width;
    }

    // Kerning-only space glyphs were stripped before tokenization (see
    // isSpaceUnicodeChar), so they don't occupy a tokenizedLyrics position
    // and are invisible to it here too — skip updating prevGlyph/the token
    // walk, or a space would (a) make the next char's prevUnicodeChar
    // non-kana and suppress a flush that should still happen, and (b) drift
    // this walk out of alignment with tokenizedLyrics.
    if (!isSpaceUnicodeChar(unicodeChar)) {
      prevGlyph = currGlyph;
      prevGlyphTokenIndex = tokenizedLyricsIndex;

      tokenizedLyricsCharIndex += 1;

      if (
        tokenizedLyrics[tokenizedLyricsIndex].surface_form.length ===
        tokenizedLyricsCharIndex
      ) {
        tokenizedLyricsIndex += 1;
        tokenizedLyricsCharIndex = 0;
      }
    }
  }

  if (currPhrase) {
    mainRomajiBlocks.push({
      phrase: kanaReadingToRomaji(currPhrase),
      xPos: currXPos,
      sourceWidth: currPhraseWidth,
    });
  }

  return mainRomajiBlocks;
}

function getFuriganaRomajiBlocks(
  furigana: JoysoundLyricsFurigana[],
): JoysoundLyricsRomaji[] {
  const furiganaRomajiBlocks = [];

  for (const furiganaBlock of furigana) {
    const furiganaPhrase = furiganaBlock.chars
      .map((charCode) => decodeJoysoundText(charCode))
      .join("");

    const romajiPhrase = kanaReadingToRomaji(furiganaPhrase);

    furiganaRomajiBlocks.push({
      phrase: romajiPhrase,
      xPos: furiganaBlock.xPos,
      sourceWidth:
        furiganaPhrase.length * (RUBY_FONT_SIZE + RUBY_FONT_STROKE * 2),
    });
  }

  return furiganaRomajiBlocks;
}

// JOYSOUND furigana is authored per source character — a two-kanji word like
// 天使 gets two separate furigana entries (天→てん, 使→し), not one spanning
// the compound — so getFuriganaRomajiBlocks above always emits one romaji
// block per entry ("ten" + "shi") regardless of word boundaries. Worse, a
// token can straddle block *types* entirely: 知らない tokenizes as 知ら
// (mixed kanji+kana) + ない, so its kanji half renders via furigana ("shi")
// and its kana half via getMainRomajiBlocks ("ra"), two unrelated builder
// functions that don't know about each other.
//
// This maps every glyph's on-screen xPos — both its position in the main
// text row and, if it's under furigana, that ruby annotation's own xPos (a
// separate coordinate authored independently in the telop, not derivable
// from the glyph's position) — to the kuromoji token index covering it, so
// mergeRomajiByWord can glue same-token blocks together regardless of which
// function produced them.
function getTokenIndexByXPos(
  chars: JoysoundLyricsChar[],
  furigana: JoysoundLyricsFurigana[],
  tokenizedLyrics: AnalyzerResult[],
): Map<number, number> {
  const xPosToTokenIndex = new Map<number, number>();

  let tokenizedLyricsIndex = 0;
  let tokenizedLyricsCharIndex = 0;
  let currXPos = 0;

  for (const char of chars) {
    const unicodeChar = decodeJoysoundText(char.charCode, char.font);
    const isSpace = isSpaceUnicodeChar(unicodeChar);

    if (!isSpace) {
      xPosToTokenIndex.set(currXPos, tokenizedLyricsIndex);

      if (char.furiganaIndex >= 0) {
        xPosToTokenIndex.set(
          furigana[char.furiganaIndex].xPos,
          tokenizedLyricsIndex,
        );
      }
    }

    currXPos += char.width;

    // Kerning-only space glyphs were stripped before tokenization (see
    // isSpaceUnicodeChar) — skip them here too, or this walk drifts out of
    // alignment with tokenizedLyrics.
    if (isSpace) {
      continue;
    }

    tokenizedLyricsCharIndex += 1;

    if (
      tokenizedLyrics[tokenizedLyricsIndex].surface_form.length ===
      tokenizedLyricsCharIndex
    ) {
      tokenizedLyricsIndex += 1;
      tokenizedLyricsCharIndex = 0;
    }
  }

  return xPosToTokenIndex;
}

// Glues adjacent romaji blocks (on-screen xPos order, across all four
// builder functions above) into one when they belong to the same kuromoji
// token — e.g. 天使's "ten" + "shi" -> "tenshi", or 知らない's furigana
// "shi" + kana "ra" (+ the separate token ない, left alone) -> "shira" +
// "nai". Must run after deleteOverwrittenFuriganaRomaji, which relies on
// the pre-merge 1:1 correspondence between a raw furiganaRomaji array and
// `furigana`.
function mergeRomajiByWord(
  romaji: JoysoundLyricsRomaji[],
  xPosToTokenIndex: Map<number, number>,
): JoysoundLyricsRomaji[] {
  const sorted = [...romaji].sort((a, b) => a.xPos - b.xPos);
  const merged: JoysoundLyricsRomaji[] = [];
  let prevTokenIndex: number | undefined;

  for (const block of sorted) {
    const tokenIndex = xPosToTokenIndex.get(block.xPos);
    const prevBlock = merged[merged.length - 1];

    if (
      prevBlock !== undefined &&
      tokenIndex !== undefined &&
      tokenIndex === prevTokenIndex
    ) {
      prevBlock.phrase += block.phrase;
      prevBlock.sourceWidth += block.sourceWidth;
    } else {
      merged.push({ ...block });
    }

    prevTokenIndex = tokenIndex;
  }

  return merged;
}

function getNonKanaRomajiBlocks(
  chars: JoysoundLyricsChar[],
  tokenizedLyrics: AnalyzerResult[],
): JoysoundLyricsRomaji[] {
  const fillerRomajiBlocks = [];

  let hiraganaPhrase = "";

  let currXPos = 0;
  let currPhrase = "";
  let currPhraseWidth = 0;

  let tokenizedLyricsIndex = 0;
  let tokenizedLyricsCharIndex = 0;

  for (const currGlyph of chars) {
    const unicodeChar = decodeJoysoundText(currGlyph.charCode, currGlyph.font);

    // Kerning-only space glyphs (see isSpaceUnicodeChar) were stripped
    // before tokenization, so they don't occupy a tokenizedLyrics position.
    // Treat them as transparent here too — folding their width into
    // whatever's on either side — rather than letting them force a flush
    // mid-word (e.g. 少[space]年, still one word) or drift this walk out of
    // alignment with tokenizedLyrics.
    if (isSpaceUnicodeChar(unicodeChar)) {
      if (currPhrase.length > 0) {
        currPhraseWidth += currGlyph.width;
      } else {
        currXPos += currGlyph.width;
      }
      continue;
    }

    if (
      isKanjiUnicodeChar(unicodeChar) &&
      currGlyph.font === 0 &&
      (currPhrase.length > 0 || currGlyph.furiganaIndex < 0) &&
      !Kuroshiro.Util.hasKana(
        tokenizedLyrics[tokenizedLyricsIndex].surface_form,
      )
    ) {
      // XXX: This is a mega hack
      currGlyph.furiganaIndex = 6969;
      currPhrase += unicodeChar;
      currPhraseWidth += currGlyph.width;

      if (tokenizedLyricsCharIndex === 0) {
        hiraganaPhrase += tokenizedLyrics[tokenizedLyricsIndex].pronunciation;
      }
    } else {
      if (currPhrase.length > 0) {
        fillerRomajiBlocks.push({
          phrase: kanjiPhraseToRomaji(currPhrase, hiraganaPhrase),
          xPos: currXPos,
          sourceWidth: currPhraseWidth,
        });

        currXPos += currPhraseWidth;
        currPhrase = "";
        currPhraseWidth = 0;
        hiraganaPhrase = "";
      }
      currXPos += currGlyph.width;
    }

    tokenizedLyricsCharIndex += 1;

    if (
      tokenizedLyrics[tokenizedLyricsIndex].surface_form.length ===
      tokenizedLyricsCharIndex
    ) {
      tokenizedLyricsIndex += 1;
      tokenizedLyricsCharIndex = 0;
    }
  }

  if (currPhrase.length > 0) {
    fillerRomajiBlocks.push({
      phrase: kanjiPhraseToRomaji(currPhrase, hiraganaPhrase),
      xPos: currXPos,
      sourceWidth: currPhraseWidth,
    });
  }

  return fillerRomajiBlocks;
}

function getFillerRomajiBlocks(
  chars: JoysoundLyricsChar[],
  okuriganaLyrics: string,
): JoysoundLyricsRomaji[] {
  const fillerRomajiBlocks = [];

  let currXPos = 0;

  let hiraganaPhrase = "";
  let kanjiPhrase = "";
  let kanjiPhraseWidth = 0;

  let charIndex = 0;

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    const unicodeChar = decodeJoysoundText(char.charCode, char.font);

    if (
      !isKanjiUnicodeChar(unicodeChar) ||
      char.font !== 0 ||
      char.furiganaIndex >= 0
    ) {
      if (hiraganaPhrase.length > 0) {
        fillerRomajiBlocks.push({
          phrase: Kuroshiro.Util.kanaToRomaji(hiraganaPhrase, "hepburn"),
          xPos: currXPos,
          sourceWidth: kanjiPhraseWidth,
        });
      }

      currXPos += kanjiPhraseWidth + char.width;

      hiraganaPhrase = "";
      kanjiPhrase = "";
      kanjiPhraseWidth = 0;

      charIndex += 1;

      if (
        charIndex < okuriganaLyrics.length &&
        okuriganaLyrics[charIndex] === "¬"
      ) {
        charIndex += 1;

        while (
          charIndex < okuriganaLyrics.length &&
          okuriganaLyrics[charIndex] !== "¬"
        ) {
          charIndex += 1;
        }

        charIndex += 1;
      }

      continue;
    }

    kanjiPhrase += unicodeChar;
    kanjiPhraseWidth += char.width;

    charIndex += 1;

    while (
      charIndex < okuriganaLyrics.length &&
      okuriganaLyrics[charIndex] !== "¬"
    ) {
      kanjiPhrase += okuriganaLyrics[charIndex];

      charIndex += 1;
      i += 1;

      kanjiPhraseWidth += chars[i].width;
      chars[i].furiganaIndex = -1;
    }

    charIndex += 1;

    while (
      charIndex < okuriganaLyrics.length &&
      okuriganaLyrics[charIndex] !== "¬"
    ) {
      hiraganaPhrase += okuriganaLyrics[charIndex];
      charIndex += 1;
    }

    charIndex += 1;
  }

  if (hiraganaPhrase.length > 0) {
    fillerRomajiBlocks.push({
      phrase: Kuroshiro.Util.kanaToRomaji(hiraganaPhrase, "hepburn"),
      xPos: currXPos,
      sourceWidth: kanjiPhraseWidth,
    });
  }

  return fillerRomajiBlocks;
}

function mapCharsToFurigana(
  chars: JoysoundLyricsChar[],
  furiganaList: JoysoundLyricsFurigana[],
): void {
  let currXPos = 0;

  for (const char of chars) {
    // XXX: To map a character to furigana we assume the furigana must
    //      cover at least 8 pixels
    let bestIntersection = 8;
    const unicodeChar = decodeJoysoundText(char.charCode, char.font);

    for (let i = 0; i < furiganaList.length; i++) {
      const furigana = furiganaList[i];
      const intersection = intervalIntersection(
        currXPos,
        currXPos + char.width,
        furigana.xPos,
        furigana.xPos +
          furigana.chars.length * (RUBY_FONT_SIZE + RUBY_FONT_STROKE * 2),
      );

      if (intersection > bestIntersection) {
        char.furiganaIndex = i;
        bestIntersection = intersection;
      }
    }

    currXPos += char.width;
  }
}

function deleteOverwrittenFuriganaRomaji(
  chars: JoysoundLyricsChar[],
  furiganaRomaji: JoysoundLyricsRomaji[],
): void {
  for (let i = furiganaRomaji.length - 1; i >= 0; i--) {
    let isFuriganaOverwritten = true;

    for (const char of chars) {
      if (char.furiganaIndex === i) {
        isFuriganaOverwritten = false;
        break;
      }
    }

    if (isFuriganaOverwritten) {
      furiganaRomaji.splice(i, 1);
    }
  }
}

async function parseLyricsBlock(
  view: DataView,
  offset: number,
  palette: JoysoundPaletteColor[],
  kuroshiro: KuroshiroSingleton,
  wordSegmentation: boolean,
) {
  let currOffset = offset;

  const blockSize = view.getUint16(currOffset, true);

  const flags = view.getUint16(currOffset + 2, true);
  const xPos = view.getUint16(currOffset + 4, true);
  const yPos = view.getUint16(currOffset + 6, true);
  const preFill = palette[view.getUint8(currOffset + 8)];
  const postFill = palette[view.getUint8(currOffset + 9)];
  const preBorder = palette[view.getUint8(currOffset + 10)];
  const postBorder = palette[view.getUint8(currOffset + 11)];

  const chars = [];
  const charCount = view.getUint16(currOffset + 12, true);

  currOffset += 14;

  for (let i = 0; i < charCount; i++) {
    const charFont = view.getUint8(currOffset);
    const charCode = view.getUint16(currOffset + 1, true);
    const charWidth = view.getUint16(currOffset + 3, true);

    chars.push({
      font: charFont,
      width: charWidth,
      charCode,
      furiganaIndex: -1,
    });

    currOffset += 5;
  }

  const furigana = [];
  const furiganaCount = view.getUint16(currOffset, true);

  currOffset += 2;

  for (let i = 0; i < furiganaCount; i++) {
    const furiganaChars = [];

    const furiganaLength = view.getUint16(currOffset, true);
    const furiganaXPos = view.getUint16(currOffset + 2, true);

    for (let j = 0; j < furiganaLength; j++) {
      furiganaChars.push(view.getUint16(currOffset + 4 + j * 2, true));
    }

    furigana.push({
      length: furiganaLength,
      xPos: furiganaXPos,
      chars: furiganaChars,
    });

    currOffset += 4 + furiganaLength * 2;
  }

  mapCharsToFurigana(chars, furigana);

  await kuroshiro.analyzerInitPromise;

  const rawLyrics = getRawLyrics(chars);
  const tokenizedLyrics = await kuroshiro.analyzer.parse(
    rawLyrics.replace(/[ 　]/g, ""),
  );
  const okuriganaLyrics = await kuroshiro.kuroshiro.convert(rawLyrics, {
    mode: "okurigana",
    to: "hiragana",
    delimiter_start: "¬",
    delimiter_end: "¬",
  });

  const mainRomaji = getMainRomajiBlocks(
    chars,
    tokenizedLyrics,
    wordSegmentation,
  );
  const furiganaRomaji = getFuriganaRomajiBlocks(furigana);
  // XXX: For kanji without furigana and no kana (i.e. 空), we trust
  //      dictionary.json and fallback to kuroshiro
  const nonKanaRomaji = getNonKanaRomajiBlocks(chars, tokenizedLyrics);
  // XXX: For kanji without furigana and kana (i.e. 下げる), we trust
  //      kuroshiro's okurigana format
  const fillerRomaji = getFillerRomajiBlocks(chars, okuriganaLyrics);

  deleteOverwrittenFuriganaRomaji(chars, furiganaRomaji);

  const combinedRomaji = mainRomaji
    .concat(furiganaRomaji)
    .concat(nonKanaRomaji)
    .concat(fillerRomaji);

  const romaji = wordSegmentation
    ? mergeRomajiByWord(
        combinedRomaji,
        getTokenIndexByXPos(chars, furigana, tokenizedLyrics),
      )
    : combinedRomaji;

  return {
    blockSize,
    flags,
    xPos,
    yPos,
    preFill,
    postFill,
    preBorder,
    postBorder,
    chars,
    furigana,
    romaji,
    scrollEvents: [],
    fadeinTime: -1,
    fadeoutTime: -1,
  };
}

function readSJISString(view: DataView, offset: number, size: number): string {
  let unicodeString = "";
  let currOffset = offset;

  while (currOffset < offset + size) {
    if (view.getUint8(currOffset) === 0) {
      break;
    }

    let charCode;
    const firstByte = view.getUint8(currOffset);

    if (firstByte <= 0x7f || (firstByte > 0xa0 && firstByte <= 0xdf)) {
      charCode = view.getUint8(currOffset);

      unicodeString += decodeJoysoundText(charCode);
      currOffset += 1;

      continue;
    }

    charCode = view.getUint16(currOffset);
    unicodeString += decodeJoysoundText(charCode);

    currOffset += 2;
  }

  return unicodeString;
}

function parseJoy02Metadata(
  data: ArrayBuffer,
  offset: number,
  size: number,
): JoysoundMetadata {
  const metadataView = new DataView(data, offset, size);

  const currOffset = 0;

  const musicType = metadataView.getUint16(currOffset, true);
  const musicNameOffset = metadataView.getUint16(currOffset + 2, true);
  const artistNameOffset = metadataView.getUint16(currOffset + 4, true);
  const lyricistNameOffset = metadataView.getUint16(currOffset + 6, true);
  const composerNameOffset = metadataView.getUint16(currOffset + 8, true);
  const musicNameReadingOffset = metadataView.getUint16(currOffset + 10, true);
  const artistNameReadingOffset = metadataView.getUint16(currOffset + 12, true);
  const jasracCodeOffset = metadataView.getUint16(currOffset + 14, true);
  const musicDuration = metadataView.getUint16(currOffset + 18, true);

  const musicName = readSJISString(
    metadataView,
    musicNameOffset,
    artistNameOffset - musicNameOffset,
  );
  const artistName = readSJISString(
    metadataView,
    artistNameOffset,
    lyricistNameOffset - artistNameOffset,
  );
  const lyricistName = readSJISString(
    metadataView,
    lyricistNameOffset,
    composerNameOffset - lyricistNameOffset,
  );
  const composerName = readSJISString(
    metadataView,
    composerNameOffset,
    musicNameReadingOffset - composerNameOffset,
  );
  const musicNameReading = readSJISString(
    metadataView,
    musicNameReadingOffset,
    artistNameReadingOffset - musicNameReadingOffset,
  );
  const artistNameReading = readSJISString(
    metadataView,
    artistNameReadingOffset,
    jasracCodeOffset - artistNameReadingOffset,
  );

  return {
    musicName,
    artistName,
    lyricistName,
    composerName,
    musicNameReading,
    artistNameReading,
    fadeoutTime: 0,
  };
}

function intervalIntersection(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): number {
  if (bStart > aEnd || aStart > bEnd) {
    return -1;
  }

  const intersectionStart = Math.max(aStart, bStart);
  const intersectionEnd = Math.min(aEnd, bEnd);

  return intersectionEnd - intersectionStart;
}

async function parseJoy02LyricsData(
  data: ArrayBuffer,
  offset: number,
  size: number,
  kuroshiro: KuroshiroSingleton,
  wordSegmentation: boolean,
): Promise<JoysoundLyricsBlock[]> {
  const lyricsView = new DataView(data, offset, size);
  const lyricsBlocks = [];

  const palette = [];

  let currOffset = 0;

  for (let i = 0; i < 15; i++) {
    const rgbData = lyricsView.getUint16(currOffset, true);
    const color = {
      id: i,
      rgb: [
        Math.floor((((rgbData >> 10) & 31) / 31) * 255),
        Math.floor((((rgbData >> 5) & 31) / 31) * 255),
        Math.floor((((rgbData >> 0) & 31) / 31) * 255),
      ],
    };

    palette.push(color);

    currOffset += 2;
  }

  while (currOffset < size) {
    const block = await parseLyricsBlock(
      lyricsView,
      currOffset,
      palette,
      kuroshiro,
      wordSegmentation,
    );
    lyricsBlocks.push(block);

    currOffset += block.blockSize;
  }

  return lyricsBlocks;
}

function parseJoy02TimingData(data: ArrayBuffer, offset: number, size: number) {
  const timingView = new DataView(data, offset, size);
  const events = [];

  let currOffset = 0;

  while (currOffset < size) {
    const currTime = timingView.getUint32(currOffset, true);

    const payloadSize = timingView.getUint8(currOffset + 4);
    const payloadBytes = [];

    for (let i = 0; i < payloadSize; i++) {
      payloadBytes.push(timingView.getUint8(currOffset + 5 + i));
    }

    currOffset += 5 + payloadSize;

    events.push({
      currTime,
      payload: payloadBytes,
    });
  }

  return events;
}

function processTimeline(
  timeline: JoysoundTimelineEvent[],
  metadata: JoysoundMetadata,
  lyricsData: JoysoundLyricsBlock[],
) {
  const activeLyricsBlocks = [];

  let currLyricsBlockIndex = -1;
  let scrollLyricsBlockIndex = -1;

  for (const currEvent of timeline) {
    const eventCode = currEvent.payload[0];

    if ([0, 1, 12, 13].includes(eventCode)) {
      if (eventCode % 2 === 0) {
        scrollLyricsBlockIndex += 1;

        while (lyricsData[scrollLyricsBlockIndex].flags === 0xff) {
          scrollLyricsBlockIndex += 1;
        }
      }

      const scrollSpeed = currEvent.payload[1] * (eventCode <= 1 ? 10 : 1);
      const scrollLyricsBlock = lyricsData[scrollLyricsBlockIndex];

      scrollLyricsBlock.scrollEvents.push({
        time: currEvent.currTime,
        speed: scrollSpeed,
      });
    } else if (currEvent.payload[0] === 4) {
      metadata.fadeoutTime = currEvent.currTime;
    } else if (currEvent.payload[0] === 5) {
      for (let i = 0; i < currEvent.payload[1]; i++) {
        const fadeoutIndex = activeLyricsBlocks.shift();
        invariant(fadeoutIndex !== undefined);

        lyricsData[fadeoutIndex].fadeoutTime = currEvent.currTime;
      }
    } else if (currEvent.payload[0] === 6) {
      for (let i = 0; i < currEvent.payload[1]; i++) {
        currLyricsBlockIndex += 1;

        lyricsData[currLyricsBlockIndex].fadeinTime = currEvent.currTime;
        activeLyricsBlocks.push(currLyricsBlockIndex);
      }
    }
  }
}

async function parseJoysoundData(
  data: ArrayBuffer,
  kuroshiro: KuroshiroSingleton,
  // Segment kana-run romaji at kuromoji word boundaries (e.g. あるもの ->
  // "aru" + "mono") instead of the default per-mora blocks (e.g. "a" + "ru"
  // + "mo" + "no", visually glued into "arumono" by zero inter-block gap).
  // The cached .joy_02 blob this parses is raw telop data untouched by this
  // flag — parsing (and this toggle) happens fresh in the renderer process
  // on every draw, so flipping it needs no re-download or cache bust.
  wordSegmentation: boolean = false,
): Promise<JoysoundTelopData> {
  const lyricsBlocks = [];

  const view = new DataView(data, 6, 3 * 4);

  const metadataOffset = view.getUint32(0 * 4, true);
  const lyricsOffset = view.getUint32(1 * 4, true);
  const timingOffset = view.getUint32(2 * 4, true);

  const metadata = parseJoy02Metadata(
    data,
    metadataOffset,
    lyricsOffset - metadataOffset,
  );
  const lyricsData = await parseJoy02LyricsData(
    data,
    lyricsOffset,
    timingOffset - lyricsOffset,
    kuroshiro,
    wordSegmentation,
  );
  const timeline = parseJoy02TimingData(
    data,
    timingOffset,
    data.byteLength - timingOffset,
  );

  processTimeline(timeline, metadata, lyricsData);

  return {
    metadata,
    lyrics: lyricsData,
    timeline,
  };
}

// Joysound's raw API (getFME) returns telop/ogg fields as base64 with the
// first 30 bytes rotated to the end, presumably as a trivial anti-scraping
// obfuscation. Un-rotate before decoding.
export function decodeJoysoundBase64Field(base64: string): Buffer {
  return Buffer.from(base64.slice(30) + base64.slice(0, 30), "base64");
}

export function getSongDuration(data: ArrayBuffer): number {
  const offsetView = new DataView(data, 6, 4);
  const metadataOffset = offsetView.getUint32(0, true);
  const metadataView = new DataView(data, metadataOffset, 20);

  return metadataView.getUint16(18, true);
}

export default parseJoysoundData;
