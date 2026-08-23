import React from "react";

import classnames from "classnames";

import * as styles from "./Slider.module.scss";

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & {
  min: number;
  max: number;
  value: number;
};

// The filled half is drawn by the stylesheet from a gradient stop, so the
// position has to reach CSS as a custom property.
const Slider = ({ className, min, max, value, style, ...rest }: Props) => {
  const span = max - min;
  const pct = span > 0 ? ((value - min) / span) * 100 : 0;

  return (
    <input
      type="range"
      className={classnames(styles.slider, className)}
      min={min}
      max={max}
      value={value}
      style={{
        ...style,
        ["--pct" as string]: `${Math.min(100, Math.max(0, pct))}%`,
      }}
      {...rest}
    />
  );
};

export default Slider;
