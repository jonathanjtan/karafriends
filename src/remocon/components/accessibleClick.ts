import React from "react";

interface AccessibleClickOptions {
  // Accessible name for a control whose only content is an icon. Omit it
  // when the element already has visible text, which screen readers read as
  // its name.
  ariaLabel?: string;
  // Mirrors a CSS-only "pointer-events: none" disabled state: takes the
  // control out of the tab order and stops Enter/Space from activating it,
  // the same way that CSS already stops a pointer click.
  disabled?: boolean;
}

// Spreads onto an icon-only `<div onClick>` control to make it operable from
// the keyboard without turning it into a `<button>` (native button chrome
// would change the layout). Adds the button role and a tab stop, and forwards
// Enter and Space to the same handler a pointer click uses; Space's default
// scroll is prevented.
export default function accessibleClick(
  onActivate: () => void,
  options: AccessibleClickOptions = {},
) {
  const { ariaLabel, disabled = false } = options;

  return {
    role: "button" as const,
    tabIndex: disabled ? -1 : 0,
    "aria-label": ariaLabel,
    onClick: disabled ? undefined : onActivate,
    onKeyDown: disabled
      ? undefined
      : (e: React.KeyboardEvent) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          if (e.key === " ") e.preventDefault();
          onActivate();
        },
  };
}
