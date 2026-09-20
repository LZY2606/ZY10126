import type { Document, DocValue } from '../doc/Document.ts'
import { Alias } from '../nodes/Alias.ts'
import { Pair } from '../nodes/Pair.ts'
import type { Node } from '../nodes/types.ts'
import { YAMLMap } from '../nodes/YAMLMap.ts'
import { YAMLSeq } from '../nodes/YAMLSeq.ts'
import { YAMLSet } from '../nodes/YAMLSet.ts'

export interface AnchorEntry {
  name: string
  node: Node
  /** Parent chain from document to the node (Document/collection/Pair). */
  path: Node[]
  /** Position of the anchor in source order. */
  order: number
}

export interface AliasEntry {
  alias: Alias
  path: Node[]
  order: number
}

export interface AnchorScan {
  anchors: Map<string, AnchorEntry[]>
  aliases: AliasEntry[]
  /** aliases grouped by the anchor name they reference */
  aliasByName: Map<string, AliasEntry[]>
}

/**
 * Walk the document in source order collecting anchor definitions and alias
 * uses. Multiple nodes may share an anchor name after manual edits.
 */
export function scanAnchors(doc: Document<DocValue>): AnchorScan {
  const anchors = new Map<string, AnchorEntry[]>()
  const aliases: AliasEntry[] = []
  const aliasByName = new Map<string, AliasEntry[]>()
  let order = 0

  const walk = (node: Node | Pair | null, path: Node[]) => {
    if (!node) return
    if (node instanceof Pair) return
    const here = [...path, node]
    if (node instanceof Alias) {
      const entry: AliasEntry = { alias: node, path: here, order: order++ }
      aliases.push(entry)
      const list = aliasByName.get(node.source) ?? []
      list.push(entry)
      aliasByName.set(node.source, list)
      return
    }
    if ('anchor' in node && typeof (node as Node).anchor === 'string') {
      const entry: AnchorEntry = {
        name: (node as Node).anchor as string,
        node: node,
        path: here,
        order: order++
      }
      const list = anchors.get(entry.name) ?? []
      list.push(entry)
      anchors.set(entry.name, list)
    }
    if (node instanceof YAMLSeq) {
      for (const item of node) walk(item, here)
    } else if (node instanceof YAMLMap || node instanceof YAMLSet) {
      for (const pair of node.values.values() as Iterable<any>) {
        walk(pair.key, here)
        walk(pair.value, here)
      }
    }
  }

  walk(doc.value, [])
  return { anchors, aliases, aliasByName }
}
