import React, { useLayoutEffect, useRef } from "react";

import useQueue from "../../../common/hooks/useQueue";
import useUserIdentity from "../../hooks/useUserIdentity";
import SongQueueItem from "./SongQueueItem";

const SongQueue = () => {
  const queue = useQueue();
  const { nickname } = useUserIdentity();

  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const prevTops = useRef(new Map<string, number>());

  // FLIP: when items change rows (reorders arrive via the queue
  // subscription), slide each one from its previous offset to its new one.
  useLayoutEffect(() => {
    const tops = new Map<string, number>();
    itemRefs.current.forEach((el, key) => tops.set(key, el.offsetTop));

    tops.forEach((top, key) => {
      const el = itemRefs.current.get(key);
      const prevTop = prevTops.current.get(key);
      if (!el || prevTop === undefined || prevTop === top) return;

      el.animate(
        [
          { transform: `translateY(${prevTop - top}px)` },
          { transform: "translateY(0)" },
        ],
        { duration: 300, easing: "ease-in-out" },
      );
    });

    prevTops.current = tops;
  }, [queue]);

  return (
    <div>
      {queue.map(([item, eta], i) => {
        const key = `${item.songId}_${item.timestamp}`;

        return (
          <div
            key={key}
            ref={(el) => {
              if (el) itemRefs.current.set(key, el);
              else itemRefs.current.delete(key);
            }}
          >
            <SongQueueItem
              item={item}
              eta={eta}
              myNickname={nickname}
              canMoveUp={i > 0}
              canMoveDown={i < queue.length - 1}
            />
          </div>
        );
      })}
      {queue.length === 0 && <span>The queue is empty</span>}
    </div>
  );
};

export default SongQueue;
