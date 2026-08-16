/**
 * TUI copy: default English, `DSH_TUI_LANG=zh` switches to Chinese, unknown
 * keys fall through to the key itself.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { localeName, resetLocale, t } from '../src/tui/i18n.ts'

afterEach(() => {
  process.env.DSH_TUI_LANG = ''
  resetLocale()
})

describe('i18n', () => {
  it('defaults to English', () => {
    expect(localeName()).toBe('en')
    expect(t('welcome.title')).toContain('dshcli')
    expect(t('approval.title')).toBe('Approval required')
  })

  it('switches to Chinese from DSH_TUI_LANG', () => {
    process.env.DSH_TUI_LANG = 'zh'
    resetLocale()
    expect(localeName()).toBe('zh')
    expect(t('welcome.start')).toContain('输入消息')
    expect(t('approval.title')).toBe('需要审批')
    expect(t('help.line.scrollPg')).toContain('PgUp')
  })

  it('falls back to the key for an unknown entry', () => {
    expect(t('no.such.key')).toBe('no.such.key')
  })

  it('interpolates placeholders from the values record', () => {
    expect(t('command.unknown', { line: '/zzz' })).toBe('Unknown command: /zzz')
    expect(t('jobs.killed', { id: 'j1', result: 'requested' })).toBe('Job j1: requested')
  })

  it('keeps placeholders verbatim when a value is missing', () => {
    expect(t('command.unknown')).toBe('Unknown command: {line}')
    expect(t('command.unknown', {})).toBe('Unknown command: {line}')
    expect(t('command.unknown', { other: 'x' })).toBe('Unknown command: {line}')
  })

  it('interpolates Chinese copy the same way', () => {
    process.env.DSH_TUI_LANG = 'zh'
    resetLocale()
    expect(t('command.unknown', { line: '/x' })).toBe('未知命令：/x')
  })
})
