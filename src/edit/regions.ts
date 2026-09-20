import type { Document, DocValue } from '../doc/Document.ts'
import type { Node } from '../nodes/types.ts'
import { Pair } from '../nodes/Pair.ts'
import type { Scalar } from '../nodes/Scalar.ts'
import { YAMLMap } from '../nodes/YAMLMap.ts'
import type { YAMLSeq } from '../nodes/YAMLSeq.ts'
import type { ToStringOptions } from '../options.ts'
import type { CollectionItem } from '../parse/cst.ts'
import {
  lineStart,
  nodeSpan,
  pairLineSpan,
  scalarValueSpan,
  seqItemSpan,
  type Span
} from './spans.ts'
import {
  makeContext,
  renderFlowItem,
  renderPair,
  renderSeqItem,
  renderValue
} from './stringify-region.ts'
import { stringify as stringifyNode } from '../stringify/stringify.ts'

export interface Replacement extends Span {
  text: string
  operation: number
  reason: string
  node?: Node
}

function lineIndentOf(src: string, offset: number): string {
  return ' '.repeat(columnOf(src, offset))
}

function spanStartLineStart(src: string, offset: number): number {
  return lineStart(src, offset)
}

function columnOf(src: string, offset: number): number {
  const ls = lineStart(src, offset)
  let n = 0
  while (src[ls + n] === ' ') n += 1
  return n
}

export interface LeafEdit {
  operation: number
  /** How the mutation is realised in source. */
  mode:
    | 'scalar-value'
    | 'scalar-key'
    | 'pair'
    | 'seq-item'
    | 'delete-pair'
    | 'delete-seq-item'
    | 'insert-pair'
    | 'insert-seq-item'
    | 'collection'
    | 'root'
  /** Precomputed span from the original source for line deletions. */
  deleteSpan?: Span
  /** New value node paired with a new key (insert-pair). */
  valueNode?: Node | null
  parent?: YAMLMap | YAMLSeq
  pair?: Pair
  /** Map pair that owns `parent` when parent is a mapping value. */
  ownerPair?: Pair
  seq?: YAMLSeq
  index?: number
  /** Original node for narrow edits. */
  oldNode?: Node | null
  /** Replacement node already placed in the mutated clone. */
  newNode?: Node | null
}

export function buildReplacements(
  src: string,
  doc: Document<DocValue>,
  edits: LeafEdit[],
  options?: ToStringOptions
): Replacement[] {
  const reps: Replacement[] = []
  for (const edit of edits) reps.push(...build(src, doc, edit, options))
  return coalesce(doc, src, reps, options)
}

/**
 * Merge overlapping replacements. Narrow edits are never unioned; when two
 * structural/collection regions overlap, the caller is expected to have
 * supplied a common-ancestor collection edit. Here we detect unresolved
 * overlaps and widen them by re-rendering the containing node already
 * attached to one of the replacements, if its span covers the union.
 */
function coalesce(
  doc: Document<DocValue>,
  src: string,
  reps: Replacement[],
  options?: ToStringOptions
): Replacement[] {
  const sorted = [...reps].sort((a, b) => a.start - b.start || b.end - a.end)
  const out: Replacement[] = []
  for (const rep of sorted) {
    const last = out[out.length - 1]
    if (last && last.start < rep.end && rep.start < last.end) {
      // Prefer whichever node's original span covers both.
      const cover = covers(last.node, rep)
        ? last
        : covers(rep.node, last)
          ? rep
          : undefined
      const start = Math.min(last.start, rep.start)
      const end = Math.max(last.end, rep.end)
      if (cover?.node) {
        const node = cover.node as YAMLMap | YAMLSeq
        const off = node.range![0]
        const indent = ' '.repeat(columnOf(src, off))
        const ctx = makeContext(doc, options, indent, !!node.flow)
        out[out.length - 1] = {
          start: node.range![0],
          end: node.range![2],
          text: stringifyNode(node, ctx),
          operation: cover.operation,
          reason: 'Rewrite common ancestor of overlapping edits',
          node
        }
        continue
      }
      last.start = start
      last.end = end
      last.reason += `; merged with overlapping edit #${rep.operation}`
    } else {
      out.push(rep)
    }
  }
  return out
}

function covers(node: Node | undefined, rep: Replacement): boolean {
  if (!node?.range) return false
  return node.range[0] <= rep.start && rep.end <= node.range[2]
}

function build(
  src: string,
  doc: Document<DocValue>,
  edit: LeafEdit,
  options?: ToStringOptions
): Replacement[] {
  switch (edit.mode) {
    case 'scalar-value': {
      const old = edit.oldNode as Scalar
      const span = scalarValueSpan(old)
      if (!span) break
      const indent =
        edit.parent instanceof YAMLMap && edit.pair?.value
          ? lineIndentOf(src, edit.pair.value.range?.[0] ?? 0)
          : lineIndentOf(src, span.start)
      const text = renderValue(
        doc,
        edit.newNode as Node,
        { indent, inFlow: !!edit.parent?.flow },
        options
      )
      return [
        {
          ...span,
          text,
          operation: edit.operation,
          reason: 'Replace scalar value',
          node: old
        }
      ]
    }

    case 'scalar-key': {
      const pair = edit.pair as Pair
      const r = pair.key.range
      if (!r) break
      const text = renderValue(
        doc,
        edit.newNode as Node,
        { indent: '', inFlow: !!edit.parent?.flow },
        options
      )
      return [
        {
          start: r[0],
          end: r[1],
          text,
          operation: edit.operation,
          reason: 'Replace mapping key',
          node: pair.key
        }
      ]
    }

    case 'pair': {
      const pair = edit.pair as Pair
      const span = pairLineSpan(src, pair)
      if (!span) break
      const step =
        typeof options?.indent === 'number' ? ' '.repeat(options.indent) : '  '
      const keyCol = columnOf(src, pair.key.range?.[0] ?? span.start)
      // stringifyPair adds one indent step for nested values, so feed it the
      // parent's indent rather than the key column.
      const parentIndent = ' '.repeat(Math.max(0, keyCol - step.length))
      const body = renderPair(
        doc,
        pair,
        parentIndent,
        !!edit.parent?.flow,
        options
      )
      return [
        {
          start: span.start,
          end: span.end,
          text: body + '\n',
          operation: edit.operation,
          reason: 'Rewrite mapping entry',
          node: pair.value ?? pair.key
        }
      ]
    }

    case 'seq-item': {
      const seq = edit.seq as YAMLSeq
      const node = edit.oldNode as Node
      const span = seqItemSpan(src, seq, edit.index as number, node)
      if (!span) break
      if (seq.flow) {
        const text = renderFlowItem(doc, edit.newNode as Node, options)
        return [
          {
            start: node.range![0],
            end: node.range![1],
            text,
            operation: edit.operation,
            reason: 'Replace flow sequence element',
            node
          }
        ]
      }
      const indent = lineIndentOf(src, span.start)
      const body = renderSeqItem(doc, edit.newNode as Node, indent, options)
      return [
        {
          start: span.start,
          end: span.end,
          text: body + '\n',
          operation: edit.operation,
          reason: 'Rewrite sequence element',
          node
        }
      ]
    }

    case 'delete-pair': {
      const map = edit.parent as YAMLMap | undefined
      if (map?.flow && edit.pair) {
        const span = flowPairSpan(src, map, edit.pair)
        if (span)
          return [
            {
              start: span.start,
              end: span.end,
              text: '',
              operation: edit.operation,
              reason: 'Remove flow mapping entry',
              node: edit.pair.key
            }
          ]
      }
      const span = edit.deleteSpan
      if (!span) break
      return [
        {
          start: span.start,
          end: span.end,
          text: '',
          operation: edit.operation,
          reason: 'Remove mapping entry',
          node: edit.oldNode ?? undefined
        }
      ]
    }

    case 'delete-seq-item': {
      const seq = edit.seq
      if (seq?.flow && edit.index !== undefined && edit.oldNode) {
        const span = flowSeqItemSpan(src, seq, edit.index, edit.oldNode)
        if (span)
          return [
            {
              start: span.start,
              end: span.end,
              text: '',
              operation: edit.operation,
              reason: 'Remove flow sequence element',
              node: edit.oldNode
            }
          ]
      }
      const span = edit.deleteSpan
      if (!span) break
      return [
        {
          start: span.start,
          end: span.end,
          text: '',
          operation: edit.operation,
          reason: 'Remove sequence element',
          node: edit.oldNode ?? undefined
        }
      ]
    }

    case 'insert-pair': {
      const map = edit.parent as YAMLMap
      const pair = new Pair(edit.newNode as never, edit.valueNode as never)
      if (map.flow) {
        const anchor = flowInsertAnchor(src, map)
        const body = renderFlowItem(doc, pair, options)
        const existing = map.size - 1
        const text = existing > 0 ? `, ${body}` : ` ${body} `
        return [
          {
            start: anchor.before,
            end: anchor.after,
            text: text + '',
            operation: edit.operation,
            reason: 'Insert flow mapping entry',
            node: map
          }
        ]
      }
      if (!map.range) break // fall back to enclosing-collection rewrite
      const anchor = blockMapInsertAnchor(src, map)
      const col = mapChildColumn(src, map, edit.ownerPair)
      // renderPair adds one indent step for nested values; pass the parent
      // column (key col minus a step) and prefix the physical key indent.
      const step =
        typeof options?.indent === 'number' ? ' '.repeat(options.indent) : '  '
      const parentCol = Math.max(0, col - step.length)
      const body = renderPair(doc, pair, ' '.repeat(parentCol), false, options)
      const physical = ' '.repeat(col)
      const needNL =
        anchor.pos > 0 &&
        src[anchor.pos - 1] !== '\n' &&
        src[anchor.pos - 1] !== '\r'
      const text = `${needNL ? '\n' : ''}${physical}${body}\n`
      return [
        {
          start: anchor.pos,
          end: anchor.pos,
          text,
          operation: edit.operation,
          reason: 'Insert mapping entry',
          node: map
        }
      ]
    }

    case 'insert-seq-item': {
      const seq = edit.seq as YAMLSeq
      const index = edit.index as number
      if (!seq.range) break
      if (seq.flow) {
        const anchor = flowSeqInsertAnchor(src, seq, index)
        const body = renderFlowItem(doc, edit.newNode as Node, options)
        return [
          {
            start: anchor,
            end: anchor,
            text: `${body}, `,
            operation: edit.operation,
            reason: 'Insert flow sequence element',
            node: seq
          }
        ]
      }
      const col = blockSeqCol(src, seq, index)
      // renderSeqItem places the dash at ctx.indent - 2; give it the value
      // indent (two columns past the dash).
      const body = renderSeqItem(
        doc,
        edit.newNode as Node,
        ' '.repeat(col + 2),
        options
      )
      const pos = blockSeqInsertPos(src, seq, index)
      const needNL = pos > 0 && src[pos - 1] !== '\n' && src[pos - 1] !== '\r'
      const text = `${needNL ? '\n' : ''}${' '.repeat(col)}${body}\n`
      return [
        {
          start: pos,
          end: pos,
          text,
          operation: edit.operation,
          reason: 'Insert sequence element',
          node: seq
        }
      ]
    }

    case 'collection':
      break

    case 'root':
      return [
        {
          start: 0,
          end: src.length,
          text: doc.toString(options),
          operation: edit.operation,
          reason: 'Replace document root',
          node: edit.newNode ?? undefined
        }
      ]
  }

  // Structural fallback: rewrite the enclosing collection wholesale.
  const coll = edit.parent ?? edit.seq
  return [
    collectionReplacement(
      src,
      doc,
      coll,
      edit.operation,
      options,
      edit.ownerPair
    )
  ]
}

export function collectionReplacement(
  src: string,
  doc: Document<DocValue>,
  coll: YAMLMap | YAMLSeq | undefined,
  operation: number,
  options?: ToStringOptions,
  ownerPair?: Pair
): Replacement {
  if (!coll) {
    return {
      start: 0,
      end: src.length,
      text: doc.toString(options),
      operation,
      reason: 'Full-document rewrite (no source range)'
    }
  }
  let span = nodeSpan(coll)!
  const physicalIndent = physicalCollectionIndent(src, coll, ownerPair)
  // The block map stringifier adds `indentStep` itself when rendering nested
  // values; hand it the owning key column (physical child indent minus one
  // step), then prefix the rendered text with the physical first-line indent.
  const step =
    typeof options?.indent === 'number' ? ' '.repeat(options.indent) : '  '
  const keyColIndent =
    ownerPair && !coll.flow && physicalIndent.length >= step.length
      ? physicalIndent.slice(0, physicalIndent.length - step.length)
      : physicalIndent
  const ctx = makeContext(doc, options, keyColIndent, !!coll.flow)
  const rendered = stringifyNode(coll, ctx)
  // Flow collection node-end may include a trailing line break that belongs
  // to the enclosing block context; exclude it.
  if (coll.flow && span.end > span.start) {
    let end = span.end
    while (end > span.start && /[ \t\r\n]/.test(src[end - 1])) end -= 1
    span = { start: span.start, end }
  }
  let text = rendered
  if (!coll.flow && ownerPair) {
    // `span.start` may already include the first line's leading indentation;
    // prefix only the missing columns, and indent continuation lines fully.
    const lineSt = spanStartLineStart(src, span.start)
    const existing = span.start - lineSt
    const missing = physicalIndent.slice(existing)
    text = missing + rendered.split('\n').join(`\n${physicalIndent}`)
  }
  // Preserve a trailing line break that the original span consumed so that
  // block collection spans ending mid-document remain valid single regions.
  if (!coll.flow) {
    const originalTail = src.slice(span.start, span.end)
    if (/\n$/.test(originalTail) && !/\n$/.test(text)) text += '\n'
  }
  return {
    start: span.start,
    end: span.end,
    text,
    operation,
    reason: 'Rewrite enclosing collection (structural insertion/deletion/move)',
    node: coll
  }
}

/**
 * Indent string at which a collection renders itself. For a block collection
 * used as a mapping value, its range begins at the first child, so the parent
 * pair determines the column; for a root/seq value, use the range column.
 */
function physicalCollectionIndent(
  src: string,
  coll: YAMLMap | YAMLSeq,
  ownerPair?: Pair
): string {
  const keyOff = ownerPair?.key.range?.[0]
  if (keyOff !== undefined)
    return ' '.repeat(Math.max(0, columnOf(src, keyOff))) + '  '
  return lineIndentOf(src, coll.range![0])
  // For a mapping value the children sit one step past the owning key.
}

/** Apply a disjoint, ascending list of replacements to the source text. */
export function spliceAll(src: string, reps: Replacement[]): string {
  let out = ''
  let cursor = 0
  for (const r of reps) {
    out += src.slice(cursor, r.start) + r.text
    cursor = r.end
  }
  out += src.slice(cursor)
  return out
}

// ---------------------------------------------------------------------------
// Flow collection spans & insertion anchors
// ---------------------------------------------------------------------------

function flowToken(map: YAMLMap | YAMLSeq) {
  const t = map.srcToken
  return t?.type === 'flow-collection' ? t : undefined
}

/** Span of a single flow mapping entry including a trailing/leading comma. */
function flowPairSpan(src: string, map: YAMLMap, pair: Pair): Span | undefined {
  const token = flowToken(map)
  if (!token) return undefined
  // Match the CST item whose composed pair is this pair by key offset.
  const keyOff = pair.key.range?.[0]
  const items = token.items.filter(it => it.key ?? it.sep?.length)
  const idx = items.findIndex(it => it.key && it.key.offset === keyOff)
  return flowItemSpan(src, items, idx)
}

function flowSeqItemSpan(
  src: string,
  seq: YAMLSeq,
  index: number,
  node: Node
): Span | undefined {
  const token = flowToken(seq)
  if (!token) return undefined
  const items = token.items
  const off = node.range?.[0]
  const idx = items.findIndex(it => it.value && it.value.offset === off)
  return flowItemSpan(src, items, idx === -1 ? index : idx)
}

function flowItemSpan(
  src: string,
  items: CollectionItem[],
  idx: number
): Span | undefined {
  const item = items[idx]
  if (!item) return undefined

  // Content start: offset of key token, else value token, else first prop.
  const keyOff = item.key && 'offset' in item.key ? item.key.offset : undefined
  const valTok = item.value
  const start =
    keyOff ??
    (valTok && 'offset' in valTok ? valTok.offset : item.start?.[0]?.offset)
  if (start === undefined) return undefined

  // Content end: end of the value token if present, else end of key.
  let contentEnd: number
  if (valTok && 'offset' in valTok) {
    const len =
      typeof (valTok as { source?: string }).source === 'string'
        ? (valTok as { source: string }).source.length
        : 0
    contentEnd = valTok.offset + len
  } else if (item.key && 'offset' in item.key) {
    const len =
      typeof (item.key as { source?: string }).source === 'string'
        ? (item.key as { source: string }).source.length
        : 0
    contentEnd = item.key.offset + len
  } else {
    contentEnd = start
  }

  // Prefer absorbing a trailing comma+space; fall back to a leading comma.
  let p = contentEnd
  while (p < src.length && /[ \t\r\n]/.test(src[p])) p += 1
  if (src[p] === ',') {
    let after = p + 1
    while (after < src.length && /[ \t\r\n]/.test(src[after])) after += 1
    return { start, end: after }
  }
  let q = start - 1
  while (q >= 0 && /[ \t\r\n]/.test(src[q])) q -= 1
  if (src[q] === ',') return { start: q, end: contentEnd }
  return { start, end: contentEnd }
}

function flowInsertAnchor(
  _src: string,
  map: YAMLMap
): { before: number; after: number } {
  const token = flowToken(map)!
  let insertAt = token.start.offset + token.start.source.length
  const close = (token.end ?? []).find(
    t => t.type === 'flow-map-end' || t.type === 'flow-seq-end'
  )
  if (close) insertAt = close.offset
  return { before: insertAt, after: insertAt }
}

function flowSeqInsertAnchor(
  _src: string,
  seq: YAMLSeq,
  index: number
): number {
  const token = flowToken(seq)!
  if (index >= seq.length - 1) {
    const close = (token.end ?? []).find(
      t => t.type === 'flow-seq-end' || t.type === 'flow-map-end'
    )
    return close ? close.offset : token.start.offset + 1
  }
  const target = seq[index] as Node | undefined
  const off = target instanceof Pair || !target ? undefined : target.range?.[0]
  const item = token.items.find(it => it.value && it.value.offset === off)
  return (
    item?.start?.[0]?.offset ?? target?.range?.[0] ?? token.start.offset + 1
  )
}

// ---------------------------------------------------------------------------
// Block collection insertion anchors
// ---------------------------------------------------------------------------

function mapChildColumn(src: string, map: YAMLMap, ownerPair?: Pair): number {
  if (ownerPair?.key.range) return columnOf(src, ownerPair.key.range[0]) + 2
  const first = map.values.values().next().value
  return first?.key.range ? columnOf(src, first.key.range[0]) : 0
}

function blockMapInsertAnchor(
  src: string,
  map: YAMLMap
): { pos: number; col: number; prefix: string } {
  const range = map.range!
  let pos = range[2]
  while (pos < src.length && (src[pos] === ' ' || src[pos] === '\t')) pos += 1
  let prefix = ''
  if (pos === 0 || src[pos - 1] !== '\n') prefix = '\n'
  const first = map.values.values().next().value
  const col = first?.key.range ? columnOf(src, first.key.range[0]) : 0
  return { pos, col, prefix }
}

function blockSeqCol(src: string, seq: YAMLSeq, index: number): number {
  const node = seq[Math.min(index, seq.length - 1)] as Node | undefined
  if (!(node instanceof Pair) && node?.range) {
    const token = seq.srcToken
    if (token && 'items' in token) {
      const item = token.items[Math.min(index, seq.length - 1)]
      const ind = item?.start?.find(t => t.type === 'seq-item-ind')
      if (ind) return ind.indent
    }
  }
  return seq.range ? columnOf(src, seq.range[0]) : 0
}

function blockSeqInsertPos(src: string, seq: YAMLSeq, index: number): number {
  if (index >= seq.length) {
    const range = seq.range!
    return range[2]
  }
  const node = seq[index] as Node | undefined
  const off = node instanceof Pair || !node ? undefined : node.range?.[0]
  return off === undefined ? seq.range![2] : lineStart(src, off)
}
