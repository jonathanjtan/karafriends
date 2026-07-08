attribute vec2 position;
// position is a thin full-height quad in clip space centered on x = -1

uniform float cursorFraction;

void main() {
  // The "now" cursor is fixed at cursorFraction of the canvas width;
  // the notes scroll past it instead of the cursor sweeping across.
  gl_Position = vec4(position.x + cursorFraction * 2.0, position.y, 0.0, 1.0);
}
