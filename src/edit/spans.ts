import type { Node } from '../nodes/types.ts'
import type { Pair } from '../nodes/Pair.ts'
import type { Scalar } from '../nodes/Scalar.ts'
import type { YAMLMap } from '../nodes/YAMLMap.ts'
import type { YAMLSeq } from '../nodes/YAMLSeq.ts'

export interface Span {
  start: number
  end: number
}

export function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end
}

export function contains(outer: Span, inner: Span): boolean {
  return outer.start <= inner.start && inner.end <= outer.end
}

/** Absolute span of a node's complete text, including trailing comments. */
export function nodeSpan(node: Node): Span | undefined {
  const r = node.range
  if (!r) return undefined
  return { start: r[0], end: r[2] }
}

/**
 * Span covering a scalar's value text only (excluding comments/trailing
 * newline), allowing a narrow value replacement.
 */
export function scalarValueSpan(node: Scalar): Span | undefined {
  const r = node.range
  if (!r) return undefined
  return { start: r[0], end: r[1] }
}

/** Line start offset for a block map pair, walking the CST start tokens. */
export function pairLineSpan(src: string, pair: Pair): Span | undefined {
  const item = pair.srcToken
  // The entry occupies one line (block scalars excepted); end at the first
  // newline at or after the value/key content, which preserves any inline
  // comment while excluding following entries.
  const valueEnd = pair.value?.range?.[1] ?? pair.key.range?.[1]
  const keyOff = pair.key.range?.[0]
  if (keyOff === undefined || valueEnd === undefined) return undefined
  void item
  return { start: lineStart(src, keyOff), end: lineEnd(src, valueEnd) }
}

/**
 * End offset including the newline of the line on which the node's *value*
 * ends. The node-end (`range[2]`) may include trailing comments or point at
 * the leading indentation of the following line; this finds the first
 * terminating newline from the value-end (`range[1]`).
 */
export function lineEnd(src: string, valueEnd: number): number {
  let o = valueEnd
  // If value-end already points at leading whitespace of the following line,
  // the terminator is the newline just before it.
  if (o < src.length && (src[o] === ' ' || src[o] === '\t')) {
    const ls = src.lastIndexOf('\n', o - 1) + 1
    if (src.slice(ls, o).trim() === '') o = ls
  }
  if (src[o] === '\r' && src[o + 1] === '\n') return o + 2
  const nl = src.indexOf('\n', o)
  return nl === -1 ? src.length : nl + 1
}

/** Start offset of the line containing `offset`. */
export function lineStart(src: string, offset: number): number {
  return src.lastIndexOf('\n', offset - 1) + 1
}

/**
 * Span for a block-sequence element: from its leading indent (the column of
 * the `-`) through the newline following it.
 */
export function seqItemSpan(
  src: string,
  seq: YAMLSeq,
  index: number,
  node: Node
): Span | undefined {
  const token = seq.srcToken
  const item = token && 'items' in token ? token.items[index] : undefined
  let start: number | undefined
  if (item?.start) {
    const ind = item.start.find(t => t.type === 'seq-item-ind')
    start = ind?.offset ?? item.start[0]?.offset
  }
  start ??= node.range?.[0]
  const valueEnd = node.range?.[1] ?? node.range?.[2]
  if (start === undefined || valueEnd === undefined) return undefined
  // Include the leading indentation of the item's own line so deletion does
  // not leave dangling spaces.
  const lineSt = lineStart(src, start)
  return { start: lineSt, end: lineEnd(src, valueEnd) }
}

/** Full span of a collection node (its range [0..2]). */
export function collectionSpan(node: YAMLMap | YAMLSeq): Span | undefined {
  return nodeSpan(node)
}
