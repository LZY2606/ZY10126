import type { Document, DocValue } from '../doc/Document.ts'
import type { Alias } from '../nodes/Alias.ts'
import type { Node } from '../nodes/types.ts'
import { visit } from '../visit.ts'

export interface AnchorRecord {
  name: string
  node: Node
  aliases: Alias[]
}

/** Index every anchor declaration and the aliases that reference it. */
export function indexAnchors(doc: Document<DocValue>): Map<Node, AnchorRecord> {
  const byName = new Map<string, AnchorRecord>()
  visit(doc, {
    Alias(_key, alias) {
      const rec = byName.get(alias.source)
      if (rec) rec.aliases.push(alias)
      else
        byName.set(alias.source, {
          name: alias.source,
          node: undefined as unknown as Node,
          aliases: [alias]
        })
    },
    Value(_key, node) {
      if (node.anchor) {
        const rec = byName.get(node.anchor)
        if (rec && rec.node === undefined) rec.node = node
        else byName.set(node.anchor, { name: node.anchor, node, aliases: [] })
      }
    }
  })
  const byNode = new Map<Node, AnchorRecord>()
  for (const rec of byName.values())
    if (rec.node instanceof Object) byNode.set(rec.node, rec)
  return byNode
}

/** Set of all alias nodes in document order. */
export function collectAliases(doc: Document<DocValue>): Alias[] {
  const aliases: Alias[] = []
  visit(doc, { Alias: (_k, a) => aliases.push(a) })
  return aliases
}

/**
 * Determine whether `node` is an ancestor of (or equal to) `descendant`
 * using structural identity.
 */
export function containsNode(
  root: Node | undefined,
  descendant: Node
): boolean {
  if (!root) return false
  if (root === descendant) return true
  let found = false
  visit(root, {
    Node(_key, node) {
      if (node === descendant) found = true
    }
  })
  return found
}
