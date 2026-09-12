// The faces the TV draws JOYSOUND lyrics in, for the lyrics panel to draw them
// in too. Loaded on demand (the Japanese one is 6MB) the first time a panel
// needs them, so a phone that never opens lyrics never downloads either.

// tslint:disable-next-line:no-submodule-imports no-implicit-dependencies
import jpFontUrl from "url:../renderer/fonts/NotoSerifJP-SemiBold.otf";
// tslint:disable-next-line:no-submodule-imports no-implicit-dependencies
import krFontUrl from "url:../renderer/fonts/NotoSerifKR-SemiBold.otf";

// Canvas font-family lists: the TV's own face first, then what phones already
// have, which is what draws until the download lands. Glyph positions don't
// depend on the face (every glyph is centered in the advance the telop
// authors), so a fallback changes the letterforms but not the layout.
export const TELOP_JP_FONT =
  'notoSerifJP, "Hiragino Mincho ProN", "Noto Serif CJK JP", "Noto Serif JP", serif';
export const TELOP_KR_FONT =
  'notoSerifKR, "AppleMyungjo", "Noto Serif CJK KR", "Noto Serif KR", serif';

const FACES = {
  jp: { family: "notoSerifJP", url: jpFontUrl },
  kr: { family: "notoSerifKR", url: krFontUrl },
};

const loads: Partial<Record<keyof typeof FACES, Promise<void>>> = {};

// Resolves once the face is usable in a canvas. Rejections are swallowed
// into a console warning: a missing font leaves the fallback drawing, which
// is a cosmetic loss, not a reason to show no lyrics.
export function loadTelopFont(which: keyof typeof FACES): Promise<void> {
  const existing = loads[which];
  if (existing) return existing;

  const { family, url } = FACES[which];
  const face = new FontFace(family, `url(${url})`);
  // FontFaceSet is set-like; TypeScript only declares its add() in the
  // dom.iterable lib, which this project's tsconfig doesn't include.
  (document.fonts as unknown as { add(face: FontFace): void }).add(face);

  const load = face
    .load()
    .then(() => undefined)
    .catch((e) => {
      console.warn(`Couldn't load the ${family} lyrics font`, e);
      // Let a later panel try again.
      delete loads[which];
    });

  loads[which] = load;
  return load;
}
