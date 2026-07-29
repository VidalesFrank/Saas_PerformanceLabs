import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const EVENT = "pl-theme-change";

function readTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = localStorage.getItem("pl-theme");
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: Theme) {
  if (theme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  try { localStorage.setItem("pl-theme", theme); } catch {}
  window.dispatchEvent(new CustomEvent(EVENT, { detail: theme }));
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    setTheme(readTheme());
    const handler = (e: Event) => setTheme((e as CustomEvent<Theme>).detail);
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      applyTheme(next);
      return next;
    });
  }, []);

  return { theme, toggle };
}
