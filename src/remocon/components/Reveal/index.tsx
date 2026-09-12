import classnames from "classnames";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

import * as styles from "./Reveal.module.scss";

// Keep in sync with the transition duration in Reveal.module.scss.
const TRANSITION_MS = 260;

interface Props {
  open: boolean;
  className?: string;
  children: React.ReactNode;
}

// An in-flow panel that grows into place instead of appearing. Its sibling
// Collapse is for drawers that overlay the page and must not move it; this one
// is for content that genuinely takes up room (the control bar's lyrics
// panel), so the room it takes has to arrive and leave over the same 260ms as
// the panel itself.
//
// The height comes from an `0fr` -> `1fr` grid row rather than a measured pixel
// height, so nothing has to observe the content: whatever it ends up being
// (the lyrics band's aspect ratio depends on the song) is what it animates to.
// A browser that won't interpolate that just snaps, which is what this
// replaces, so the fallback is the old behaviour rather than a broken one.
//
// Children unmount while closed, same as Collapse and for the same reason:
// a hidden panel must not hold subscriptions open. Closing unmounts on a
// duration-matched timeout rather than transitionend, which a throttled or
// hidden tab can swallow.
const Reveal = ({ open, className, children }: Props) => {
  const [rendered, setRendered] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setRendered(true);
      return;
    }
    setExpanded(false);
    const timeout = setTimeout(() => setRendered(false), TRANSITION_MS);
    return () => clearTimeout(timeout);
  }, [open]);

  // Force a synchronous style flush so the browser registers the collapsed
  // start state before the open class lands; without it the transition has no
  // start point and the panel snaps open. See Collapse for why rAF is not a
  // reliable substitute here.
  useLayoutEffect(() => {
    if (!open || !rendered || !ref.current) return;
    ref.current.getBoundingClientRect();
    setExpanded(true);
  }, [open, rendered]);

  if (!rendered) return null;

  return (
    <div
      ref={ref}
      className={classnames(
        styles.reveal,
        { [styles.open]: expanded },
        className,
      )}
    >
      <div className={styles.inner}>{children}</div>
    </div>
  );
};

export default Reveal;
