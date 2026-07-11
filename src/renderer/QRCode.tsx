import { toCanvas } from "qrcode";
import React, { useEffect, useRef } from "react";

import "./QRCode.css";

function QRCode(props: { hostname: string; inverted?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    function update() {
      if (!canvasRef.current) return;

      canvasRef.current.style.width = "100%";
      toCanvas(
        canvasRef.current,
        `http://${props.hostname}`,
        {
          errorCorrectionLevel: "L",
          width: canvasRef.current.clientWidth,
          color: props.inverted
            ? { dark: "#ffffff", light: "#000000" }
            : undefined,
        },
        (error) => {
          if (error) {
            console.error(error);
          }
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
