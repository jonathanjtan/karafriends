declare module "wanakana" {
  export function isRomaji(input: string): boolean;
  export function toKana(
    input: string,
    options?: { IMEMode?: boolean },
  ): string;
  export function toHiragana(
    input: string,
    options?: { IMEMode?: boolean },
  ): string;
  export function toKatakana(
    input: string,
    options?: { IMEMode?: boolean },
  ): string;
  export function toRomaji(input: string): string;
}
