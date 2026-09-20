import { isCollection } from '../nodes/identity.ts'
import type { Node } from '../nodes/types.ts'
import type {
  CollectionItem,
  FlowCollection,
  BlockMap,
  Token
} from '../parse/cst.ts'
import { Pair } from '../nodes/Pair.ts'
import { Scalar } from '../nodes/Scalar.ts'
import { YAMLMap } from '../nodes/YAMLMap.ts'
import { YAMLSeq } from '../nodes/YAMLSeq.ts'
import type {
  EditPath,
  MapSegment,
  PathKey,
  PathSegment,
  SeqSegment
} from './types.ts'

export function isSeqSegment(seg: unknown): seg is SeqSegment {
  return (
    typeof seg === 'object' &&
    seg !== null &&
    (seg as { kind?: unknown }).kind === 'seq'
  )
}

export function isMapSegment(seg: unknown): seg is MapSegment {
  return (
    typeof seg === 'object' &&
    seg !== null &&
    (seg as { kind?: unknown }).kind === 'map'
  )
}

/** Normalise a user-provided segment to an explicit selector. */
export function normalizeSegment(seg: PathSegment): MapSegment | SeqSegment {
  if (typeof seg === 'object' && seg !== null && 'kind' in seg) return seg
  if (isCollection(seg) || seg instanceof Pair || seg instanceof Scalar)
    return { key: seg as PathKey, kind: 'map' }
  if (typeof seg === 'number' && Number.isInteger(seg))
    return { key: seg, kind: 'map' }
  return { key: seg as PathKey, kind: 'map' }
}

type Primitive = string | number | bigint | boolean | null

export interface MapItem {
  /** The composed pair; undefined for collapsed duplicate occurrences. */
  pair?: Pair
  /** Raw source key text, used to group duplicate occurrences. */
  keyText: string | null
  /** CST entry for this item, when source tokens were kept. */
  cst?: CollectionItem
  /** Start offset of the entry (its leading whitespace), if known. */
  startOffset?: number
  /** End offset (node end) of the entry value, if known. */
  endOffset?: number
  /** True for a collapsed duplicate (no live semantic pair). */
  collapsed: boolean
}

function isMapToken(
  token: BlockMap | FlowCollection | undefined
): token is BlockMap | FlowCollection {
  return !!token && 'items' in token
}

/**
 * Enumerate the entries of a mapping in source order, including collapsed
 * duplicate-key occurrences that are not present in the semantic map.
 */
export function mapItems(map: YAMLMap): MapItem[] {
  const token = map.srcToken
  if (isMapToken(token)) {
    const live: Pair[] = Array.from(map.values.values())
    // Index live pairs by their key start offset so that collapsed duplicate
    // occurrences align correctly (the semantic map keeps the last entry).
    const liveByOffset = new Map<number, Pair>()
    for (const pair of live)
      if (pair.key.range) liveByOffset.set(pair.key.range[0], pair)

    const items: MapItem[] = []
    for (const cst of token.items) {
      const isEntry =
        ('key' in cst && cst.key != null) ||
        ('sep' in cst && cst.sep && cst.sep.length > 0)
      if (!isEntry) continue
      const keyToken = cst.key as { offset?: number } | null
      const keyOffset = keyToken ? keyToken.offset : undefined
      const pair =
        keyOffset !== undefined ? liveByOffset.get(keyOffset) : undefined
      const keyText = cst.key ? tokenText(cst.key) : null
      const startOffset = cst.start?.[0]?.offset
      let endOffset: number | undefined
      const valueToken = cst.value
      if (valueToken) endOffset = tokenEnd(valueToken)
      items.push({
        pair,
        keyText,
        cst,
        startOffset,
        endOffset,
        collapsed: pair === undefined
      })
    }
    if (items.length >= live.length) return items
  }
  return Array.from(map.values.values()).map(pair => ({
    pair,
    keyText: pair.key instanceof Scalar ? String(pair.key.value) : null,
    collapsed: false
  }))
}

function tokenText(token: Token): string | null {
  if ('source' in token && typeof token.source === 'string') return token.source
  return null
}

/** End offset of a value token, approximating when metadata is absent. */
function tokenEnd(token: Token): number | undefined {
  if ('offset' in token) {
    const off = token.offset
    if (typeof (token as { source?: string }).source === 'string')
      return off + (token as { source: string }).source.length
    return off
  }
  return undefined
}

/** Group repeated-key occurrences for a mapping, keyed by raw source text. */
export function duplicateGroups(map: YAMLMap): Map<string, MapItem[]> {
  const groups = new Map<string, MapItem[]>()
  for (const item of mapItems(map)) {
    if (item.keyText === null) continue
    const list = groups.get(item.keyText)
    if (list) list.push(item)
    else groups.set(item.keyText, [item])
  }
  for (const [key, list] of groups) if (list.length < 2) groups.delete(key)
  return groups
}

export interface ResolvedStep {
  container: Node
  pair?: Pair
  node?: Node | Pair | null
  index?: number
  kind: 'map' | 'seq'
  intermediateMissing?: boolean
}

interface MatchResult {
  pair?: Pair
  index: number
  occurrences: MapItem[]
  conflict?: 'duplicate'
}

/** Find the live pair for a mapping key, together with duplicate metadata. */
export function findMapEntry(map: YAMLMap, seg: MapSegment): MatchResult {
  const wanted = seg.key
  const wantedNode =
    wanted instanceof Scalar || isCollection(wanted) ? wanted : null
  const wantedScalar: Primitive | undefined =
    wantedNode === null &&
    (wanted === null ||
      typeof wanted === 'string' ||
      typeof wanted === 'number' ||
      typeof wanted === 'boolean' ||
      typeof wanted === 'bigint')
      ? wanted
      : undefined

  const items = mapItems(map)
  const occurrences: MapItem[] = []
  for (const item of items) {
    const matchLive = item.pair
      ? pairMatches(item.pair, wantedNode, wantedScalar)
      : false
    const matchCollapsed =
      !item.pair &&
      item.keyText !== null &&
      wantedScalar !== undefined &&
      item.keyText === String(wantedScalar)
    if (matchLive || matchCollapsed) occurrences.push(item)
  }

  const live = occurrences.filter(o => o.pair)
  const idxOf = (item: MapItem) => items.indexOf(item)

  if (occurrences.length > 1) {
    if (seg.candidate === undefined)
      return {
        pair: live[0]?.pair,
        index: live[0] ? idxOf(live[0]) : -1,
        occurrences,
        conflict: 'duplicate'
      }
    const candidate =
      seg.candidate < 0 ? occurrences.length + seg.candidate : seg.candidate
    const chosen = occurrences[candidate]
    if (!chosen?.pair) return { index: -1, occurrences, conflict: 'duplicate' }
    return { pair: chosen.pair, index: idxOf(chosen), occurrences }
  }

  if (live.length === 1)
    return { pair: live[0].pair, index: idxOf(live[0]), occurrences }

  // Fallback to a semantic lookup (handles non-scalar/identity keys).
  const pair = map.getPair(wanted)
  if (pair) {
    const idx = items.findIndex(it => it.pair === pair)
    return {
      pair,
      index: idx,
      occurrences: [{ pair, keyText: null, collapsed: false }]
    }
  }
  return { index: -1, occurrences: [] }
}

function pairMatches(
  pair: Pair,
  wantedNode: Node | null,
  wantedScalar: Primitive | undefined
): boolean {
  const { key } = pair
  if (wantedNode) return key === wantedNode
  if (wantedScalar !== undefined)
    return key instanceof Scalar && key.value === wantedScalar
  return false
}

/**
 * Resolve a full path against the snapshot document, returning each step.
 * Resolution uses stable node identity; sequence indices are bound at
 * resolve time so later mutations cannot shift earlier resolutions.
 */
export function resolvePath(
  root: Node,
  path: EditPath
): { steps: ResolvedStep[]; found: boolean; leaf: Node | Pair | null } {
  const steps: ResolvedStep[] = []
  let current: Node = root

  for (const raw of path) {
    const seg = normalizeSegment(raw)
    if (seg.kind === 'seq') {
      if (!(current instanceof YAMLSeq))
        return { steps, found: false, leaf: current }
      const len = current.length
      let index = seg.index
      if (index < 0) index += len
      const node = index >= 0 && index < len ? current[index] : undefined
      if (node === undefined) return { steps, found: false, leaf: current }
      steps.push({ container: current, node, index, kind: 'seq' })
      current = node as Node
    } else {
      if (!(current instanceof YAMLMap))
        return { steps, found: false, leaf: current }
      const found = findMapEntry(current, seg)
      if (!found.pair) return { steps, found: false, leaf: current }
      steps.push({
        container: current,
        pair: found.pair,
        node: found.pair.value ?? found.pair.key,
        index: found.index,
        kind: 'map'
      })
      current = found.pair.value ?? found.pair.key
    }
  }
  const last = steps[steps.length - 1]
  const leaf: Node | Pair | null = last
    ? (last.pair ?? (last.node as Node))
    : root
  return { steps, found: true, leaf }
}
