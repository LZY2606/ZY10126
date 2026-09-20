import type { Document } from '../doc/Document.ts'
import { Pair } from '../nodes/Pair.ts'
import { Scalar } from '../nodes/Scalar.ts'
import type {
  CollectionItem,
  BlockMap,
  BlockSequence,
  FlowCollection
} from '../parse/cst.ts'
import type { Collection, Node, Range } from '../nodes/types.ts'
import { YAMLSeq } from '../nodes/YAMLSeq.ts'
import { YAMLSet } from '../nodes/YAMLSet.ts'
import type { ToStringOptions } from '../options.ts'
import {
  createStringifyContext,
  stringify,
  type StringifyContext
} from '../stringify/stringify.ts'
import { stringifyPair } from '../stringify/stringifyPair.ts'
import {
  tokenEnd,
  blockMapItemSpan,
  blockSeqItemSpan,
  flowItemParts
} from './spans.ts'

export type CollectionToken = BlockMap | BlockSequence | FlowCollection

export function getCollectionToken(
  node: Collection
): CollectionToken | undefined {
  const tok = node.srcToken
  if (
    tok &&
    (tok.type === 'block-map' ||
      tok.type === 'block-seq' ||
      tok.type === 'flow-collection')
  )
    return tok
  return undefined
}

export interface PatchRegion {
  range: Range
  text: string
  reason: string
}

export interface CollectionChange {
  node: Collection
  /** Original CST item index, or -1 for a pure insertion. */
  cstIndex: number
  mode: 'keep' | 'replace' | 'delete'
  pair?: Pair | null
  seqNode?: Node | null
  insert?: boolean
  /** CST index at which an insertion is placed (among original items). */
  insertAt?: number
  reason: string
  /** Internal: item's subtree contains a nested changed collection. */
  _swallow?: boolean
  /** Mutation index used to bind the live node/pair after application. */
  mutIndex?: number
  /** In-collection move: render at this position instead of cstIndex. */
  moveTo?: number
  /** Edit targets a shadowed duplicate-key occurrence (CST-only pair). */
  shadowed?: boolean
}

function detectCRLF(source: string): boolean {
  return source.includes('\r\n')
}

function fixNewlines(text: string, crlf: boolean): string {
  return crlf ? text.replace(/(?<!\r)\n/g, '\r\n') : text
}

/** Re-emittable range of a collection (full block span / flow interior). */
export function getReplacementRange(node: Collection): Range | null {
  const tok = getCollectionToken(node)
  const range = node.range
  if (!tok || !range) return null
  if (tok.type === 'flow-collection') {
    const close = tok.end.find(
      t => t.type === 'flow-map-end' || t.type === 'flow-seq-end'
    )
    const endPos = close ? close.offset : range[1]
    return [tok.start.offset + tok.start.source.length, endPos, endPos]
  }
  return [tok.offset, range[1], range[1]]
}

/**
 * Render a single changed collection by concatenating raw source slices for
 * untouched items and stringifier output for changed/new items.
 */
export function renderChangedCollection(
  doc: Document,
  source: string,
  node: Collection,
  changes: CollectionChange[],
  toStringOptions?: ToStringOptions
): PatchRegion | null {
  const tok = getCollectionToken(node)
  if (!tok) return null
  const range = getReplacementRange(node)
  if (!range) return null

  const baseCtx = createStringifyContext(doc, toStringOptions)
  const crlf = detectCRLF(source)
  const reason = changes.map(c => c.reason).join('; ')
  const text =
    tok.type === 'flow-collection'
      ? renderFlow(source, node, tok, changes, baseCtx)
      : renderBlock(source, node, tok, changes, baseCtx)

  let blockR =
    tok.type === 'flow-collection' ? range : blockRange(source, node, tok)
  let finalText = text.replace(/[ \t]+\r?\n$/, '\n')
  if (
    tok.type !== 'flow-collection' &&
    /\r?\n$/.test(source.slice(blockR[0], blockR[1])) &&
    !/\r?\n$/.test(finalText)
  )
    finalText += '\n'
  // When the collection became empty, drop the orphaned indentation on its
  // first line left behind by deleting the only entry.
  if (text.trim() === '' && blockR[0] > 0) {
    const lineStart = source.lastIndexOf('\n', blockR[0] - 1) + 1
    if (/^[ \t]+$/.test(source.slice(lineStart, blockR[0]))) {
      blockR = [lineStart, blockR[1], blockR[2]]
      finalText = ''
    }
  }
  return { range: blockR, text: fixNewlines(finalText, crlf), reason }
}

function blockRange(
  source: string,
  node: Collection,
  tok: BlockMap | BlockSequence
): Range {
  const range = node.range!
  const real = tok.items.filter(
    it =>
      it.key !== undefined ||
      it.sep !== undefined ||
      it.value !== undefined ||
      it.start.some(t => t.type === 'seq-item-ind')
  )
  if (real.length === 0) return [tok.offset, range[1], range[1]]
  const first = real[0]
  const firstLineStart = (() => {
    const positions = [
      first.key?.offset,
      first.value?.offset,
      ...first.start.filter(t => t.type === 'seq-item-ind').map(t => t.offset)
    ].filter((n): n is number => typeof n === 'number')
    return positions.length ? Math.min(...positions) : tok.offset
  })()
  const begin = firstLineStart
  let end = range[1]
  if (source[end] === '\r' && source[end + 1] === '\n') end += 2
  else if (source[end] === '\n') end += 1
  return [begin, end, end]
}

type NormalisedSlot =
  | { kind: 'keep'; item: CollectionItem; cstIndex: number }
  | { kind: 'render'; c: CollectionChange; cstIndex: number }

function normaliseSlots(
  tok: CollectionToken,
  changes: CollectionChange[]
): NormalisedSlot[] {
  const byIndex = new Map<number, CollectionChange>()
  for (const c of changes) if (!c.insert) byIndex.set(c.cstIndex, c)
  const moved = changes.filter(c => c.moveTo !== undefined)
  const movedFrom = new Set(moved.map(c => c.cstIndex))
  // moveTo is the post-removal survivor slot index; map it back to the
  // original CST index of the survivor it should precede.
  const survivors: number[] = []
  for (let ci = 0; ci < tok.items.length; ++ci)
    if (!movedFrom.has(ci) && isRealItem(tok, tok.items[ci])) survivors.push(ci)
  const slots: NormalisedSlot[] = []
  for (let si = 0; si < survivors.length; ++si) {
    const ci = survivors[si]
    for (const m of moved)
      if ((m.moveTo ?? 0) === si)
        slots.push({ kind: 'render', c: m, cstIndex: ci })
    const c = byIndex.get(ci)
    if (c) slots.push({ kind: 'render', c, cstIndex: ci })
    else slots.push({ kind: 'keep', item: tok.items[ci], cstIndex: ci })
  }
  for (const m of moved)
    if ((m.moveTo ?? 0) >= survivors.length)
      slots.push({ kind: 'render', c: m, cstIndex: tok.items.length })
  return slots
}

function isRealItem(tok: CollectionToken, item: CollectionItem): boolean {
  if (
    item.key !== undefined ||
    item.sep !== undefined ||
    item.value !== undefined
  )
    return true
  return (
    tok.type === 'block-seq' && item.start.some(t => t.type === 'seq-item-ind')
  )
}

function renderFlow(
  source: string,
  node: Collection,
  tok: FlowCollection,
  changes: CollectionChange[],
  baseCtx: StringifyContext
): string {
  const indent = ' '.repeat(tok.indent + baseCtx.indentStep.length)
  const ctx = { ...baseCtx, indent, inFlow: true as boolean }
  const changeByIndex = new Map<number, CollectionChange>()
  const inserts = new Map<number, CollectionChange[]>()
  for (const c of changes) {
    if (c.insert) {
      const list = inserts.get(c.insertAt ?? 0) ?? []
      list.push(c)
      inserts.set(c.insertAt ?? 0, list)
    } else changeByIndex.set(c.cstIndex, c)
  }

  const innerStart = tok.start.offset + tok.start.source.length
  const innerEnd = node.range![1]
  const lead = source.slice(innerStart).match(/^\s*/)?.[0] ?? ''
  const tail = source.slice(innerStart, innerEnd).match(/\s*$/)?.[0] ?? ''

  type Entry = {
    kind: 'raw' | 'value'
    text: string
    multiline: boolean
    trailing: string
  }
  const entries: Entry[] = []

  const slots = normaliseSlots(tok, changes)
  for (const slot of slots) {
    if (slot.kind === 'keep') {
      const item = slot.item
      if (!isRealFlowItem(item)) continue
      const parts = flowItemParts(source, item)
      const sep = source.slice(parts.leadStart, parts.bodyStart)
      const body = source.slice(parts.bodyStart, parts.bodyEnd)
      {
        // sep is the text between the previous body end and this body.
        // Keep a newline+indent for multiline layout in `leadSep`, and the
        // body itself content-only.
        const leadSep = sep
        const tm = body.match(/[ \t]*\r?\n?[ \t]*$/)
        const trailing = tm?.[0].includes('\n') ? tm[0] : ''
        entries.push({
          kind: 'raw',
          text:
            (trailing ? body.slice(0, body.length - trailing.length) : body) +
            (leadSep.includes('\n') ? '' : ''),
          multiline: (sep + body).includes('\n'),
          trailing,
          leadSep
        } as any)
      }
      continue
    }
    const c = slot.c
    for (const ins of inserts.get(slot.cstIndex) ?? [])
      entries.push({
        kind: 'value',
        text: renderFlowBody(ins, node, ctx),
        multiline: false,
        trailing: ''
      })
    entries.push({
      kind: 'value',
      text: c.mode === 'delete' ? '' : renderFlowBody(c, node, ctx),
      multiline: false,
      trailing: ''
    })
  }
  for (const ins of inserts.get(tok.items.length) ?? [])
    entries.push({
      kind: 'value',
      text: renderFlowBody(ins, node, ctx),
      multiline: false,
      trailing: ''
    })

  return assembleFlow(entries, lead, tail, indent)
}

function renderFlowBody(
  c: CollectionChange,
  parent: Collection,
  ctx: StringifyContext
): string {
  return parent instanceof YAMLSeq && !(parent instanceof YAMLSet)
    ? stringify(c.seqNode ?? null, ctx)
    : stringifyPair((c.pair ?? null) as Pair, ctx)
}

function assembleFlow(
  entries: Array<{
    kind: string
    text: string
    multiline: boolean
    trailing: string
    leadSep?: string
  }>,
  lead: string,
  tail: string,
  indent: string
): string {
  const kept = entries.filter(e => !(e.kind === 'value' && e.text === ''))
  if (kept.length === 0) return lead.replace(/[ \t]*$/, '') + tail
  const multiline =
    kept.some(e => e.multiline) || lead.includes('\n') || tail.includes('\n')

  let body = ''
  for (let i = 0; i < kept.length; ++i) {
    const e = kept[i]
    let content = e.text
    if (i > 0) {
      if (multiline) {
        // Preserve the original newline/indent separator when available.
        const ws = (e.leadSep ?? '').match(/\r?\n[ \t]*/)?.[0]
        body += ',' + (ws ?? `\n${indent}`)
      } else {
        body += ', '
      }
    } else if (e.kind === 'raw') {
      content = content.replace(/^\s*/, '')
    }
    body += content
  }

  if (multiline) {
    // Always start multiline content on a fresh line unless the raw first
    // entry already carries the newline from the collection's lead tokens.
    const opening =
      kept[0].kind === 'raw' && /\r?\n[ \t]*$/.test(lead) ? '' : '\n' + indent
    const closeIndent = ' '.repeat(Math.max(0, indent.length - 2))
    const closing = /^\r?\n/.test(tail)
      ? tail.match(/^\r?\n[ \t]*/)![0]
      : '\n' + closeIndent
    return opening + body + closing
  }
  body = body.replace(/^[ \t]+/, '')
  const leadOut = body.startsWith(' ') ? '' : ' '
  const tailOut = /\s$/.test(body) ? '' : ' '
  return leadOut + body + tailOut
}

function isRealFlowItem(item: FlowCollection['items'][number]): boolean {
  return (
    item.key !== undefined ||
    item.sep !== undefined ||
    item.value !== undefined ||
    item.start.some(t => t.type === 'seq-item-ind')
  )
}

function trailingNewline(source: string, offset: number): number {
  if (source[offset] === '\r' && source[offset + 1] === '\n') return offset + 2
  if (source[offset] === '\n') return offset + 1
  return offset
}

function nodeByCst(node: Collection, cstIndex: number): Node | Pair | null {
  if (node instanceof YAMLSeq)
    return node[nodeIndexForCst(node, cstIndex)] ?? null
  const pairs = [...node.values.values()] as Pair[]
  let entry = -1
  const tok = node.srcToken as {
    items?: Array<{ key?: unknown; sep?: unknown }>
  }
  if (!tok?.items) return null
  for (let ci = 0; ci <= cstIndex && ci < tok.items.length; ++ci)
    if (tok.items[ci].key !== undefined || tok.items[ci].sep !== undefined)
      entry += 1
  const pair = pairs[entry]
  return pair ? (pair.value ?? pair.key) : null
}

function nodeIndexForCst(seq: YAMLSeq, cstIndex: number): number {
  const tok = seq.srcToken as
    | { items?: Array<{ value?: unknown; start: Array<{ type: string }> }> }
    | undefined
  if (!tok?.items) return cstIndex
  let n = -1
  for (let ci = 0; ci <= cstIndex && ci < tok.items.length; ++ci) {
    const it = tok.items[ci]
    if (it.value !== undefined || it.start.some(t => t.type === 'seq-item-ind'))
      n += 1
  }
  return n
}

function renderBlock(
  source: string,
  node: Collection,
  tok: BlockMap | BlockSequence,
  changes: CollectionChange[],
  baseCtx: StringifyContext
): string {
  const indent = ' '.repeat(Math.max(0, tok.indent))
  const isSeq = tok.type === 'block-seq'
  const changeByIndex = new Map<number, CollectionChange>()
  const inserts = new Map<number, CollectionChange[]>()
  for (const c of changes) {
    if (c.insert) {
      const list = inserts.get(c.insertAt ?? 0) ?? []
      list.push(c)
      inserts.set(c.insertAt ?? 0, list)
    } else changeByIndex.set(c.cstIndex, c)
  }

  const pieces: string[] = []
  const emit = (c: CollectionChange, first: boolean, lead = '') => {
    let body: string
    if (!isSeq && c.shadowed) {
      const pair = shadowedPair(source, node, c, baseCtx)
      const ctx = { ...baseCtx, indent }
      body = stringifyPair(pair, ctx)
      pieces.push((first ? '' : indent) + body)
      return
    }
    if (isSeq) {
      const ctx = { ...baseCtx, indent: indent + baseCtx.indentStep }
      const rendered = stringify(c.seqNode ?? null, ctx)
      body = `- ${rendered.split('\n').join(`\n${indent}${baseCtx.indentStep}`)}`
      // Preserve comment/blank lines that belonged to the replaced item.
    } else {
      const ctx = { ...baseCtx, indent }
      body =
        node instanceof YAMLSet
          ? stringifyPair((c.pair ?? null) as Pair, ctx)
          : stringifyPair((c.pair ?? null) as Pair, ctx)
    }
    pieces.push((first ? '' : indent) + lead + body)
  }

  let seen = 0
  const slots = normaliseSlots(tok, changes)
  for (const slot of slots) {
    for (const ins of inserts.get(slot.cstIndex) ?? []) {
      emit(ins, seen === 0)
      seen += 1
    }
    if (slot.kind === 'keep') {
      const item = slot.item
      if (
        !isRealFlowItem(item) &&
        !item.start.some((t: { type: string }) => t.type === 'seq-item-ind')
      )
        continue
      const span = isSeq
        ? blockSeqItemSpan(source, item)
        : blockMapItemSpan(source, item)
      // Nested block collection values end at their semantic valueEnd,
      // which may extend past the CST token's own source.length.
      // Only extend the span from the composed value when the CST item
      // really owns a nested block collection. Use item.value directly to
      // avoid misaligning on shadowed duplicate-key occurrences.
      const composedValue = item.value as any
      if (
        composedValue &&
        (composedValue.type === 'block-map' ||
          composedValue.type === 'block-seq')
      ) {
        const owner = nodeByCst(node, slot.cstIndex)
        const valueRange =
          owner && Array.isArray((owner as any).range)
            ? ((owner as any).range as Range)
            : null
        if (valueRange && valueRange[1] > span[1] - 1)
          span[1] = Math.max(span[1], trailingNewline(source, valueRange[1]))
      }
      const raw = source
        .slice(span[0], span[1])
        .replace(/^[ \t]*\n+/, '')
        .replace(/\r?\n$/, '')
      pieces.push(seen === 0 ? raw.replace(/^[ \t]+/, '') : raw)
      seen += 1
      continue
    }
    const c = slot.c
    if (c.mode === 'delete') continue
    emit(
      c,
      seen === 0,
      leadForRender(source, isSeq, tok.items[slot.cstIndex], c)
    )
    seen += 1
  }
  for (const ins of inserts.get(tok.items.length) ?? []) {
    emit(ins, seen === 0)
    seen += 1
  }
  if (pieces.length === 0) return ''
  return pieces.join('\n')
}

/** Render an entire collection subtree (used when regions overlap). */
export function shadowedPair(
  source: string,
  node: Collection,
  c: CollectionChange,
  baseCtx: StringifyContext
): Pair {
  // Rebuild a pair for a duplicate-key occurrence that exists only in the
  // CST. The key text is copied verbatim from source; the value is the new
  // bound node.
  const tok = node.srcToken as BlockMap | FlowCollection
  const item = tok.items[c.cstIndex]
  const keyText = item.key
    ? source.slice(item.key.offset, tokenEnd(item.key))
    : ''
  const key = new Scalar(keyText)
  const pair = new Pair(key, c.pair?.value ?? c.seqNode ?? null)
  void baseCtx
  return pair
}

export function leadForRender(
  source: string,
  isSeq: boolean,
  item: CollectionItem,
  c: CollectionChange
): string {
  if (!isSeq || c.mode !== 'replace') return ''
  const [begin] = blockSeqItemSpan(source, item)
  const dash = item.start.find(t => t.type === 'seq-item-ind')
  if (!dash) return ''
  const lead = source.slice(begin, dash.offset).replace(/^[ \t]+/, '')
  return lead.includes('#') ? lead : ''
}

export function renderWholeCollection(
  doc: Document,
  node: Collection,
  columnIndent: number,
  inFlow: boolean,
  toStringOptions?: ToStringOptions
): string {
  const baseCtx = createStringifyContext(doc, toStringOptions)
  const ctx = {
    ...baseCtx,
    indent: ' '.repeat(columnIndent),
    inFlow
  }
  return stringify(node, ctx)
}

export function spliceRegions(source: string, regions: PatchRegion[]): string {
  const sorted = [...regions].sort((a, b) => b.range[0] - a.range[0])
  let out = source
  for (const r of sorted)
    out = out.slice(0, r.range[0]) + r.text + out.slice(r.range[1])
  return out
}
