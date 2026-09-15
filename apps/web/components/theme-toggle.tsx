"use client";

import { useEffect, useState } from "react";
import { buttonVariants } from "@jetmarket/ui";

const KEY = "jm-theme";

/** Dark-mode toggle: `dark` class on <html>, persisted in localStorage. */
export function ThemeToggle({ label }: { label: string }) {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(KEY);
    const prefers = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const on = stored ? stored === "dark" : prefers;
    document.documentElement.classList.toggle("dark", on);
    setDark(on);
  }, []);

  return (
    <button
      type="button"
      data-testid="theme-toggle"
      aria-pressed={dark}
      title={label}
      className={buttonVariants({ variant: "ghost", size: "sm" })}
      onClick={() => {
        const next = !dark;
        setDark(next);
        document.documentElement.classList.toggle("dark", next);
        localStorage.setItem(KEY, next ? "dark" : "light");
      }}
    >
      {dark ? "☾" : "☀"}
    </button>
  );
}
