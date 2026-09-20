import type { Document } from '../doc/Document.ts'
import type { Pair } from '../nodes/Pair.ts'
import { Scalar } from '../nodes/Scalar.ts'
import type { Collection, Node } from '../nodes/types.ts'
import { YAMLMap } from '../nodes/YAMLMap.ts'
import { YAMLSeq } from '../nodes/YAMLSeq.ts'
import { YAMLSet } from '../nodes/YAMLSet.ts'
import { resolvePath, type ResolvedNode } from './resolve-path.ts'
import type { Mutation } from './apply.ts'
import type { Edit, EditPath } from './types.ts'

export interface PreparedEdit {
  edit: Edit
  /** terminal resolution for set/delete/rename */
  resolved?: ResolvedNode
  /** source resolution for move */
  from?: ResolvedNode
  /** set() on a currently missing map key */
  setMissing?: { parent: Collection; key: string | number }
}

function lastSeg(path: EditPath): string | number {
  const last = path[path.length - 1]
  return typeof last === 'object' && last !== null ? last.key : last
}

function cstIndexOfPair(parent: Collection, pair: Pair): number {
  const tok = parent.srcToken as
    { type: string; items: Array<{ key?: unknown; sep?: unknown }> } | undefined
  if (!tok || (tok.type !== 'block-map' && tok.type !== 'flow-collection'))
    return -1
  const pairs =
    parent instanceof YAMLMap || parent instanceof YAMLSet
      ? [...parent.values.values()]
      : []
  const entryIdx = pairs.indexOf(pair)
  if (entryIdx < 0) return -1
  let seen = -1
  for (let ci = 0; ci < tok.items.length; ++ci) {
    if (tok.items[ci].key !== undefined || tok.items[ci].sep !== undefined)
      seen += 1
    if (seen === entryIdx) return ci
  }
  return -1
}

function seqCstIndex(parent: YAMLSeq, node: Node): number {
  const idx = parent.indexOf(node)
  const tok = parent.srcToken as
    | {
        items: Array<{
          value?: unknown
          start: Array<{ type: string }>
        }>
      }
    | undefined
  if (!tok) return idx
  let seen = -1
  for (let ci = 0; ci < tok.items.length; ++ci) {
    const it = tok.items[ci]
    if (it.value !== undefined || it.start.some(t => t.type === 'seq-item-ind'))
      seen += 1
    if (seen === idx) return ci
  }
  return idx
}

function countRealItems(parent: Collection): number {
  const tok = parent.srcToken as
    | {
        type: string
        items: Array<{
          key?: unknown
          sep?: unknown
          value?: unknown
          start: Array<{ type: string }>
        }>
      }
    | undefined
  if (!tok) return 0
  let n = 0
  for (const item of tok.items) {
    if (
      item.key !== undefined ||
      item.sep !== undefined ||
      item.value !== undefined ||
      item.start.some(t => t.type === 'seq-item-ind')
    )
      n += 1
  }
  return n
}

/**
 * Translate analysed edits into concrete mutations against snapshot nodes.
 */
export function buildMutations(
  doc: Document,
  prepared: PreparedEdit[]
): Mutation[] {
  const out: Mutation[] = []
  for (const pre of prepared) {
    const { edit } = pre
    if (edit.type === 'set' && edit.path.length === 0) {
      out.push({
        kind: 'setRoot',
        value: d => d.createNode(edit.value)
      })
    } else if (edit.type === 'set' && pre.setMissing) {
      out.push({
        kind: 'setNew',
        parent: pre.setMissing.parent,
        key: pre.setMissing.key,
        value: d => d.createNode(edit.value),
        insertCstIndex: countRealItems(pre.setMissing.parent)
      })
    } else if (edit.type === 'set') {
      const r = pre.resolved!
      if (r.parent instanceof YAMLSeq) {
        out.push({
          kind: 'setExisting',
          address: {
            parent: r.parent,
            seqNode: r.node,
            cstIndex: seqCstIndex(r.parent, r.node)
          },
          value: d => d.createNode(edit.value)
        })
      } else if (r.parent instanceof YAMLMap || r.parent instanceof YAMLSet) {
        out.push({
          kind: 'setExisting',
          address: {
            parent: r.parent,
            pair: r.pair,
            cstIndex: r.cstIndex ?? cstIndexOfPair(r.parent, r.pair!)
          },
          value: d => d.createNode(edit.value),
          occurrence: r.occurrence,
          shadowedCstIndex: r.shadowed ? r.cstIndex : undefined
        })
      }
    } else if (edit.type === 'delete') {
      const r = pre.resolved!
      out.push({
        kind: 'delete',
        address:
          r.parent instanceof YAMLSeq
            ? {
                parent: r.parent,
                seqNode: r.node,
                cstIndex: seqCstIndex(r.parent, r.node)
              }
            : {
                parent: r.parent as Collection,
                pair: r.pair,
                cstIndex: cstIndexOfPair(r.parent as Collection, r.pair!)
              }
      })
    } else if (edit.type === 'renameKey') {
      const r = pre.resolved!
      out.push({
        kind: 'rename',
        address: {
          parent: r.parent as Collection,
          pair: r.pair,
          cstIndex: cstIndexOfPair(r.parent as Collection, r.pair!)
        },
        newKey: d => d.createNode(edit.newKey)
      })
    } else if (edit.type === 'move') {
      const from = pre.from!
      const destParentPath = edit.to.slice(0, -1)
      const destParent =
        destParentPath.length === 0
          ? doc.value
          : resolvePath(doc, destParentPath).resolved!.node
      const destKey = lastSeg(edit.to)
      const destInsertIndex =
        typeof destKey === 'number'
          ? destKey
          : countRealItems(destParent as Collection)
      out.push({
        kind: 'move',
        source:
          from.parent instanceof YAMLSeq
            ? {
                parent: from.parent,
                seqNode: from.node,
                cstIndex: seqCstIndex(from.parent, from.node)
              }
            : {
                parent: from.parent as Collection,
                pair: from.pair,
                cstIndex: cstIndexOfPair(from.parent as Collection, from.pair!)
              },
        destParent: destParent as Collection,
        destKey,
        destInsertIndex
      })
    }
  }
  return out
}

export { Scalar }
