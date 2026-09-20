// Draws a TelopLayout into a 2D canvas at a given telop time: the phone's
// counterpart of JoysoundRenderer's WebGL draw loop, built on the same
// rasterization code (common/telopLayout.ts), so what it draws is what the TV
// draws, cropped to the part of the screen the lyrics use.
//
// The TV rasterizes every block of the song up front into GPU textures. That's
// 100MB+ at 1080p, which a phone's canvas budget won't carry, so this keeps
// only the blocks on screen or about to be, and lets the rest go.

import {
  BREAK_NOTICE_HEIGHT,
  BREAK_Y_FRACTION,
  drawBreakNoticeStrip,
  drawLyricsBlockImage,
  drawTitleCard,
  getActiveBreakNoticeIndex,
  getLyricsBlockWidth,
  getPlacedLyricsBlockRect,
  getScrollXPos,
  getTelopLyricsBounds,
  placeLyricsBlockX,
  placeTelopRows,
  TelopLayout,
  TelopRaster,
  TelopRect,
  TelopRowPlacement,
  TELOP_SCREEN_HEIGHT,
  TELOP_SCREEN_WIDTH,
} from "../../../common/telopLayout";
import { TELOP_JP_FONT, TELOP_KR_FONT } from "../../telopFonts";

// A block is rasterized this long before it fades in, so it's ready the frame
// it's needed rather than costing that frame a few ms of text drawing.
const PREFETCH_MS = 2500;
// ...and kept this long after it fades out, so a small seek back doesn't
// re-rasterize it.
const RETAIN_MS = 1000;
// At most this many blocks rasterized ahead of need per frame. Blocks already
// on screen are always drawn, whatever this says.
const PREFETCH_PER_FRAME = 1;

interface BlockImages {
  pre: HTMLCanvasElement;
  post: HTMLCanvasElement;
}

function newCanvasContext(): CanvasRenderingContext2D {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  return ctx;
}

// Canvases hold their backing store until collected, and iOS caps total canvas
// memory per page; zeroing the size hands it back now.
function release(canvas: HTMLCanvasElement) {
  canvas.width = 0;
  canvas.height = 0;
}

export default class TelopPainter {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly layout: TelopLayout;
  // Where each row sits on a surface with nothing else on it, exactly as the
  // TV places them with no piano roll: with both reading guides on, the rows
  // spread apart so one line's bottom guide clears the next line's furigana.
  private readonly placement: TelopRowPlacement;
  // The part of the telop screen shown: the lyrics' bounding box.
  readonly crop: TelopRect;

  // Device pixels per telop unit, and where telop (0, 0) lands.
  private scale = 1;
  private originX = 0;
  private originY = 0;
  private raster: TelopRaster = {
    rate: 1,
    x: 1,
    y: 1,
    jpFont: TELOP_JP_FONT,
    krFont: TELOP_KR_FONT,
  };
  // The raster lyrics blocks are drawn at: `raster` times the placement's
  // scale, so a block that had to shrink to fit is rasterized at the size it
  // is drawn rather than drawn scaled.
  private blockRaster: TelopRaster = this.raster;

  private blocks = new Map<number, BlockImages>();
  private title: HTMLCanvasElement | null = null;
  private breakNotice: { index: number; canvas: HTMLCanvasElement } | null =
    null;

  constructor(canvas: HTMLCanvasElement, layout: TelopLayout) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
    this.layout = layout;
    this.placement = placeTelopRows(layout, 0);
    this.crop = getTelopLyricsBounds(layout);
  }

  // Sizes the backing store to the element's CSS box and fits the crop into
  // it, centered. Everything rasterized at the old size is dropped.
  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number) {
    const canvas = this.ctx.canvas;
    canvas.width = Math.max(1, Math.round(cssWidth * devicePixelRatio));
    canvas.height = Math.max(1, Math.round(cssHeight * devicePixelRatio));

    this.scale = Math.min(
      canvas.width / this.crop.width,
      canvas.height / this.crop.height,
    );
    this.originX =
      (canvas.width - this.crop.width * this.scale) / 2 -
      this.crop.left * this.scale;
    this.originY =
      (canvas.height - this.crop.height * this.scale) / 2 -
      this.crop.top * this.scale;
    this.raster = {
      ...this.raster,
      rate: this.scale,
      x: this.scale,
      y: this.scale,
    };
    const blockScale = this.scale * this.placement.scale;
    this.blockRaster = {
      ...this.raster,
      rate: blockScale,
      x: blockScale,
      y: blockScale,
    };

    this.invalidate();
  }

  // Drops every rasterized image, e.g. once the real font has loaded and the
  // fallback-font images are wrong.
  invalidate() {
    this.blocks.forEach(({ pre, post }) => {
      release(pre);
      release(post);
    });
    this.blocks.clear();
    if (this.title) release(this.title);
    this.title = null;
    if (this.breakNotice) release(this.breakNotice.canvas);
    this.breakNotice = null;
  }

  dispose() {
    this.invalidate();
  }

  // Draws the frame for telop time `refreshTime` (the media clock plus
  // TELOP_TIMING_OFFSET_MS, exactly what the TV's draw loop computes), or a
  // blank frame when the time isn't known.
  paint(refreshTime: number | null) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    if (refreshTime === null) {
      return;
    }

    this.paintTitle(refreshTime);

    const blocks = this.layout.blocks;
    let prefetchBudget = PREFETCH_PER_FRAME;

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];

      // Never on screen (see getTelopLyricsBounds); without this it would be
      // prefetched and evicted over and over before its would-be fade-in.
      if (block.fadeoutTime <= block.fadeinTime) {
        continue;
      }

      if (refreshTime >= block.fadeinTime && refreshTime < block.fadeoutTime) {
        this.paintBlock(i, refreshTime);
      } else if (
        refreshTime >= block.fadeinTime - PREFETCH_MS &&
        refreshTime < block.fadeinTime
      ) {
        if (!this.blocks.has(i) && prefetchBudget > 0) {
          prefetchBudget--;
          this.blockImages(i);
        }
      } else if (
        this.blocks.has(i) &&
        (refreshTime >= block.fadeoutTime + RETAIN_MS ||
          refreshTime < block.fadeinTime - PREFETCH_MS)
      ) {
        const images = this.blocks.get(i)!;
        release(images.pre);
        release(images.post);
        this.blocks.delete(i);
      }
    }

    this.paintBreakNotice(refreshTime);
  }

  private toDeviceX(x: number) {
    return this.originX + x * this.scale;
  }

  private toDeviceY(y: number) {
    return this.originY + y * this.scale;
  }

  private blockImages(index: number): BlockImages {
    const cached = this.blocks.get(index);
    if (cached) return cached;

    const block = this.layout.blocks[index];
    const pre = newCanvasContext();
    const post = newCanvasContext();
    drawLyricsBlockImage(
      pre,
      this.blockRaster,
      block,
      block.preFill,
      block.preBorder,
      this.layout.annotations,
    );
    drawLyricsBlockImage(
      post,
      this.blockRaster,
      block,
      block.postFill,
      block.postBorder,
      this.layout.annotations,
    );

    const images = { pre: pre.canvas, post: post.canvas };
    this.blocks.set(index, images);
    return images;
  }

  // The TV's shader draws the pre-colored texture where x > the wipe and the
  // post-colored one where x <= it; two clips do the same here. The images go
  // down 1:1 on whole device pixels (the TV stretches its textures by a
  // sub-pixel remainder; at phone sizes that just blurs the text), at the
  // block's placed rect, with the wipe through the same placement.
  private paintBlock(index: number, refreshTime: number) {
    const ctx = this.ctx;
    const block = this.layout.blocks[index];
    const { pre, post } = this.blockImages(index);
    const rect = getPlacedLyricsBlockRect(
      block,
      this.layout.annotations,
      this.placement,
    );

    const dx = Math.round(this.toDeviceX(rect.left));
    const dy = Math.round(this.toDeviceY(rect.top));
    const scrollXPos = Math.floor(getScrollXPos(block, refreshTime));
    const wipeX = Math.round(
      this.toDeviceX(placeLyricsBlockX(block, this.placement, scrollXPos)),
    );

    if (scrollXPos <= block.xPos + getLyricsBlockWidth(block)) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(wipeX, dy, dx + pre.width - wipeX, pre.height);
      ctx.clip();
      ctx.drawImage(pre, dx, dy);
      ctx.restore();
    }

    if (scrollXPos >= block.xPos) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(dx, dy, wipeX - dx, post.height);
      ctx.clip();
      ctx.drawImage(post, dx, dy);
      ctx.restore();
    }
  }

  // The title card covers the whole telop screen on the TV, more than the
  // crop shows, so here it's scaled down to fit inside the crop instead.
  private paintTitle(refreshTime: number) {
    if (refreshTime >= this.layout.title.fadeoutTime) {
      if (this.title) {
        release(this.title);
        this.title = null;
      }
      return;
    }

    const fit = Math.min(
      this.crop.width / TELOP_SCREEN_WIDTH,
      this.crop.height / TELOP_SCREEN_HEIGHT,
    );

    if (!this.title) {
      const titleCtx = newCanvasContext();
      const rate = this.scale * fit;
      drawTitleCard(
        titleCtx,
        { ...this.raster, rate, x: rate, y: rate },
        this.layout.title,
        this.layout.annotations,
      );
      this.title = titleCtx.canvas;
    }

    const dx =
      this.toDeviceX(this.crop.left) +
      (this.crop.width * this.scale - this.title.width) / 2;
    const dy =
      this.toDeviceY(this.crop.top) +
      (this.crop.height * this.scale - this.title.height) / 2;
    this.ctx.drawImage(this.title, Math.round(dx), Math.round(dy));
  }

  // Where the TV puts the notice when there's no piano roll (this surface
  // has none), pulled up if that would hang off the bottom of the crop.
  private paintBreakNotice(refreshTime: number) {
    const index = getActiveBreakNoticeIndex(this.layout.breaks, refreshTime);

    if (index < 0) {
      if (this.breakNotice) {
        release(this.breakNotice.canvas);
        this.breakNotice = null;
      }
      return;
    }

    if (!this.breakNotice || this.breakNotice.index !== index) {
      if (this.breakNotice) release(this.breakNotice.canvas);
      const noticeCtx = newCanvasContext();
      drawBreakNoticeStrip(
        noticeCtx,
        this.raster,
        this.layout.breaks[index].approxDurationSecs,
      );
      this.breakNotice = { index, canvas: noticeCtx.canvas };
    }

    const yPos = Math.min(
      TELOP_SCREEN_HEIGHT * BREAK_Y_FRACTION,
      this.crop.top + this.crop.height - BREAK_NOTICE_HEIGHT,
    );
    this.ctx.drawImage(
      this.breakNotice.canvas,
      Math.round(this.toDeviceX(0)),
      Math.round(this.toDeviceY(yPos)),
    );
  }
}
