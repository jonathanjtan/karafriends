import { toCanvas } from "qrcode";
import React, { useEffect, useRef } from "react";

// tslint:disable-next-line:no-submodule-imports no-implicit-dependencies
import logoSrc from "url:./images/icon.png";
import "./QRCode.css";

// Fraction of the QR code's width the centered logo (and its quiet-zone
// backing square) occupies. Kept well under errorCorrectionLevel "H"'s ~30%
// data-recovery budget so covering the center doesn't break scanning.
const LOGO_FRACTION = 0.22;
const LOGO_PADDING_FRACTION = 0.18;

const logo = new Image();
logo.src = logoSrc;
const logoLoaded = new Promise<void>((resolve) => {
  if (logo.complete) {
    resolve();
  } else {
    logo.addEventListener("load", () => resolve(), { once: true });
  }
});

function QRCode(props: {
  hostname: string;
  inverted?: boolean;
  oledFriendly?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    function drawLogo() {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;

      const size = canvas.width;
      const logoSize = size * LOGO_FRACTION;
      const padding = logoSize * LOGO_PADDING_FRACTION;
      const x = (size - logoSize) / 2;
      const y = (size - logoSize) / 2;

      // The logo PNG is a circle on a transparent background — fill a
      // quiet-zone square behind it first so no QR modules show through
      // the corners, matching each variant's module background color.
      ctx.fillStyle = props.inverted ? "#000000" : "#ffffff";
      ctx.fillRect(
        x - padding,
        y - padding,
        logoSize + padding * 2,
        logoSize + padding * 2,
      );

      // html.oledFriendly applies `filter: invert(1) hue-rotate(180deg)` to
      // the whole sidebar. That combo is a no-op for achromatic QR modules
      // (invert alone round-trips black/white) but NOT for the logo's
      // non-fully-saturated blue (28,179,255) — hue-rotate(180) preserves
      // saturation/lightness while only rotating hue, so a color that isn't
      // already at 50% lightness/100% saturation comes out darker. The
      // filter is an involution (applying it twice is identity), so
      // pre-applying it here cancels the CSS filter and the logo renders at
      // its true color either way.
      if (props.oledFriendly) {
        ctx.filter = "invert(1) hue-rotate(180deg)";
        ctx.drawImage(logo, x, y, logoSize, logoSize);
        ctx.filter = "none";
      } else {
        ctx.drawImage(logo, x, y, logoSize, logoSize);
      }
    }

    function update() {
      if (!canvasRef.current) return;
      // The hostname is a synced setting now, so it's empty for the first
      // frame or two after a window opens. Encoding "http://" would render a
      // scannable-but-useless code, so wait for the real value.
      if (props.hostname === "") return;

      canvasRef.current.style.width = "100%";
      toCanvas(
        canvasRef.current,
        `http://${props.hostname}`,
        {
          errorCorrectionLevel: "H",
          width: canvasRef.current.clientWidth,
          color: props.inverted
            ? { dark: "#ffffff", light: "#000000" }
            : undefined,
        },
        (error) => {
          if (error) {
            console.error(error);
            return;
          }
          logoLoaded.then(drawLogo);
        },
      );
    }

    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  });

  return <canvas ref={canvasRef} className="qrcode" />;
}

export default QRCode;
