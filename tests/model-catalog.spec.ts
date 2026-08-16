/**
 * Model catalog projection: provider groups with per-provider models.
 */

import { describe, expect, it } from 'vitest'
import { buildModelGroups } from '../src/tui/model-catalog.ts'

describe('buildModelGroups', () => {
  it('maps providers and their models into groups', () => {
    const groups = buildModelGroups(
      [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }],
      new Map([
        ['p1', [{ id: 'm1', name: 'M1' }]],
        ['p2', [{ id: 'm2', name: 'M2' }, { id: 'm3', name: 'M3' }]],
      ]),
    )
    expect(groups).toEqual([
      { id: 'p1', name: 'P1', models: [{ id: 'm1', name: 'M1' }] },
      { id: 'p2', name: 'P2', models: [{ id: 'm2', name: 'M2' }, { id: 'm3', name: 'M3' }] },
    ])
  })

  it('produces empty model lists for providers without entries', () => {
    const groups = buildModelGroups([{ id: 'p1', name: 'P1' }], new Map())
    expect(groups).toEqual([{ id: 'p1', name: 'P1', models: [] }])
  })

  it('returns an empty list for no providers', () => {
    expect(buildModelGroups([], new Map())).toEqual([])
  })
})
