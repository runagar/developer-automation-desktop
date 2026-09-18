import { ITheme } from '@xterm/xterm';

export const DEFAULT_THEME_ID = 'phosphor-green';

/** Pre-rename theme ids still found in `dad-theme`; mirrors SettingsMenu's migration map. */
const THEME_ALIASES: Record<string, string> = {
  'pipboy-3000':  'phosphor-green',
  'pipboy-3000a': 'amber-orange',
};

export const XTERM_THEMES: Record<string, ITheme> = {
  'phosphor-green': {
    background:          '#000000',
    foreground:          '#00ff00',
    cursor:              '#00ff00',
    cursorAccent:        '#000000',
    selectionBackground:         'rgba(0, 255, 0, 0.4)',
    selectionInactiveBackground: 'rgba(0, 255, 0, 0.4)',
    selectionForeground:         '#006600',
    black:               '#000000',
    red:                 '#ff4444',
    green:               '#00ff00',
    yellow:              '#ffff00',
    blue:                '#4488ff',
    magenta:             '#ff44ff',
    cyan:                '#00ffff',
    white:               '#00cc00',
    brightBlack:         '#00aa00',
    brightRed:           '#ff6666',
    brightGreen:         '#66ff66',
    brightYellow:        '#ffff66',
    brightBlue:          '#6699ff',
    brightMagenta:       '#ff66ff',
    brightCyan:          '#66ffff',
    brightWhite:         '#00ff00',
  },
  'amber-orange': {
    background:          '#000000',
    foreground:          '#ff9f1c',
    cursor:              '#ff9f1c',
    cursorAccent:        '#000000',
    selectionBackground:         'rgba(255, 159, 28, 0.4)',
    selectionInactiveBackground: 'rgba(255, 159, 28, 0.4)',
    selectionForeground:         '#7a4e00',
    black:               '#000000',
    red:                 '#ff4444',
    green:               '#00cc44',
    yellow:              '#ffdd00',
    blue:                '#4488ff',
    magenta:             '#ff44ff',
    cyan:                '#00cccc',
    white:               '#cc8000',
    brightBlack:         '#aa6b00',
    brightRed:           '#ff6666',
    brightGreen:         '#44ee66',
    brightYellow:        '#ffee44',
    brightBlue:          '#6699ff',
    brightMagenta:       '#ff66ff',
    brightCyan:          '#44dddd',
    brightWhite:         '#ff9f1c',
  },
};

export function getXtermThemeById(themeId: string | null | undefined): ITheme {
  const id = themeId ?? DEFAULT_THEME_ID;
  return XTERM_THEMES[THEME_ALIASES[id] ?? id] ?? XTERM_THEMES[DEFAULT_THEME_ID];
}

export function getXtermTheme(): ITheme {
  return getXtermThemeById(document.documentElement.getAttribute('data-theme'));
}
