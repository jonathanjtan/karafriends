attribute vec2 position;
// position.x will range from 0 to song end timestamp

uniform float time;
uniform float timeWidth;
uniform float cursorFraction;

void main() {
  // Continuous right-to-left scroll: the current playback time stays pinned
  // at cursorFraction of the canvas width, and notes flow past it.
  gl_Position = vec4(((position.x - time) / timeWidth + cursorFraction) * 2.0 - 1.0, position.y * 2.0 - 1.0, 0.0, 1.0);
}
