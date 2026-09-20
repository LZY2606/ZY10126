import type { CollectionItem, Token } from '../parse/cst.ts'

export function tokenEnd(t: Token): number {
  if (!('source' in t)) return (t as { offset: number }).offset
  let end = t.offset + t.source.length
  if ('end' in t && t.end)
    for (const e of t.end) end = Math.max(end, e.offset + e.source.length)
  if ('props' in t) for (const p of t.props) end = Math.max(end, tokenEnd(p))
  return end
}

const LEAD = new Set(['space', 'comment'])

function itemBegin(
  item: CollectionItem,
  ...extras: Array<Token | undefined>
): number {
  let begin = Number.POSITIVE_INFINITY
  for (const t of item.start)
    if (LEAD.has(t.type) || (!extras.includes(t) && t.type !== 'newline'))
      begin = Math.min(begin, t.offset)
  for (const t of extras) if (t) begin = Math.min(begin, t.offset)
  if (!isFinite(begin)) begin = item.sep?.[0]?.offset ?? 0
  return begin
}

function includeTrailingNewline(source: string, end: number): number {
  if (source[end] === '\r' && source[end + 1] === '\n') return end + 2
  if (source[end] === '\n') return end + 1
  return end
}

/**
 * Ownership span of a block-map item: starts at the indentation/comments on
 * its own lines and ends after one trailing newline.
 */
export function blockMapItemSpan(
  source: string,
  item: CollectionItem
): [number, number] {
  const begin = itemBegin(item, item.key ?? undefined)
  let end = -1
  if (item.key) end = Math.max(end, tokenEnd(item.key))
  if (item.sep)
    for (const t of item.sep) end = Math.max(end, t.offset + t.source.length)
  if (item.value) end = Math.max(end, tokenEnd(item.value))
  end = Math.max(end, begin)
  return [begin, includeTrailingNewline(source, end)]
}

/** Same as {@link blockMapItemSpan} but anchored at the `-` indicator. */
export function blockSeqItemSpan(
  source: string,
  item: CollectionItem
): [number, number] {
  const dash = item.start.find(t => t.type === 'seq-item-ind')
  let begin = dash?.offset ?? item.value?.offset ?? 0
  const hasComment = item.start.some(t => t.type === 'comment')
  if (hasComment) {
    const firstLead = item.start
      .filter(
        t => t.type === 'comment' || t.type === 'space' || t.type === 'newline'
      )
      .reduce((m, t) => Math.min(m, t.offset), begin)
    const lineStart = source.lastIndexOf('\n', firstLead - 1) + 1
    begin = lineStart
  } else {
    for (
      let i = begin - 1;
      i >= 0 && source[i] !== '\n' && source[i] !== '\r';
      --i
    ) {
      if (source[i] === ' ' || source[i] === '\t') begin = i
      else break
    }
  }
  let end = -1
  if (item.value) end = Math.max(end, tokenEnd(item.value))
  if (item.key) end = Math.max(end, tokenEnd(item.key))
  end = Math.max(end, begin)
  return [begin, includeTrailingNewline(source, end)]
}

/** Split a flow item into leading tokens (comma/whitespace/comments) and body. */
export function flowItemParts(
  _source: string,
  item: CollectionItem
): { leadStart: number; bodyStart: number; bodyEnd: number } {
  let bodyStart = Number.POSITIVE_INFINITY
  let leadStart = Number.POSITIVE_INFINITY
  for (const t of item.start) leadStart = Math.min(leadStart, t.offset)
  const leadTypes = new Set(['comma', 'newline', 'space', 'comment'])
  for (const t of item.start)
    if (!leadTypes.has(t.type)) bodyStart = Math.min(bodyStart, t.offset)
  if (item.key) bodyStart = Math.min(bodyStart, item.key.offset)
  if (item.value) bodyStart = Math.min(bodyStart, item.value.offset)
  let bodyEnd = -1
  if (item.key) bodyEnd = Math.max(bodyEnd, tokenEnd(item.key))
  if (item.sep)
    for (const t of item.sep)
      bodyEnd = Math.max(bodyEnd, t.offset + t.source.length)
  if (item.value) bodyEnd = Math.max(bodyEnd, tokenEnd(item.value))
  if (!isFinite(bodyStart))
    bodyStart = item.start[item.start.length - 1]?.offset ?? bodyEnd
  if (!isFinite(leadStart)) leadStart = bodyStart
  return { leadStart, bodyStart, bodyEnd: Math.max(bodyEnd, bodyStart) }
}
