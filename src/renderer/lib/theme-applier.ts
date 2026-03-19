import { findTheme, DEFAULT_THEME_ID, type ThemeId, type ThemeColors } from '../../core/themes';

const CSS_VAR_MAP: Record<keyof ThemeColors, string> = {
  bgBase: '--color-bg',
  bgSurface: '--color-surface',
  bgOverlay: '--color-overlay',
  bgMuted: '--color-active',
  textPrimary: '--color-text',
  textSecondary: '--color-text-muted',
  textMuted: '--color-gray',
  accent: '--color-blue',
  accentHover: '--color-accent-hover',
  green: '--color-green',
  red: '--color-red',
  yellow: '--color-yellow',
  border: '--color-border',
  scrollbarBg: '--scrollbar-bg',
  scrollbarThumb: '--scrollbar-thumb',
};

export function applyTheme(themeId: ThemeId): void {
  const theme = findTheme(themeId) ?? findTheme(DEFAULT_THEME_ID);
  if (!theme) return;

  const root = document.documentElement;
  for (const [key, cssVar] of Object.entries(CSS_VAR_MAP)) {
    root.style.setProperty(cssVar, theme.colors[key as keyof ThemeColors]);
  }

  root.style.setProperty('--color-hover', theme.colors.bgOverlay);
}
