import { useEffect, useState } from "react";

const ELLIPSIS_INTERVAL_MS = 400;
const MAX_DOTS = 3;

// Terminal/static states (errors, ETAs, percentages that already convey
// motion on their own) shouldn't get the animated ellipsis - only the
// "something is happening, no other feedback yet" states should.
function isProcessing(text: string, defaultText: string): boolean {
  return (
    text !== defaultText &&
    !text.startsWith("Error") &&
    !text.includes("%") &&
    text !== "Finished Downloading" &&
    !text.startsWith("Estimated wait")
  );
}

export default function useProcessingLabel(text: string, defaultText: string) {
  const processing = isProcessing(text, defaultText);
  const [dots, setDots] = useState("");

  useEffect(() => {
    if (!processing) {
      setDots("");
      return;
    }

    const intervalId = window.setInterval(() => {
      setDots((prev) => (prev.length >= MAX_DOTS ? "" : prev + "."));
    }, ELLIPSIS_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [processing]);

  return { processing, displayText: processing ? `${text}${dots}` : text };
}
