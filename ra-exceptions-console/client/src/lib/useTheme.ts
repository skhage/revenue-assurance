import { useEffect, useState, useCallback } from 'react';

type Theme = 'light' | 'dark';

function apply(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
}

function initial(): Theme {
  try {
    const saved = localStorage.getItem('ra-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* storage may be unavailable */
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Class-based theme toggle (Tailwind darkMode: ['class','media']), persisted per viewer. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(initial);

  useEffect(() => {
    apply(theme);
    try {
      localStorage.setItem('ra-theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);
  return { theme, toggle };
}
