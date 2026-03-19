export const ThemeId = {
  Claude: 'claude',
  CatppuccinMocha: 'catppuccin-mocha',
  Nord: 'nord',
  SolarizedDark: 'solarized-dark',
  Dracula: 'dracula',
  GruvboxDark: 'gruvbox-dark',
  SolarizedLight: 'solarized-light',
  GithubLight: 'github-light',
  GruvboxLight: 'gruvbox-light',
} as const;
export type ThemeId = (typeof ThemeId)[keyof typeof ThemeId];

export const ThemeGroup = {
  Dark: 'dark',
  Light: 'light',
} as const;
export type ThemeGroup = (typeof ThemeGroup)[keyof typeof ThemeGroup];

export interface ThemeColors {
  bgBase: string;
  bgSurface: string;
  bgOverlay: string;
  bgMuted: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentHover: string;
  green: string;
  red: string;
  yellow: string;
  border: string;
  scrollbarBg: string;
  scrollbarThumb: string;
}

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  group: ThemeGroup;
  colors: ThemeColors;
}

const CLAUDE: ThemeColors = {
  bgBase: '#252525',
  bgSurface: '#2F2F2F',
  bgOverlay: '#383838',
  bgMuted: '#444444',
  textPrimary: '#E8E4E0',
  textSecondary: '#ADA8A3',
  textMuted: '#706C68',
  accent: '#C47B5C',
  accentHover: '#D4895C',
  green: '#7DB88A',
  red: '#C96B6B',
  yellow: '#C9A96B',
  border: '#363636',
  scrollbarBg: '#252525',
  scrollbarThumb: '#444444',
};

const CATPPUCCIN_MOCHA: ThemeColors = {
  bgBase: '#1e1e2e',
  bgSurface: '#181825',
  bgOverlay: '#313244',
  bgMuted: '#45475a',
  textPrimary: '#cdd6f4',
  textSecondary: '#a6adc8',
  textMuted: '#585b70',
  accent: '#89b4fa',
  accentHover: '#74c7ec',
  green: '#a6e3a1',
  red: '#f38ba8',
  yellow: '#f9e2af',
  border: '#313244',
  scrollbarBg: '#181825',
  scrollbarThumb: '#45475a',
};

const NORD: ThemeColors = {
  bgBase: '#2E3440',
  bgSurface: '#272C36',
  bgOverlay: '#3B4252',
  bgMuted: '#4C566A',
  textPrimary: '#ECEFF4',
  textSecondary: '#D8DEE9',
  textMuted: '#616E88',
  accent: '#88C0D0',
  accentHover: '#8FBCBB',
  green: '#A3BE8C',
  red: '#BF616A',
  yellow: '#EBCB8B',
  border: '#3B4252',
  scrollbarBg: '#272C36',
  scrollbarThumb: '#4C566A',
};

const SOLARIZED_DARK: ThemeColors = {
  bgBase: '#002B36',
  bgSurface: '#073642',
  bgOverlay: '#094959',
  bgMuted: '#586E75',
  textPrimary: '#839496',
  textSecondary: '#93A1A1',
  textMuted: '#586E75',
  accent: '#268BD2',
  accentHover: '#2AA198',
  green: '#859900',
  red: '#DC322F',
  yellow: '#B58900',
  border: '#073642',
  scrollbarBg: '#002B36',
  scrollbarThumb: '#586E75',
};

const DRACULA: ThemeColors = {
  bgBase: '#282A36',
  bgSurface: '#21222C',
  bgOverlay: '#44475A',
  bgMuted: '#6272A4',
  textPrimary: '#F8F8F2',
  textSecondary: '#BFBFBF',
  textMuted: '#6272A4',
  accent: '#BD93F9',
  accentHover: '#FF79C6',
  green: '#50FA7B',
  red: '#FF5555',
  yellow: '#F1FA8C',
  border: '#44475A',
  scrollbarBg: '#21222C',
  scrollbarThumb: '#6272A4',
};

const GRUVBOX_DARK: ThemeColors = {
  bgBase: '#282828',
  bgSurface: '#1D2021',
  bgOverlay: '#3C3836',
  bgMuted: '#504945',
  textPrimary: '#EBDBB2',
  textSecondary: '#D5C4A1',
  textMuted: '#665C54',
  accent: '#83A598',
  accentHover: '#8EC07C',
  green: '#B8BB26',
  red: '#FB4934',
  yellow: '#FABD2F',
  border: '#3C3836',
  scrollbarBg: '#1D2021',
  scrollbarThumb: '#504945',
};

const SOLARIZED_LIGHT: ThemeColors = {
  bgBase: '#FDF6E3',
  bgSurface: '#EEE8D5',
  bgOverlay: '#DDD6C1',
  bgMuted: '#93A1A1',
  textPrimary: '#657B83',
  textSecondary: '#586E75',
  textMuted: '#93A1A1',
  accent: '#268BD2',
  accentHover: '#2AA198',
  green: '#859900',
  red: '#DC322F',
  yellow: '#B58900',
  border: '#D3CBB8',
  scrollbarBg: '#EEE8D5',
  scrollbarThumb: '#93A1A1',
};

const GITHUB_LIGHT: ThemeColors = {
  bgBase: '#FFFFFF',
  bgSurface: '#F6F8FA',
  bgOverlay: '#E1E4E8',
  bgMuted: '#D1D5DA',
  textPrimary: '#24292E',
  textSecondary: '#586069',
  textMuted: '#959DA5',
  accent: '#0366D6',
  accentHover: '#0451A5',
  green: '#28A745',
  red: '#D73A49',
  yellow: '#E36209',
  border: '#E1E4E8',
  scrollbarBg: '#F6F8FA',
  scrollbarThumb: '#D1D5DA',
};

const GRUVBOX_LIGHT: ThemeColors = {
  bgBase: '#FBF1C7',
  bgSurface: '#EBDBB2',
  bgOverlay: '#D5C4A1',
  bgMuted: '#BDAE93',
  textPrimary: '#3C3836',
  textSecondary: '#504945',
  textMuted: '#928374',
  accent: '#427B58',
  accentHover: '#689D6A',
  green: '#79740E',
  red: '#CC241D',
  yellow: '#D79921',
  border: '#D5C4A1',
  scrollbarBg: '#EBDBB2',
  scrollbarThumb: '#BDAE93',
};

export const THEMES: readonly ThemeMeta[] = [
  { id: ThemeId.Claude, label: 'Claude', group: ThemeGroup.Dark, colors: CLAUDE },
  { id: ThemeId.CatppuccinMocha, label: 'Catppuccin Mocha', group: ThemeGroup.Dark, colors: CATPPUCCIN_MOCHA },
  { id: ThemeId.Nord, label: 'Nord', group: ThemeGroup.Dark, colors: NORD },
  { id: ThemeId.SolarizedDark, label: 'Solarized Dark', group: ThemeGroup.Dark, colors: SOLARIZED_DARK },
  { id: ThemeId.Dracula, label: 'Dracula', group: ThemeGroup.Dark, colors: DRACULA },
  { id: ThemeId.GruvboxDark, label: 'Gruvbox Dark', group: ThemeGroup.Dark, colors: GRUVBOX_DARK },
  { id: ThemeId.SolarizedLight, label: 'Solarized Light', group: ThemeGroup.Light, colors: SOLARIZED_LIGHT },
  { id: ThemeId.GithubLight, label: 'GitHub Light', group: ThemeGroup.Light, colors: GITHUB_LIGHT },
  { id: ThemeId.GruvboxLight, label: 'Gruvbox Light', group: ThemeGroup.Light, colors: GRUVBOX_LIGHT },
] as const;

export const DEFAULT_THEME_ID: ThemeId = ThemeId.Claude;

export function findTheme(id: ThemeId): ThemeMeta | undefined {
  return THEMES.find((t) => t.id === id);
}
