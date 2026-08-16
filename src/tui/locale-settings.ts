/**
 * The terminal surface's own settings namespace: the interface language. The
 * runner registers it on the settings seam, so `/lang` and the settings view
 * edit the same durable `tui.locale` value, and `$DSH_TUI_LANG` only supplies
 * the composition default.
 * @module dsh-tui-plugin/locale-settings
 */

import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { TuiLocaleName } from './i18n.ts'

/** The settings namespace the terminal surface owns. */
export const TUI_LOCALE_NS = settingsNamespace('tui')

/** The namespace value: the active interface language. */
export interface TuiLocaleSettings {
  /** Interface language; `zh` shows the Chinese copy, everything else English. */
  locale: TuiLocaleName
}

/** The validated schema doubling as the settings-section shape. */
export const TuiLocaleSettings: z<TuiLocaleSettings> = z.object({
  locale: z.union([z.const('en'), z.const('zh')]).default('en'),
})
