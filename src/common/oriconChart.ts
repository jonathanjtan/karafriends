// Oricon yearly karaoke Top 10, 2013-2025.
//
// Unlike the DAM/JOYSOUND charts in main/rankings.ts, this one is a static
// table rather than a scrape. Oricon's live site only serves the most
// recently completed annual chart for free (10 entries, one page); every
// past year redirects to the paid "you大樹" service, and the site is
// Shift_JIS and rate-limits aggressively. Since a closed year's chart never
// changes, a constant is strictly better than a scraper here. It costs no
// requests, works offline, and can't rot.
//
// Provenance: each year was taken from a Wayback snapshot of
// oricon.co.jp/rank/ko/y/<year>/ and cross-checked against the yearly tables
// in en.wikipedia.org/wiki/Oricon_Karaoke_Chart (which covers 2013-2023).
// The archived pages supply the native Japanese artist names that Wikipedia
// romanizes, and Wikipedia supplies the year labels that the URLs do NOT
// reliably carry: /y/<Y>/ serves the latest *completed* chart, so an
// early-in-the-year snapshot of /y/2024/ actually holds 2023's list. Titles
// were matched row-for-row between the two sources to pin each year down.
// 2024 and 2025 postdate Wikipedia's coverage and were taken from snapshots
// dated after each year closed, with the #1 confirmed against Oricon's own
// reporting (2024: Vaundy's second consecutive year; 2025: Mrs.GREEN APPLE).
//
// Entries carry no DAM/JOYSOUND ids: Oricon is a third-party chart with its
// own title/artist spellings. Mapping a row onto a singable song happens
// lazily in the remocon, only once someone taps into it.

export interface OriconChartEntry {
  readonly rank: number;
  readonly name: string;
  readonly artistName: string;
}

const ORICON_KARAOKE_CHART: {
  readonly [year: number]: ReadonlyArray<OriconChartEntry>;
} = {
  2013: [
    { rank: 1, name: "女々しくて", artistName: "ゴールデンボンバー" },
    { rank: 2, name: "残酷な天使のテーゼ", artistName: "高橋洋子" },
    { rank: 3, name: "小さな恋のうた", artistName: "MONGOL800" },
    { rank: 4, name: "ハナミズキ", artistName: "一青窈" },
    { rank: 5, name: "栄光の架橋", artistName: "ゆず" },
    { rank: 6, name: "キセキ", artistName: "GReeeeN" },
    { rank: 7, name: "千本桜", artistName: "WhiteFlame feat.初音ミク" },
    { rank: 8, name: "ヘビーローテーション", artistName: "AKB48" },
    { rank: 9, name: "366日", artistName: "HY" },
    { rank: 10, name: "天体観測", artistName: "BUMP OF CHICKEN" },
  ],
  2014: [
    {
      rank: 1,
      name: "レット・イット・ゴー～ありのままで～(日本語歌)",
      artistName: "松たか子",
    },
    { rank: 2, name: "恋するフォーチュンクッキー", artistName: "AKB48" },
    { rank: 3, name: "ハナミズキ", artistName: "一青窈" },
    { rank: 4, name: "残酷な天使のテーゼ", artistName: "高橋洋子" },
    { rank: 5, name: "千本桜", artistName: "WhiteFlame feat.初音ミク" },
    { rank: 6, name: "女々しくて", artistName: "ゴールデンボンバー" },
    { rank: 7, name: "小さな恋のうた", artistName: "MONGOL800" },
    { rank: 8, name: "栄光の架橋", artistName: "ゆず" },
    { rank: 9, name: "奏(かなで)", artistName: "スキマスイッチ" },
    { rank: 10, name: "南部蝉しぐれ", artistName: "福田こうへい" },
  ],
  2015: [
    {
      rank: 1,
      name: "R.Y.U.S.E.I.",
      artistName: "三代目 J Soul Brothers from EXILE TRIBE",
    },
    { rank: 2, name: "ひまわりの約束", artistName: "秦 基博" },
    { rank: 3, name: "糸", artistName: "中島みゆき" },
    { rank: 4, name: "Dragon Night", artistName: "SEKAI NO OWARI" },
    {
      rank: 5,
      name: "レット・イット・ゴー～ありのままで～(日本語歌)",
      artistName: "松たか子",
    },
    { rank: 6, name: "ハナミズキ", artistName: "一青窈" },
    { rank: 7, name: "Darling", artistName: "西野カナ" },
    { rank: 8, name: "残酷な天使のテーゼ", artistName: "高橋洋子" },
    { rank: 9, name: "Story", artistName: "AI" },
    { rank: 10, name: "奏(かなで)", artistName: "スキマスイッチ" },
  ],
  2016: [
    { rank: 1, name: "海の声", artistName: "浦島太郎(桐谷健太)" },
    { rank: 2, name: "糸", artistName: "中島みゆき" },
    { rank: 3, name: "ひまわりの約束", artistName: "秦 基博" },
    { rank: 4, name: "トリセツ", artistName: "西野カナ" },
    { rank: 5, name: "ハナミズキ", artistName: "一青窈" },
    { rank: 6, name: "残酷な天使のテーゼ", artistName: "高橋洋子" },
    { rank: 7, name: "365日の紙飛行機", artistName: "AKB48" },
    {
      rank: 8,
      name: "R.Y.U.S.E.I.",
      artistName: "三代目 J Soul Brothers from EXILE TRIBE",
    },
    { rank: 9, name: "奏(かなで)", artistName: "スキマスイッチ" },
    { rank: 10, name: "小さな恋のうた", artistName: "MONGOL800" },
  ],
  2017: [
    { rank: 1, name: "恋", artistName: "星野源" },
    { rank: 2, name: "糸", artistName: "中島みゆき" },
    { rank: 3, name: "前前前世(movie ver.)", artistName: "RADWIMPS" },
    { rank: 4, name: "ひまわりの約束", artistName: "秦 基博" },
    { rank: 5, name: "奏(かなで)", artistName: "スキマスイッチ" },
    { rank: 6, name: "ハナミズキ", artistName: "一青窈" },
    { rank: 7, name: "残酷な天使のテーゼ", artistName: "高橋洋子" },
    { rank: 8, name: "小さな恋のうた", artistName: "MONGOL800" },
    { rank: 9, name: "海の声", artistName: "浦島太郎(桐谷健太)" },
    { rank: 10, name: "キセキ", artistName: "GReeeeN" },
  ],
  2018: [
    { rank: 1, name: "Lemon", artistName: "米津玄師" },
    { rank: 2, name: "糸", artistName: "中島みゆき" },
    { rank: 3, name: "残酷な天使のテーゼ", artistName: "高橋洋子" },
    { rank: 4, name: "小さな恋のうた", artistName: "MONGOL800" },
    { rank: 5, name: "奏(かなで)", artistName: "スキマスイッチ" },
    { rank: 6, name: "ひまわりの約束", artistName: "秦 基博" },
    { rank: 7, name: "ダンシング・ヒーロー", artistName: "荻野目洋子" },
    { rank: 8, name: "ハナミズキ", artistName: "一青窈" },
    { rank: 9, name: "恋", artistName: "星野源" },
    { rank: 10, name: "さよならエレジー", artistName: "菅田将暉" },
  ],
  2019: [
    { rank: 1, name: "Lemon", artistName: "米津玄師" },
    { rank: 2, name: "マリーゴールド", artistName: "あいみょん" },
    { rank: 3, name: "さよならエレジー", artistName: "菅田将暉" },
    { rank: 4, name: "Pretender", artistName: "Official髭男dism" },
    { rank: 5, name: "パプリカ", artistName: "Foorin" },
    { rank: 6, name: "シャルル", artistName: "バルーン" },
    { rank: 7, name: "糸", artistName: "中島みゆき" },
    { rank: 8, name: "残酷な天使のテーゼ", artistName: "高橋洋子" },
    { rank: 9, name: "小さな恋のうた", artistName: "MONGOL800" },
    { rank: 10, name: "ハナミズキ", artistName: "一青窈" },
  ],
  2020: [
    { rank: 1, name: "Pretender", artistName: "Official髭男dism" },
    { rank: 2, name: "紅蓮華", artistName: "LiSA" },
    { rank: 3, name: "マリーゴールド", artistName: "あいみょん" },
    { rank: 4, name: "Lemon", artistName: "米津玄師" },
    { rank: 5, name: "白日", artistName: "King Gnu" },
    { rank: 6, name: "夜に駆ける", artistName: "YOASOBI" },
    { rank: 7, name: "さよならエレジー", artistName: "菅田将暉" },
    { rank: 8, name: "香水", artistName: "瑛人" },
    { rank: 9, name: "糸", artistName: "中島みゆき" },
    { rank: 10, name: "まちがいさがし", artistName: "菅田将暉" },
  ],
  2021: [
    { rank: 1, name: "ドライフラワー", artistName: "優里" },
    { rank: 2, name: "猫", artistName: "DISH//" },
    { rank: 3, name: "うっせぇわ", artistName: "Ado" },
    { rank: 4, name: "炎", artistName: "LiSA" },
    { rank: 5, name: "夜に駆ける", artistName: "YOASOBI" },
    { rank: 6, name: "マリーゴールド", artistName: "あいみょん" },
    { rank: 7, name: "魔法の絨毯", artistName: "川崎鷹也" },
    { rank: 8, name: "紅蓮華", artistName: "LiSA" },
    { rank: 9, name: "残酷な天使のテーゼ", artistName: "高橋洋子" },
    { rank: 10, name: "虹", artistName: "菅田将暉" },
  ],
  2022: [
    { rank: 1, name: "ドライフラワー", artistName: "優里" },
    { rank: 2, name: "シンデレラボーイ", artistName: "Saucy Dog" },
    { rank: 3, name: "マリーゴールド", artistName: "あいみょん" },
    { rank: 4, name: "水平線", artistName: "back number" },
    { rank: 5, name: "残酷な天使のテーゼ", artistName: "高橋洋子" },
    { rank: 6, name: "猫", artistName: "DISH//" },
    { rank: 7, name: "ベテルギウス", artistName: "優里" },
    { rank: 8, name: "魔法の絨毯", artistName: "川崎鷹也" },
    { rank: 9, name: "CITRUS", artistName: "Da-iCE" },
    { rank: 10, name: "残響散歌", artistName: "Aimer" },
  ],
  2023: [
    { rank: 1, name: "怪獣の花唄", artistName: "Vaundy" },
    { rank: 2, name: "ドライフラワー", artistName: "優里" },
    { rank: 3, name: "アイドル", artistName: "YOASOBI" },
    { rank: 4, name: "マリーゴールド", artistName: "あいみょん" },
    { rank: 5, name: "シンデレラボーイ", artistName: "Saucy Dog" },
    { rank: 6, name: "残酷な天使のテーゼ", artistName: "高橋洋子" },
    { rank: 7, name: "サウダージ", artistName: "ポルノグラフィティ" },
    { rank: 8, name: "水平線", artistName: "back number" },
    { rank: 9, name: "さよならエレジー", artistName: "菅田将暉" },
    { rank: 10, name: "新時代", artistName: "Ado" },
  ],
  2024: [
    { rank: 1, name: "怪獣の花唄", artistName: "Vaundy" },
    { rank: 2, name: "Bling-Bang-Bang-Born", artistName: "Creepy Nuts" },
    { rank: 3, name: "晩餐歌", artistName: "tuki." },
    { rank: 4, name: "ドライフラワー", artistName: "優里" },
    { rank: 5, name: "マリーゴールド", artistName: "あいみょん" },
    { rank: 6, name: "残酷な天使のテーゼ", artistName: "高橋洋子" },
    { rank: 7, name: "アイドル", artistName: "YOASOBI" },
    { rank: 8, name: "サウダージ", artistName: "ポルノグラフィティ" },
    { rank: 9, name: "さよならエレジー", artistName: "菅田将暉" },
    { rank: 10, name: "ケセラセラ", artistName: "Mrs.GREEN APPLE" },
  ],
  2025: [
    { rank: 1, name: "ライラック", artistName: "Mrs.GREEN APPLE" },
    { rank: 2, name: "怪獣の花唄", artistName: "Vaundy" },
    { rank: 3, name: "残酷な天使のテーゼ", artistName: "高橋洋子" },
    { rank: 4, name: "サウダージ", artistName: "ポルノグラフィティ" },
    { rank: 5, name: "マリーゴールド", artistName: "あいみょん" },
    { rank: 6, name: "さよならエレジー", artistName: "菅田将暉" },
    { rank: 7, name: "ドライフラワー", artistName: "優里" },
    {
      rank: 8,
      name: "かわいいだけじゃだめですか?",
      artistName: "CUTIE STREET",
    },
    { rank: 9, name: "水平線", artistName: "back number" },
    { rank: 10, name: "高嶺の花子さん", artistName: "back number" },
  ],
};

// Newest first, so the year picker defaults to the most recent chart.
export const ORICON_CHART_YEARS: ReadonlyArray<number> = Object.keys(
  ORICON_KARAOKE_CHART,
)
  .map(Number)
  .sort((a, b) => b - a);

export const ORICON_LATEST_YEAR = ORICON_CHART_YEARS[0];

export function oriconChartForYear(
  year: number,
): ReadonlyArray<OriconChartEntry> {
  return ORICON_KARAOKE_CHART[year] || [];
}

export function isOriconChartYear(year: number): boolean {
  return year in ORICON_KARAOKE_CHART;
}

// What to actually search the catalogs for, given a charted title.
//
// Oricon annotates some entries the way its own chart reads rather than the
// way the karaoke catalogs spell them. 2017's "前前前世(movie ver.)" is
// JOYSOUND's "前前前世" and DAM's "前前前世 (movie ver.)" (note the space).
// Searching the annotated string verbatim finds nothing on JOYSOUND, so the
// trailing annotation is dropped: a broader result set is fine here because
// the caller picks the row, whereas an empty one is a dead end.
export function oriconSearchQuery(name: string): string {
  const stripped = name.replace(/[([［（【].*$/, "").trim();
  return stripped.length > 0 ? stripped : name;
}
