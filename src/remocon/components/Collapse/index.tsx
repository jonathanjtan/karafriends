import classnames from "classnames";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

import * as styles from "./Collapse.module.scss";

// Keep in sync with the transition duration in Collapse.module.scss.
const TRANSITION_MS = 350;

interface Props {
  open: boolean;
  // Which way the drawer slides in: "down" drops from the top edge (e.g. the
  // settings panel under the nav bar), "up" rises from the bottom edge (e.g.
  // the queue above the control bar).
  direction: "down" | "up";
  // Positions the clipping wrapper (typically position: fixed). The drawer
  // overlays the page instead of pushing content around.
  className: string;
  children: React.ReactNode;
}

// Animated drawer that still unmounts its children while closed (so hidden
// panels don't fire queries or subscriptions). Opening mounts off-screen,
// then slides in on the next frame; closing slides out and unmounts on a
// duration-matched timeout (not transitionend, which can be swallowed by
// throttled/hidden tabs and would leave the children mounted forever).
const Collapse = ({ open, direction, className, children }: Props) => {
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

  // Once the drawer is mounted, force a synchronous style flush so the
  // browser registers the off-screen transform before the open class lands.
  // Otherwise the transition has no start point and the drawer snaps open.
  // (rAF-based deferral is not reliable for this: depending on where in the
  // frame cycle the triggering click lands, the callbacks can coalesce into
  // the same paint and skip the animation.)
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
        styles.collapse,
        styles[direction],
        { [styles.open]: expanded },
        className,
      )}
    >
      <div className={styles.inner}>{children}</div>
    </div>
  );
};

export default Collapse;
