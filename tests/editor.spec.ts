/**
 * Editor invocation resolution: the environment and platform branches that
 * decide how the settings document opens on each host.
 */

import { describe, expect, it } from 'vitest'
import { editorInvocation } from '../src/tui/editor.ts'

describe('editorInvocation', () => {
  it('prefers $EDITOR over $VISUAL and quotes the document path', () => {
    expect(editorInvocation({ EDITOR: 'code --wait', VISUAL: 'vi' }, 'win32', 'C:/a b/settings.yaml'))
      .toEqual({ cmd: 'code --wait', args: ['"C:/a b/settings.yaml"'] })
  })

  it('falls back to $VISUAL when $EDITOR is empty', () => {
    expect(editorInvocation({ EDITOR: '  ', VISUAL: 'nvim' }, 'linux', '/home/x/settings.yaml'))
      .toEqual({ cmd: 'nvim', args: ['"/home/x/settings.yaml"'] })
  })

  it('uses the platform document opener when no editor is configured', () => {
    expect(editorInvocation({}, 'win32', 'C:\\dsh\\settings.yaml'))
      .toEqual({ cmd: 'cmd', args: ['/d', '/c', 'start', '', JSON.stringify('C:\\dsh\\settings.yaml')] })
    expect(editorInvocation({}, 'darwin', '/dsh/settings.yaml')).toEqual({ cmd: 'open', args: ['/dsh/settings.yaml'] })
    expect(editorInvocation({}, 'linux', '/dsh/settings.yaml')).toEqual({ cmd: 'xdg-open', args: ['/dsh/settings.yaml'] })
  })
})
