import type { Document } from '../doc/Document.ts'
import { Pair } from '../nodes/Pair.ts'
import type { Collection, Node, Range } from '../nodes/types.ts'
import { YAMLMap } from '../nodes/YAMLMap.ts'
import { YAMLSeq } from '../nodes/YAMLSeq.ts'
import { YAMLSet } from '../nodes/YAMLSet.ts'
import { EDIT_BIND, type Mutation } from './apply.ts'
import {
  getCollectionToken,
  getReplacementRange,
  renderChangedCollection,
  renderWholeCollection,
  type CollectionChange,
  type PatchRegion
} from './engine.ts'
import type { ToStringOptions } from '../options.ts'

interface ParentChanges {
  node: Collection
  changes: CollectionChange[]
}

/**
 * Group mutations by their affected original snapshot collection and build
 * source replacement regions. When a changed item's value contains another
 * changed collection, rendering is scoped to that item rather than emitted
 * as a separate region (which would overlap).
 */
export function renderRegions(
  doc: Document,
  source: string,
  mutations: Mutation[],
  toStringOptions?: ToStringOptions
): {
  regions: PatchRegion[]
  widened: Array<{ range: Range; reason: string }>
} {
  const byParent = new Map<Collection, ParentChanges>()

  const ensure = (node: Collection): ParentChanges => {
    let entry = byParent.get(node)
    if (!entry) {
      entry = { node, changes: [] }
      byParent.set(node, entry)
    }
    return entry
  }

  mutations.forEach((mut, mutIndex) => {
    if (mut.kind === 'setExisting') {
      const { parent } = mut.address
      const pc = ensure(parent)
      if (parent instanceof YAMLSeq)
        pc.changes.push({
          node: parent,
          cstIndex: mut.address.cstIndex,
          mode: 'replace',
          mutIndex,
          seqNode: mut.address.seqNode,
          reason: 'set sequence item'
        })
      else
        pc.changes.push({
          node: parent,
          cstIndex: mut.address.cstIndex,
          mode: 'replace',
          mutIndex,
          pair: mut.address.pair,
          shadowed: mut.shadowedCstIndex !== undefined,
          reason: 'set map value'
        })
    } else if (mut.kind === 'setNew') {
      const pc = ensure(mut.parent)
      pc.changes.push({
        node: mut.parent,
        cstIndex: -1,
        mode: 'replace',
        insert: true,
        insertAt: mut.insertCstIndex,
        mutIndex,
        reason: 'insert new entry'
      })
      // pair/seqNode are taken from the live mutated document below
    } else if (mut.kind === 'delete') {
      const { parent } = mut.address
      const pc = ensure(parent)
      pc.changes.push({
        node: parent,
        cstIndex: mut.address.cstIndex,
        mode: 'delete',
        pair: mut.address.pair,
        seqNode: mut.address.seqNode,
        reason: 'delete entry'
      })
    } else if (mut.kind === 'rename') {
      const pc = ensure(mut.address.parent)
      pc.changes.push({
        node: mut.address.parent,
        cstIndex: mut.address.cstIndex,
        mode: 'replace',
        mutIndex,
        pair: mut.address.pair,
        reason: 'rename key'
      })
    } else if (mut.kind === 'move') {
      const sameParent =
        mut.source.parent === mut.destParent &&
        (mut.source.parent instanceof YAMLSeq ||
          mut.source.parent instanceof YAMLMap ||
          mut.source.parent instanceof YAMLSet)
      if (sameParent) {
        const pc = ensure(mut.source.parent)
        // In-place reorder: no delete + separate insert, one moved entry.
        pc.changes.push({
          node: mut.source.parent,
          cstIndex: mut.source.cstIndex,
          mode: 'replace',
          mutIndex,
          moveTo: mut.destInsertIndex,
          reason: 'reorder entry'
        })
        return
      }
      const spc = ensure(mut.source.parent)
      spc.changes.push({
        node: mut.source.parent,
        cstIndex: mut.source.cstIndex,
        mode: 'delete',
        pair: mut.source.pair,
        seqNode: mut.source.seqNode,
        reason: 'move: remove subtree'
      })
      const dpc = ensure(mut.destParent)
      dpc.changes.push({
        node: mut.destParent,
        cstIndex: -1,
        mode: 'replace',
        insert: true,
        insertAt: mut.destInsertIndex,
        mutIndex,
        reason: 'move: insert subtree'
      })
    }
  })

  // Resolve inserted pairs/nodes against the now-mutated document.
  bindInsertedNodes(doc, byParent, mutations)
  bindShadowedNodes(doc, byParent, mutations)
  bindLiveNodes(byParent)

  // When a changed collection is nested inside an *entry* of an ancestor
  // changed collection, mark that ancestor entry as fully re-rendered so
  // no overlapping child region is emitted.
  for (const ancestor of byParent.values()) {
    for (const child of byParent.keys()) {
      if (child === ancestor.node) continue
      if (!(child.range && child.srcToken)) continue
      const entry = enclosingEntry(ancestor.node, child.range)
      if (entry === null) continue
      const change = ancestor.changes.find(
        c => !c.insert && c.mode !== 'delete' && c.cstIndex === entry
      )
      if (change) {
        change._swallow = true
        change.reason += '; contains nested edit: item fully re-rendered'
      } else {
        // The enclosing entry itself is unmodified but contains a changed
        // descendant; add a synthetic replace so it renders from live data.
        const nodeOrPair = liveEntryAt(ancestor.node, entry)
        ancestor.changes.push(
          ancestor.node instanceof YAMLSeq &&
            !(ancestor.node instanceof YAMLSet)
            ? {
                node: ancestor.node,
                cstIndex: entry,
                mode: 'replace' as const,
                seqNode: nodeOrPair as Node,
                reason: 'contains nested edit: item fully re-rendered',
                _swallow: true
              }
            : {
                node: ancestor.node,
                cstIndex: entry,
                mode: 'replace' as const,
                pair: nodeOrPair as Pair,
                reason: 'contains nested edit: item fully re-rendered',
                _swallow: true
              }
        )
      }
    }
  }

  const regions: PatchRegion[] = []
  const widened: Array<{ range: Range; reason: string }> = []
  outer: for (const pc of byParent.values()) {
    // Skip this collection if it is swallowed by a changed item in an
    // ancestor collection.
    for (const ancestor of byParent.values()) {
      if (ancestor === pc) continue
      if (
        ancestor.changes.some(
          c =>
            (c as CollectionChange & { _swallow?: boolean })._swallow &&
            collectionContains(
              c.seqNode ?? (c.pair?.value as Node | null),
              pc.node
            )
        )
      )
        continue outer
    }

    const region = renderChangedCollection(
      doc,
      source,
      pc.node,
      pc.changes,
      toStringOptions
    )
    if (region) regions.push(region)
    else {
      // No token (e.g. synthetic collection): widen to whole subtree.
      const whole = renderWholeFallback(doc, pc.node, toStringOptions)
      if (whole) {
        regions.push(whole.region)
        widened.push({ range: whole.region.range, reason: whole.region.reason })
      }
    }
  }

  return { regions, widened }
}

function collectionContains(container: any, node: Collection): boolean {
  if (!container) return false
  if (container === node) return true
  if (container instanceof YAMLSeq)
    return container.some(item => collectionContains(item, node))
  if (container instanceof YAMLMap || container instanceof YAMLSet) {
    for (const p of container.values.values() as Iterable<Pair>) {
      if (p.key === node || p.value === node) return true
      if (collectionContains(p.key, node)) return true
      if (collectionContains(p.value, node)) return true
    }
  }
  return false
}

function renderWholeFallback(
  doc: Document,
  node: Collection,
  toStringOptions?: ToStringOptions
): { region: PatchRegion } | null {
  const tok = getCollectionToken(node)
  const range = getReplacementRange(node)
  if (!range) return null
  const indent = tok ? tok.indent : 0
  const inFlow = tok?.type === 'flow-collection'
  const text = renderWholeCollection(doc, node, indent, inFlow, toStringOptions)
  return {
    region: {
      range,
      text,
      reason:
        'rewrite scope widened to full collection (missing srcToken or unsupported inline edit)'
    }
  }
}

function bindShadowedNodes(
  doc: Document,
  byParent: Map<Collection, ParentChanges>,
  mutations: Mutation[]
): void {
  for (const pc of byParent.values()) {
    for (const c of pc.changes) {
      if (!c.shadowed || c.mutIndex === undefined || !c.pair) continue
      const mut = mutations[c.mutIndex]
      if (mut?.kind !== 'setExisting') continue
      const node = mut.value(doc)
      ;(c.pair as any).value = node
    }
  }
}

function bindInsertedNodes(
  doc: Document,
  byParent: Map<Collection, ParentChanges>,
  _mutations: Mutation[]
): void {
  // Collect every node/pair tagged with a mutation index, then point the
  // matching replace change at the live value.
  const boundNodes = new Map<number, Node>()
  const boundPairs = new Map<number, Pair>()
  const visit = (n: any): void => {
    if (!n || typeof n !== 'object') return
    const b = n[EDIT_BIND]
    if (typeof b === 'number') {
      if (!boundNodes.has(b)) boundNodes.set(b, n as Node)
    }
    if (n instanceof YAMLSeq) for (const it of n) visit(it)
    else if (n instanceof YAMLMap || n instanceof YAMLSet)
      for (const pair of n.values.values() as Iterable<Pair>) {
        const pb = (pair as any)[EDIT_BIND]
        if (typeof pb === 'number') boundPairs.set(pb, pair)
        visit(pair.key)
        visit(pair.value)
      }
  }
  visit(doc.value)

  for (const pc of byParent.values()) {
    for (const c of pc.changes) {
      if (c.mode !== 'replace' || c.mutIndex === undefined) continue
      if (pc.node instanceof YAMLSeq && !(pc.node instanceof YAMLSet)) {
        const n = boundNodes.get(c.mutIndex)
        if (n) c.seqNode = n
      } else {
        const pair = boundPairs.get(c.mutIndex)
        if (pair) c.pair = pair
        else if (c.shadowed) {
          const node = boundNodes.get(c.mutIndex)
          if (node && c.pair) c.pair = new Pair(c.pair.key, node)
        }
      }
    }
  }
}

/**
 * After mutation, re-point every replace/delete change at the live node/pair
 * occupying its CST slot. New nodes created by createNode are not in the
 * original snapshot, so rendering the old node would lose the edit.
 */
function bindLiveNodes(byParent: Map<Collection, ParentChanges>): void {
  for (const pc of byParent.values()) {
    const { node } = pc
    if (node instanceof YAMLSeq) {
      const tok = node.srcToken as
        | {
            items: Array<{
              value?: unknown
              start: Array<{ type: string }>
            }>
          }
        | undefined
      if (!tok) continue
      const live: Node[] = []
      // After deletions/insertions the CST no longer aligns; align by
      // consuming entries in order for non-deleted original slots.
      const deleted = new Set(
        pc.changes.filter(c => c.mode === 'delete').map(c => c.cstIndex)
      )
      let li = 0
      for (let ci = 0; ci < tok.items.length; ++ci) {
        const it = tok.items[ci]
        if (
          it.value === undefined &&
          !it.start.some(t => t.type === 'seq-item-ind')
        )
          continue
        if (deleted.has(ci)) {
          li += 0
          continue
        }
        live.push(node[li] as Node)
        li += 1
      }
      for (const c of pc.changes) {
        if (c.mode === 'replace' && !c.insert && c.mutIndex === undefined) {
          // nth non-deleted slot
          let slot = 0
          for (let ci = 0; ci < c.cstIndex; ++ci)
            if (!deleted.has(ci) && isRealSeqCstItem(tok.items[ci])) slot += 1
          c.seqNode = live[slot]
        }
      }
    } else if (node instanceof YAMLMap || node instanceof YAMLSet) {
      const tok = node.srcToken as
        | { type: string; items: Array<{ key?: unknown; sep?: unknown }> }
        | undefined
      if (!tok) continue
      const deleted = new Set(
        pc.changes.filter(c => c.mode === 'delete').map(c => c.cstIndex)
      )
      const pairs = [...node.values.values()] as Pair[]
      let pi = 0
      const liveByCst = new Map<number, Pair>()
      for (let ci = 0; ci < tok.items.length; ++ci) {
        if (tok.items[ci].key === undefined && tok.items[ci].sep === undefined)
          continue
        if (deleted.has(ci)) continue
        liveByCst.set(ci, pairs[pi])
        pi += 1
      }
      for (const c of pc.changes)
        if (c.mode === 'replace' && !c.insert && c.mutIndex === undefined)
          c.pair = liveByCst.get(c.cstIndex) ?? c.pair
    }
  }
}

function isRealSeqCstItem(it: {
  value?: unknown
  start: Array<{ type: string }>
}): boolean {
  return it.value !== undefined || it.start.some(t => t.type === 'seq-item-ind')
}

/** Find the CST item index in `parent` that encloses the given range. */
function enclosingEntry(parent: Collection, range: Range): number | null {
  if (parent instanceof YAMLSeq) {
    const pairs = parent
    for (let i = 0; i < pairs.length; ++i) {
      const r = (pairs[i] as { range?: Range }).range
      if (r && r[0] <= range[0] && range[1] <= r[1])
        return cstIndexForSeq(parent, i)
    }
  } else if (parent instanceof YAMLMap || parent instanceof YAMLSet) {
    const pairs = [...parent.values.values()] as Pair[]
    for (let i = 0; i < pairs.length; ++i) {
      const v = pairs[i].value ?? pairs[i].key
      const r = (v as { range?: Range }).range
      if (r && r[0] <= range[0] && range[1] <= r[1])
        return cstIndexForMap(parent, i)
    }
  }
  return null
}

function cstIndexForSeq(seq: YAMLSeq, semanticIndex: number): number {
  const tok = seq.srcToken as
    | { items?: Array<{ value?: unknown; start: Array<{ type: string }> }> }
    | undefined
  if (!tok?.items) return semanticIndex
  let n = -1
  for (let ci = 0; ci < tok.items.length; ++ci) {
    const it = tok.items[ci]
    if (it.value !== undefined || it.start.some(t => t.type === 'seq-item-ind'))
      n += 1
    if (n === semanticIndex) return ci
  }
  return semanticIndex
}

function cstIndexForMap(map: YAMLMap | YAMLSet, semanticIndex: number): number {
  const tok = map.srcToken as
    { items?: Array<{ key?: unknown; sep?: unknown }> } | undefined
  if (!tok?.items) return semanticIndex
  let n = -1
  for (let ci = 0; ci < tok.items.length; ++ci) {
    if (tok.items[ci].key !== undefined || tok.items[ci].sep !== undefined)
      n += 1
    if (n === semanticIndex) return ci
  }
  return semanticIndex
}

function liveEntryAt(parent: Collection, cstIndex: number): Node | Pair {
  if (parent instanceof YAMLSeq)
    return parent[seqSemanticIndex(parent, cstIndex)]
  const pairs = [...parent.values.values()] as Pair[]
  return pairs[mapSemanticIndex(parent, cstIndex)]
}

function seqSemanticIndex(seq: YAMLSeq, cstIndex: number): number {
  let n = -1
  const tok = seq.srcToken as
    | { items?: Array<{ value?: unknown; start: Array<{ type: string }> }> }
    | undefined
  if (!tok?.items) return cstIndex
  for (let ci = 0; ci < tok.items.length; ++ci) {
    const it = tok.items[ci]
    if (it.value !== undefined || it.start.some(t => t.type === 'seq-item-ind'))
      n += 1
    if (ci === cstIndex) return n
  }
  return n
}

function mapSemanticIndex(map: YAMLMap | YAMLSet, cstIndex: number): number {
  let n = -1
  const tok = map.srcToken as
    { items?: Array<{ key?: unknown; sep?: unknown }> } | undefined
  if (!tok?.items) return cstIndex
  for (let ci = 0; ci < tok.items.length; ++ci) {
    if (tok.items[ci].key !== undefined || tok.items[ci].sep !== undefined)
      n += 1
    if (ci === cstIndex) return n
  }
  return n
}
