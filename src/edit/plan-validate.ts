import type { Document, DocValue } from '../doc/Document.ts'
import type { Alias } from '../nodes/Alias.ts'
import type { Pair } from '../nodes/Pair.ts'
import { Scalar } from '../nodes/Scalar.ts'
import { YAMLMap } from '../nodes/YAMLMap.ts'
import { visit } from '../visit.ts'
import { containsNode, indexAnchors, type AnchorRecord } from './anchors.ts'
import { duplicateGroups } from './resolve.ts'
import type { Node, Range } from '../nodes/types.ts'
import type { EditConflict, EditDiagnostic } from './types.ts'

export function conflict(
  code: EditConflict['code'],
  message: string,
  extra: Partial<EditConflict> = {}
): EditConflict {
  return { code, message, ...extra }
}

export interface MergeHit {
  pair: Pair
  map: YAMLMap
}

/** Find a YAML 1.1 merge key (`<<`) entry in a mapping, if any. */
export function findMergeKey(map: YAMLMap): Pair | undefined {
  for (const pair of map.values.values()) {
    const key = pair.key
    if (
      key instanceof Scalar &&
      typeof key.value === 'symbol' &&
      key.value.description === '<<'
    )
      return pair
    if (key instanceof Scalar && key.value === '<<') return pair
  }
  return undefined
}

/** All maps containing a `<<` merge pair, anywhere in the tree. */
export function mergeMaps(doc: Document<DocValue>): Map<YAMLMap, Pair> {
  const hits = new Map<YAMLMap, Pair>()
  visit(doc, {
    Map(_key, node) {
      if (!(node instanceof YAMLMap)) return
      const mk = findMergeKey(node)
      if (mk) hits.set(node, mk)
    }
  })
  return hits
}

export interface DuplicateHit {
  map: YAMLMap
  keyText: string
  count: number
  range?: Range
}

/** All mappings with repeated keys, with the earliest offending range. */
export function duplicateKeyMaps(doc: Document<DocValue>): DuplicateHit[] {
  const hits: DuplicateHit[] = []
  visit(doc, {
    Map(_key, node) {
      if (!(node instanceof YAMLMap)) return
      const groups = duplicateGroups(node)
      for (const [keyText, items] of groups) {
        const range = items[0]?.pair?.key.range ?? undefined
        hits.push({ map: node, keyText, count: items.length, range })
      }
    }
  })
  return hits
}

export interface AnchorIndex {
  byNode: Map<Node, AnchorRecord>
  aliases: Alias[]
}

export function buildAnchorIndex(doc: Document<DocValue>): AnchorIndex {
  return { byNode: indexAnchors(doc), aliases: collectAllAliases(doc) }
}

function collectAllAliases(doc: Document<DocValue>): Alias[] {
  const aliases: Alias[] = []
  visit(doc, { Alias: (_k, a) => aliases.push(a) })
  return aliases
}

/**
 * Aliases whose anchor declaration is contained within `removed` nodes.
 */
export function aliasesIntoRemoved(
  idx: AnchorIndex,
  removed: Node[],
  keptRoot: Node
): { alias: Alias; anchorName: string }[] {
  const out: { alias: Alias; anchorName: string }[] = []
  for (const alias of idx.aliases) {
    const rec = idx.byNode.get(resolveDeclaration(alias, idx))
    void rec
  }
  // Direct approach via resolution.
  for (const alias of idx.aliases) {
    const target = alias.resolve(keptRoot as Document<DocValue>)
    if (!target) continue
    for (const node of removed) {
      if (node === target || containsNode(node, target)) {
        out.push({ alias, anchorName: alias.source })
        break
      }
    }
  }
  return out
}

function resolveDeclaration(alias: Alias, idx: AnchorIndex): Node {
  for (const [node, rec] of idx.byNode)
    if (rec.name === alias.source) return node
  return alias
}

/**
 * After mutations, verify every alias still resolves to an anchored node and
 * report failures.
 */
export function unresolvedAliases(doc: Document<DocValue>): Alias[] {
  const bad: Alias[] = []
  visit(doc, {
    Alias(_key, alias) {
      const target = alias.resolve(doc)
      if (!target?.anchor || target.anchor !== alias.source) bad.push(alias)
    }
  })
  return bad
}

export type { EditDiagnostic }
