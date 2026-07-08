precision highp float;
uniform float canvasWidth;
uniform float cursorFraction;

void main() {
  if (gl_FragCoord.x / canvasWidth < cursorFraction) {
    gl_FragColor = vec4(0.0, 1.0, 0.0, 1.0);
  } else {
    gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
  }
}
