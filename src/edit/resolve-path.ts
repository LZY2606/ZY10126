import type { Document } from '../doc/Document.ts'
import { Pair } from '../nodes/Pair.ts'
import { Scalar } from '../nodes/Scalar.ts'
import type { CollectionItem } from '../parse/cst.ts'
import type { Collection, Node, Range } from '../nodes/types.ts'
import { YAMLMap } from '../nodes/YAMLMap.ts'
import { YAMLSeq } from '../nodes/YAMLSeq.ts'
import { YAMLSet } from '../nodes/YAMLSet.ts'
import type { EditPath, EditPathSegment } from './types.ts'

export interface KeyCandidate {
  pair: Pair
  cstItem?: CollectionItem
  cstIndex?: number
  /** Zero-based occurrence among equal keys in source order. */
  occurrence: number
  /** True when this candidate is the live value in the semantic model. */
  live: boolean
  /** True when only the CST retains this occurrence (semantic map dropped it). */
  shadowed?: boolean
}

function segmentKey(seg: EditPathSegment): string | number {
  return typeof seg === 'object' && seg !== null ? seg.key : seg
}
function segmentOccurrence(seg: EditPathSegment): number {
  return typeof seg === 'object' && seg !== null ? seg.occurrence : 0
}

function keyMatches(
  pair: Pair,
  key: string | number,
  schema: Document['schema']
): boolean {
  if (pair.key instanceof Scalar) {
    if (typeof pair.key.source === 'string' && pair.key.source === String(key))
      return true
  }
  if (
    key === '<<' &&
    pair.key instanceof Scalar &&
    typeof pair.key.value === 'symbol' &&
    pair.key.value.description === '<<'
  )
    return true
  if (pair.key instanceof Scalar) {
    if (pair.key.value === key) return true
    if (typeof key === 'number' && pair.key.value === String(key)) return true
  }
  try {
    return schema.mapKey(pair.key) === schema.mapKey(key)
  } catch {
    return false
  }
}

/**
 * Enumerate all pairs matching a key in a map or set in source order,
 * including duplicate keys whose value is shadowed in the semantic map.
 */
export function findMapCandidates(
  map: YAMLMap | YAMLSet,
  key: string | number,
  schema: Document['schema']
): KeyCandidate[] {
  const semanticPairs: Pair[] = Array.from(
    map.values.values() as Iterable<Pair>
  )
  const cstToken = map.srcToken
  const cstItems =
    cstToken &&
    (cstToken.type === 'block-map' || cstToken.type === 'flow-collection')
      ? cstToken.items
      : []

  interface Ordered {
    pair: Pair | null
    cstItem?: CollectionItem
    cstIndex?: number
    keyText: string | null
  }

  const ordered: Ordered[] = []
  if (cstItems.length) {
    // Queue semantic pairs keyed by their source text. Each real CST entry
    // consumes the first still-unused pair with the same key source;
    // duplicate occurrences that the semantic model dropped leave a
    // placeholder (pair === null).
    const queue = new Map<string, Pair[]>()
    for (const pair of semanticPairs) {
      const text =
        pair.key instanceof Scalar && typeof pair.key.source === 'string'
          ? pair.key.source
          : String((pair.key as Scalar).value)
      const list = queue.get(text) ?? []
      list.push(pair)
      queue.set(text, list)
    }
    for (let ci = 0; ci < cstItems.length; ++ci) {
      const item = cstItems[ci]
      if (!item.key && !item.sep) continue
      const keyText = cstKeyText(item)
      const list = keyText === null ? null : (queue.get(keyText) ?? null)
      if (list && list.length > 0) {
        ordered.push({
          pair: list.shift()!,
          cstItem: item,
          cstIndex: ci,
          keyText
        })
      } else {
        ordered.push({ pair: null, cstItem: item, cstIndex: ci, keyText })
      }
    }
  } else {
    for (const pair of semanticPairs)
      ordered.push({
        pair,
        keyText:
          pair.key instanceof Scalar && typeof pair.key.source === 'string'
            ? pair.key.source
            : null
      })
  }

  const targetText = String(key)
  let occurrence = 0
  const out: KeyCandidate[] = []
  const livePairSet = new Set<Pair>(map.values.values() as Iterable<Pair>)
  for (const entry of ordered) {
    const matchesSemantic = entry.pair
      ? keyMatches(entry.pair, key, schema)
      : entry.keyText !== null && entry.keyText === targetText
    if (!matchesSemantic) continue
    if (entry.pair) {
      out.push({
        pair: entry.pair,
        cstItem: entry.cstItem,
        cstIndex: entry.cstIndex,
        occurrence: occurrence++,
        live: livePairSet.has(entry.pair)
      })
    } else if (entry.cstItem) {
      out.push({
        pair: cstPlaceholderPair(entry.cstItem),
        cstItem: entry.cstItem,
        cstIndex: entry.cstIndex,
        occurrence: occurrence++,
        live: false,
        shadowed: true
      })
    }
  }
  return out
}

function cstKeyText(item: CollectionItem): string | null {
  const k = item.key
  if (
    k &&
    'source' in k &&
    typeof (k as { source?: unknown }).source === 'string'
  )
    return (k as { source: string }).source
  return null
}

function cstPlaceholderPair(item: CollectionItem): Pair {
  // A minimal pair used to carry the CST item of a shadowed duplicate key.
  // The semantic model does not retain this occurrence.
  return Object.assign(new Pair(new Scalar(null)), {
    srcToken: item
  })
}

export interface SeqCandidate {
  index: number
  node: Node
  cstItem?: CollectionItem
  cstIndex?: number
}

export function getSeqCandidates(
  seq: YAMLSeq,
  index: number
): SeqCandidate | null {
  const idx = index < 0 ? index + seq.length : index
  if (!Number.isInteger(idx) || idx < 0 || idx >= seq.length) return null
  const node = seq[idx]
  let cstItem: CollectionItem | undefined
  let cstIndex: number | undefined
  const cst = seq.srcToken
  if (cst && (cst.type === 'block-seq' || cst.type === 'flow-collection')) {
    const withValue = cst.items
      .map((item, i) => ({ item, i }))
      .filter(
        ({ item }) =>
          item.value !== undefined ||
          item.start.some(t => t.type === 'seq-item-ind')
      )
    const hit = withValue[idx]
    if (hit) {
      cstItem = hit.item
      cstIndex = hit.i
    }
  }
  return { index: idx, node: node as Node, cstItem, cstIndex }
}

export interface ResolveFailure {
  kind: 'missing' | 'type-mismatch'
  /** Path up to and including the failing segment. */
  path: EditPath
  parent: Collection | Document
}

export interface ResolvedNode {
  node: Node
  parent: Collection | Document
  pair?: Pair
  cstItem?: CollectionItem
  cstIndex?: number
  occurrence: number
  /** All candidates for the terminal segment (maps only). */
  candidates?: KeyCandidate[]
  /** True when the selected candidate is not in the live semantic map. */
  shadowed?: boolean
  range?: Range
}

/**
 * Resolve a semantic path against a parsed document snapshot without
 * mutating it. Numeric segments require sequences; string segments maps.
 *
 * Duplicate-key candidates are all returned; the caller decides whether the
 * ambiguity is acceptable.
 */
export function resolvePath(
  doc: Document,
  path: EditPath
): { resolved?: ResolvedNode; failure?: ResolveFailure } {
  let node: Node = doc.value
  let parent: Collection | Document = doc
  let state: Omit<ResolvedNode, 'node' | 'range'> = {
    parent,
    occurrence: 0
  }

  for (let depth = 0; depth < path.length; ++depth) {
    const seg = path[depth]
    const key = segmentKey(seg)
    const wantedOccurrence = segmentOccurrence(seg)
    const here = path.slice(0, depth + 1)

    if (typeof key === 'number') {
      if (!(node instanceof YAMLSeq))
        return { failure: { kind: 'type-mismatch', path: here, parent } }
      const hit = getSeqCandidates(node, key)
      if (!hit)
        return { failure: { kind: 'missing', path: here, parent: node } }
      parent = node
      node = hit.node
      state = {
        parent,
        cstItem: hit.cstItem,
        cstIndex: hit.cstIndex,
        occurrence: 0
      }
    } else {
      if (!(node instanceof YAMLMap || node instanceof YAMLSet))
        return { failure: { kind: 'type-mismatch', path: here, parent } }
      const candidates = findMapCandidates(node, key, doc.schema)
      if (candidates.length === 0)
        return { failure: { kind: 'missing', path: here, parent: node } }
      const selected =
        candidates.find(c => c.occurrence === wantedOccurrence) ??
        candidates[candidates.length - 1]
      parent = node
      state = {
        parent,
        pair: selected.pair,
        cstItem: selected.cstItem,
        cstIndex: selected.cstIndex,
        occurrence: selected.occurrence,
        candidates,
        shadowed: selected.shadowed === true
      }
      node = selected.pair.value ?? selected.pair.key
    }
  }

  return {
    resolved: {
      node,
      range: node?.range ?? undefined,
      ...state
    }
  }
}
