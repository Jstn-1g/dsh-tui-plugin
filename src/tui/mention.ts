/**
 * Composer `@`-mention grammar and send-time reference resolution for the
 * terminal UI. A mention is `@` followed by a run of non-space, non-quote
 * characters or a quoted string (`@"path with spaces"`); the same grammar
 * parses the popup's filter word and the references resolved when the
 * message is sent. Skill names resolve before file paths: a token naming a
 * known user-invocable skill attaches that skill's canonical body, anything
 * else attaches the file's content.
 */

/**
 * Maximum number of references one message may attach. Injection hygiene:
 * the model-facing budget never grows with the draft.
 */
export const MAX_MENTION_FILES = 5

/** Maximum bytes read from one referenced file. */
export const MAX_MENTION_FILE_BYTES = 32 * 1024

/** Maximum total bytes across all referenced files in one message. */
export const MAX_MENTION_TOTAL_BYTES = 96 * 1024

/** One parsed `@`-reference from a draft line. */
export interface MentionToken {
  /** The raw token, including the leading `@` and any quotes. */
  raw: string
  /** The reference value with surrounding quotes stripped. */
  value: string
}

/** The `@`-token grammar: unquoted runs or double/single-quoted strings. */
const MENTION_TOKEN = /@(?:[^\s"'@]+|"[^"]+"|'[^']+')/g

/** Strip one layer of matching quotes from a token body. */
function unquote(body: string): string {
  if (body.length >= 2 && (body.startsWith('"') && body.endsWith('"') || body.startsWith("'") && body.endsWith("'"))) {
    return body.slice(1, -1)
  }
  // An opening quote without its closer (mid-typing) still names the filter.
  if (body.startsWith('"') || body.startsWith("'")) return body.slice(1)
  return body
}

/** Quote a reference for insertion when it contains whitespace. */
function quote(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value
}

/**
 * The forward end of one mention run: non-space characters, with quoted
 * sections (balanced or still being typed) kept together.
 * @param chars - the draft characters.
 * @param start - the run start.
 * @returns the run end (exclusive).
 */
function runEnd(chars: readonly string[], start: number): number {
  let index = start
  while (index < chars.length) {
    const char = chars[index]
    /* v8 ignore next -- the loop bound keeps the character defined, and quoted sections swallow the spaces */
    if (char === undefined || /\s/.test(char)) break
    if (char === '"' || char === "'") {
      index += 1
      while (index < chars.length && chars[index] !== char) index += 1
      if (index < chars.length) index += 1
      continue
    }
    index += 1
  }
  return index
}

/**
 * The backward start of one mention run: walks left from the caret; a quote
 * crossed on the way keeps balanced quoted sections together, and a space
 * inside a quoted section whose closer sits right of the caret (or is still
 * being typed) stays part of the run.
 * @param chars - the draft characters.
 * @param at - the caret position.
 * @returns the run start (inclusive).
 */
function runStart(chars: readonly string[], at: number): number {
  let index = at
  let quote: string | undefined
  while (index > 0) {
    const char = chars[index - 1]
    /* v8 ignore next -- the loop bound keeps the character defined */
    if (char === undefined) break
    if (char === '"' || char === "'") {
      quote = quote === char ? undefined : char
      index -= 1
      continue
    }
    if (/\s/.test(char)) {
      if (quote !== undefined) {
        index -= 1
        continue
      }
      const quoteCount = chars.slice(0, index - 1).filter(candidate => candidate === '"' || candidate === "'").length
      if (quoteCount % 2 === 1) {
        index -= 1
        continue
      }
      break
    }
    index -= 1
  }
  return index
}

/**
 * Every `@`-reference in a draft line, in first-seen order.
 * @param text - the draft line.
 * @returns the parsed tokens.
 */
export function parseMentionTokens(text: string): MentionToken[] {
  return [...text.matchAll(MENTION_TOKEN)].map(match => ({
    raw: match[0],
    value: unquote(match[0].slice(1)),
  }))
}

/**
 * The mention word being edited at the caret: the maximal run of
 * non-whitespace characters containing the caret, when it starts with `@`.
 * Quoted sections keep their spaces inside the run.
 * @param draft - the current draft.
 * @param caret - the caret position in characters.
 * @returns the word's bounds and its filter text (the part after `@`), or
 *   `undefined` when the caret is not inside an `@`-word.
 */
export function mentionWordAt(draft: string, caret: number): { start: number; end: number; filter: string } | undefined {
  const chars = Array.from(draft)
  const at = Math.min(Math.max(0, caret), chars.length)
  const start = runStart(chars, at)
  const end = runEnd(chars, start)
  const word = chars.slice(start, end).join('')
  if (!word.startsWith('@')) return undefined
  return { start, end, filter: unquote(word.slice(1)) }
}

/**
 * Resolve one parsed reference into a display label the composer inserts
 * verbatim on acceptance.
 * @param value - the unquoted reference value.
 * @returns the insertable `@reference` text.
 */
export function mentionLabel(value: string): string {
  return `@${quote(value)}`
}

/**
 * The model-visible context block carrying one attached file's content.
 * Framed as a `<system-reminder>`, the harness-wide injected-context
 * convention the transcript fold renders as a dimmed context row.
 * @param path - the workspace-relative path the user referenced.
 * @param content - the file content.
 * @returns the framed block.
 */
export function fileReferenceBlock(path: string, content: string): string {
  return `<system-reminder>Attached file: ${path}\n${content}\n</system-reminder>`
}

/**
 * The joined context blocks for all resolved references of one message:
 * each reference frames itself as one `<system-reminder>` unit, so the
 * transcript can render one chip per reference.
 * @param sections - the resolved reference sections in reference order.
 * @returns the complete injected-context text.
 */
export function referenceContextBlock(sections: readonly string[]): string {
  return sections.map(section => `<system-reminder>${section}</system-reminder>`).join('\n')
}
