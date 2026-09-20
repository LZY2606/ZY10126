import type { Document, DocValue } from '../doc/Document.ts'
import { isNode } from '../nodes/identity.ts'
import { Pair } from '../nodes/Pair.ts'
import { Scalar } from '../nodes/Scalar.ts'
import type { Node } from '../nodes/types.ts'
import { YAMLMap } from '../nodes/YAMLMap.ts'
import { YAMLSeq } from '../nodes/YAMLSeq.ts'
import {
  findMapEntry,
  mapItems,
  normalizeSegment,
  resolvePath,
  type ResolvedStep
} from './resolve.ts'
import type { EditPath, SetOperation, TestClause } from './types.ts'

export type TargetRef =
  | { kind: 'pair'; map: YAMLMap; pair: Pair; index: number }
  | { kind: 'seq-item'; seq: YAMLSeq; index: number; node: Node }
  | { kind: 'root' }

/** Resolve the final-step target reference for an operation path. */
export function targetRef(steps: ResolvedStep[]): TargetRef | undefined {
  const last = steps[steps.length - 1]
  if (!last) return { kind: 'root' }
  if (last.kind === 'map' && last.pair)
    return {
      kind: 'pair',
      map: last.container as YAMLMap,
      pair: last.pair,
      index: last.index ?? -1
    }
  if (last.kind === 'seq')
    return {
      kind: 'seq-item',
      seq: last.container as YAMLSeq,
      index: last.index as number,
      node: last.node as Node
    }
  return undefined
}

/**
 * Resolve a path, optionally creating missing intermediate and leaf
 * parents for a `set`. Returns the steps and the leaf container.
 */
export function resolveForSet(
  doc: Document<DocValue>,
  root: Node,
  path: EditPath,
  createMissing: boolean
): {
  steps: ResolvedStep[]
  /** True when the final key/index does not yet exist. */
  leafMissing: boolean
  /** True when an intermediate (non-leaf) path segment is missing. */
  intermediateMissing?: boolean
} {
  const steps: ResolvedStep[] = []
  let current: Node = root

  for (let depth = 0; depth < path.length; ++depth) {
    const raw = path[depth]
    const seg = normalizeSegment(raw)
    const isLeaf = depth === path.length - 1

    if (seg.kind === 'seq') {
      if (!(current instanceof YAMLSeq)) {
        if (!createMissing || depth === 0) return { steps, leafMissing: true }
        // Cannot reliably insert a seq mid-path into an immutable parent here.
        return { steps, leafMissing: true }
      }
      let index = seg.index
      if (index < 0) index += current.length
      if (index >= 0 && index < current.length) {
        const node = current[index]
        steps.push({ container: current, node, index, kind: 'seq' })
        current = node as Node
        continue
      }
      if (isLeaf) {
        steps.push({ container: current, node: undefined, index, kind: 'seq' })
        return { steps, leafMissing: true }
      }
      if (!createMissing) {
        steps.push({
          container: current,
          kind: 'seq',
          intermediateMissing: true
        })
        return { steps, leafMissing: true, intermediateMissing: true }
      }
      // Insert missing intermediate sequence(s).
      const nextRaw = path[depth + 1]
      const nextSeg = normalizeSegment(nextRaw)
      const fresh =
        nextSeg.kind === 'seq'
          ? new YAMLSeq(doc.schema)
          : new YAMLMap(doc.schema)
      current.push(fresh)
      steps.push({
        container: current,
        node: fresh,
        index: current.length - 1,
        kind: 'seq'
      })
      current = fresh
      continue
    }

    if (!(current instanceof YAMLMap)) {
      return { steps, leafMissing: true }
    }
    const found = findMapEntry(current, seg)
    if (found.pair && found.occurrences.length <= 1) {
      const node = found.pair.value ?? found.pair.key
      steps.push({
        container: current,
        pair: found.pair,
        node,
        index: found.index,
        kind: 'map'
      })
      current = node
      continue
    }

    if (isLeaf) {
      steps.push({ container: current, kind: 'map' })
      return { steps, leafMissing: true }
    }
    if (!createMissing) {
      // Record the immediate existing container so the caller knows the leaf
      // parent exists even though an intermediate key is missing.
      steps.push({ container: current, kind: 'map', intermediateMissing: true })
      return { steps, leafMissing: true, intermediateMissing: true }
    }
    const nextRaw = path[depth + 1]
    const nextSeg = normalizeSegment(nextRaw)
    const fresh: YAMLMap | YAMLSeq =
      nextSeg.kind === 'seq' ? new YAMLSeq(doc.schema) : new YAMLMap(doc.schema)
    const pair = new Pair(doc.createNode(keyValue(seg.key)), fresh as never)
    current.set(pair)
    steps.push({ container: current, pair, node: fresh, kind: 'map' })
    current = fresh
  }

  return { steps, leafMissing: false }
}

function keyValue(key: unknown): unknown {
  if (isNode(key)) return key
  return key
}

/**
 * Apply a `set` mutation semantically. `resolved` describes the path;
 * `leafMissing` indicates the final key/index does not yet exist.
 */
export function applySet(
  doc: Document<DocValue>,
  op: SetOperation,
  resolved: { steps: ResolvedStep[]; leafMissing: boolean },
  newNode: Node
): void {
  const { steps, leafMissing } = resolved
  const last = steps[steps.length - 1]

  if (!last) {
    // Setting the root value.
    doc.value = newNode as Document['value']
    return
  }

  if (last.kind === 'map') {
    const map = last.container as YAMLMap
    const seg = normalizeSegment(op.path[op.path.length - 1])
    if (seg.kind !== 'map') throw new Error('Type mismatch setting value')
    if (leafMissing || !last.pair) {
      const keyNode =
        seg.key instanceof Scalar || isNode(seg.key)
          ? seg.key
          : doc.createNode(seg.key)
      map.set(new Pair(keyNode as never, newNode as never))
    } else {
      last.pair.value = newNode
    }
    return
  }

  // sequence
  const seq = last.container as YAMLSeq
  const seg = normalizeSegment(op.path[op.path.length - 1])
  if (seg.kind !== 'seq') throw new Error('Type mismatch setting value')
  let index = seg.index
  if (index < 0) index += seq.length
  if (leafMissing) {
    if (index === seq.length) seq.push(newNode)
    else if (index >= 0 && index < seq.length) seq[index] = newNode
    else throw new RangeError(`Invalid sequence index ${seg.index}`)
  } else {
    seq[index] = newNode
  }
}

export function applyDelete(_root: Node, steps: ResolvedStep[]): void {
  const last = steps[steps.length - 1]
  if (!last) throw new Error('Cannot delete document root')
  if (last.kind === 'map' && last.pair) {
    const map = last.container as YAMLMap
    map.delete(last.pair.key)
  } else if (last.kind === 'seq') {
    const seq = last.container as YAMLSeq
    seq.splice(last.index as number, 1)
  }
}

export function applyRename(steps: ResolvedStep[], newKeyNode: Node): void {
  const last = steps[steps.length - 1]
  if (last?.kind !== 'map' || !last.pair)
    throw new Error('Rename target must be a mapping entry')
  const map = last.container as YAMLMap
  const entries = Array.from(map.values)
  const idx = entries.findIndex(([, p]) => p === last.pair)
  const old = entries[idx][1]
  old.key = newKeyNode
  // Rebuild preserving source order with the new semantic key.
  const rebuilt = new Map<unknown, Pair>()
  for (const [, pair] of entries) rebuilt.set(map.schema.mapKey(pair), pair)
  map.values = rebuilt
}

/** Move `fromSteps` node to `toPath` (destination leaf). */
export function applyMove(
  doc: Document<DocValue>,
  fromSteps: ResolvedStep[],
  toPath: EditPath
): void {
  const fromLast = fromSteps[fromSteps.length - 1]
  if (!fromLast) throw new Error('Cannot move document root')

  // Detach source, remembering the node.
  let moved: Node
  if (fromLast.kind === 'map' && fromLast.pair) {
    moved = fromLast.pair.value ?? fromLast.pair.key
    ;(fromLast.container as YAMLMap).delete(fromLast.pair.key)
  } else {
    moved = fromLast.node as Node
    ;(fromLast.container as YAMLSeq).splice(fromLast.index as number, 1)
  }

  // Resolve destination against the now-mutated tree, creating leaf as set.
  const dest = resolveForSet(doc, doc.value, toPath, false)
  const destSeg = normalizeSegment(toPath[toPath.length - 1])
  const dlast = dest.steps[dest.steps.length - 1]

  if (!dlast) {
    doc.value = moved as Document['value']
    return
  }
  if (dlast.kind === 'map') {
    const map = dlast.container as YAMLMap
    if (dest.leafMissing) {
      if (destSeg.kind !== 'map') throw new Error('Type mismatch in move dest')
      const keyNode = isNode(destSeg.key)
        ? destSeg.key
        : doc.createNode(destSeg.key)
      map.set(new Pair(keyNode as never, moved as never))
    } else if (dlast.pair) {
      dlast.pair.value = moved
    }
  } else {
    const seq = dlast.container as YAMLSeq
    if (destSeg.kind !== 'seq') throw new Error('Type mismatch in move dest')
    let index = destSeg.index
    if (index < 0) index += seq.length
    if (dest.leafMissing && index === seq.length) seq.push(moved)
    else seq[index] = moved
  }
}

/** Evaluate a test clause against a resolved leaf. */
export function evaluateTest(
  doc: Document<DocValue>,
  leaf: Node | Pair | null,
  clause: TestClause
): boolean {
  if ('exists' in clause) {
    const exists = leaf !== null && leaf !== undefined
    return exists === clause.exists
  }
  if ('equals' in clause) {
    if (!leaf) return clause.equals === null
    const node = leaf instanceof Pair ? leaf.value : leaf
    if (!node) return clause.equals === null
    return deepEqual(node.toJS(doc), clause.equals)
  }
  return clause.match(leaf, doc)
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false
    for (const [k, v] of a)
      if (!b.has(k) || !deepEqual(v, b.get(k))) return false
    return true
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    return ka.every(k =>
      deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k]
      )
    )
  }
  return false
}

export { mapItems, resolvePath }
