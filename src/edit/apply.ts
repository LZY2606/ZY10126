import type { Document } from '../doc/Document.ts'
import { Pair } from '../nodes/Pair.ts'
import { Scalar } from '../nodes/Scalar.ts'
import type { Collection, Node } from '../nodes/types.ts'
import { YAMLMap } from '../nodes/YAMLMap.ts'
import { YAMLSeq } from '../nodes/YAMLSeq.ts'
import { YAMLSet } from '../nodes/YAMLSet.ts'

/** A stable address of a map/set entry or sequence item in a snapshot. */
export interface Address {
  parent: Collection
  /** Map/set entry pair, when applicable. */
  pair?: Pair
  /** Sequence item node, when applicable. */
  seqNode?: Node
  /** CST item index in the parent's original token (real items only). */
  cstIndex: number
}

/**
 * A concrete, fully resolved mutation derived from one edit. Addresses refer
 * to the snapshot document; a node-identity map translates them when applying
 * to a clone.
 */
export type Mutation =
  | { kind: 'setRoot'; value: (doc: Document) => Node }
  | {
      kind: 'setExisting'
      address: Address
      /** New node created via the target document schema. */
      value: (doc: Document) => Node
      /** Occurrence index for duplicate-key edits. */
      occurrence?: number
      /** CST item index when editing a shadowed duplicate occurrence. */
      shadowedCstIndex?: number
    }
  | {
      kind: 'setNew'
      parent: Collection
      key: string | number
      value: (doc: Document) => Node
      insertCstIndex: number
    }
  | { kind: 'delete'; address: Address }
  | { kind: 'rename'; address: Address; newKey: (doc: Document) => Node }
  | {
      kind: 'move'
      source: Address
      destParent: Collection
      destKey: string | number
      destInsertIndex: number
    }

/** Binding property used by the edit-plan renderer to find newly created nodes. */
export const EDIT_BIND: unique symbol = Symbol('editPlanBind')

export function buildIdentityMap(
  fromDoc: Document,
  toDoc: Document
): Map<object, object> {
  const map = new Map<object, object>()
  map.set(fromDoc, toDoc)
  const walk = (a: any, b: any) => {
    if (!a || !b) return
    map.set(a as object, b as object)
    if (a instanceof YAMLSeq && b instanceof YAMLSeq && a.length === b.length) {
      for (let i = 0; i < a.length; ++i) walk(a[i], b[i])
    } else if (
      (a instanceof YAMLMap || a instanceof YAMLSet) &&
      (b instanceof YAMLMap || b instanceof YAMLSet)
    ) {
      const ap = [...a.values.values()]
      const bp = [...b.values.values()]
      if (ap.length === bp.length)
        for (let i = 0; i < ap.length; ++i) {
          map.set(ap[i] as object, bp[i] as object)
          walk(ap[i].key, bp[i].key)
          walk(ap[i].value, bp[i].value)
        }
    }
  }
  walk(fromDoc.value, toDoc.value)
  return map
}

export function t(map: Map<object, object>, value: any): any {
  if (value === null || value === undefined || typeof value !== 'object')
    return value
  return map.get(value) ?? value
}

/**
 * Apply mutations to the target document. All node creation happens here,
 * so failures in custom tag `createNode` abort before any structural change.
 */
export function applyMutations(
  target: Document,
  mutations: Mutation[],
  map: Map<object, object>
): void {
  const bindTo = (value: object, mutIndex: number): void => {
    Object.defineProperty(value, EDIT_BIND, {
      value: mutIndex,
      enumerable: false,
      configurable: true,
      writable: true
    })
  }

  // Pre-create replacement values first; throws from createNode propagate
  // before any structural mutation occurs.
  const prepared = mutations.map((mut, mutIndex) => {
    if (mut.kind === 'setRoot')
      return { mut, node: mut.value(target), bind: -2 }
    if (mut.kind === 'setExisting')
      return { mut, node: mut.value(target), bind: mutIndex }
    if (mut.kind === 'setNew')
      return { mut, node: mut.value(target), bind: mutIndex }
    if (mut.kind === 'rename')
      return { mut, node: mut.newKey(target), bind: mutIndex }
    return { mut, node: null, bind: mutIndex }
  })

  for (const { mut, node, bind } of prepared) {
    if (mut.kind === 'setRoot') {
      target.value = node as Document['value']
      continue
    }
    if (mut.kind === 'setExisting') {
      const parent = t(map, mut.address.parent) as Collection
      if (parent instanceof YAMLSeq) {
        const idx = parent.indexOf(t(map, mut.address.seqNode))
        if (idx >= 0) {
          const prev = parent[idx]
          if (prev && node) transferProps(prev, node)
          parent.set(idx, node)
          if (node) bindTo(node, bind)
        }
      } else if (parent instanceof YAMLMap) {
        const pair = t(map, mut.address.pair) as Pair
        if (mut.shadowedCstIndex !== undefined) {
          if (node) bindTo(node, bind)
        } else {
          // Preserve anchor/tag/comment metadata on the replaced node so
          // aliases keep resolving.
          if (pair.value && node) transferProps(pair.value, node)
          pair.value = node
          if (node) bindTo(node, bind)
        }
      } else if (parent instanceof YAMLSet) {
        // sets ignore values; treat as no-op
      }
    } else if (mut.kind === 'setNew') {
      const parent = t(map, mut.parent) as YAMLMap | YAMLSeq | YAMLSet
      if (parent instanceof YAMLSeq) {
        const idx = Math.min(mut.insertCstIndex, parent.length)
        parent.splice(idx, 0, node)
        if (node) bindTo(node, bind)
      } else if (parent instanceof YAMLSet) {
        parent.add(target.createNode(mut.key))
      } else {
        const pair = new Pair(
          target.createNode(mut.key) as unknown as Scalar<string>,
          node
        )
        parent.set(pair)
        if (node) bindTo(node, bind)
        bindTo(pair, bind)
      }
    } else if (mut.kind === 'delete') {
      const parent = t(map, mut.address.parent) as Collection
      if (parent instanceof YAMLSeq) {
        const idx = parent.indexOf(t(map, mut.address.seqNode))
        if (idx >= 0) parent.splice(idx, 1)
      } else if (parent instanceof YAMLMap || parent instanceof YAMLSet) {
        const pair = t(map, mut.address.pair) as Pair
        parent.values.delete(parent.keyOf(pair.key, true))
      }
    } else if (mut.kind === 'rename') {
      const pair = t(map, mut.address.pair) as Pair
      if (pair.key instanceof Scalar && node instanceof Scalar) {
        node.commentBefore = pair.key.commentBefore
        node.spaceBefore = pair.key.spaceBefore
      }
      const parent = t(map, mut.address.parent) as YAMLMap
      replaceMapKey(parent, pair, node as Node)
    } else if (mut.kind === 'move') {
      applyMove(target, mut, map, bind)
    }
  }
}

function transferProps(from: unknown, to: unknown): void {
  if (!from || !to || typeof from !== 'object' || typeof to !== 'object') return
  const f = from as Record<string, unknown>
  const g = to as Record<string, unknown>
  if (typeof f.anchor === 'string' && g.anchor === undefined)
    g.anchor = f.anchor
  if (typeof f.tag === 'string' && g.tag === undefined) g.tag = f.tag
}

function replaceMapKey(parent: YAMLMap, pair: Pair, newKey: Node): void {
  const entries = [...parent.values]
  const idx = entries.findIndex(([, p]) => p === pair)
  if (idx < 0) return
  pair.key = newKey
  entries[idx] = [parent.schema.mapKey(newKey), pair]
  parent.values = new Map(entries)
}

function applyMove(
  target: Document,
  mut: Extract<Mutation, { kind: 'move' }>,
  map: Map<object, object>,
  bind: number
): void {
  const bindTo = (value: object): void => {
    Object.defineProperty(value, EDIT_BIND, {
      value: bind,
      enumerable: false,
      configurable: true,
      writable: true
    })
  }
  const srcParent = t(map, mut.source.parent) as Collection
  let moved: Node | null = null
  let movedPair: Pair | null = null
  if (srcParent instanceof YAMLSeq) {
    const idx = srcParent.indexOf(t(map, mut.source.seqNode))
    if (idx < 0) return
    moved = (srcParent.splice(idx, 1)[0] ?? null) as Node | null
  } else if (srcParent instanceof YAMLMap || srcParent instanceof YAMLSet) {
    const pair = t(map, mut.source.pair) as Pair
    moved = pair.value ?? pair.key
    movedPair = pair
    srcParent.values.delete(srcParent.keyOf(pair.key, true))
  }
  if (!moved) return

  const destParent = t(map, mut.destParent) as Collection
  if (destParent instanceof YAMLSeq) {
    let idx = mut.destKey as number
    if (idx < 0) idx += destParent.length + 1
    idx = Math.max(0, Math.min(idx, destParent.length))
    destParent.splice(idx, 0, moved)
    bindTo(moved)
  } else if (destParent instanceof YAMLSet) {
    destParent.add(movedPair?.key ?? target.createNode(mut.destKey))
  } else if (destParent instanceof YAMLMap) {
    const key = movedPair
      ? movedPair.key
      : (target.createNode(mut.destKey) as Node)
    const pair = new Pair(key, moved)
    if (movedPair) pair.key = movedPair.key
    destParent.set(pair)
    bindTo(pair)
    bindTo(moved)
  }
}
