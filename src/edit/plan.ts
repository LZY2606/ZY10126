import { Document } from '../doc/Document.ts'
import { Alias } from '../nodes/Alias.ts'
import { isCollection } from '../nodes/identity.ts'
import type { Collection, Node, Range } from '../nodes/types.ts'
import { YAMLMap } from '../nodes/YAMLMap.ts'
import { YAMLSeq } from '../nodes/YAMLSeq.ts'
import { YAMLSet } from '../nodes/YAMLSet.ts'
import { isMergeKey } from '../schema/yaml-1.1/merge.ts'
import { scanAnchors, type AnchorScan } from './anchors.ts'
import { applyMutations, buildIdentityMap } from './apply.ts'
import { buildMutations } from './build-mutations.ts'
import { EditPlanConflictError } from './errors.ts'
import { getCollectionToken, getReplacementRange } from './engine.ts'
import { spliceRegions } from './engine.ts'
import { stringifyDocument } from '../stringify/stringifyDocument.ts'
import { parseDocument as parseDocumentFresh } from '../public-api.ts'
import { renderRegions } from './render-plan.ts'
import { hashText } from './hash.ts'
import {
  findMapCandidates,
  resolvePath,
  type ResolvedNode
} from './resolve-path.ts'
import type {
  CommitResult,
  Edit,
  EditConflict,
  EditPlanItem,
  EditPlanOptions,
  EditPath,
  MoveEdit
} from './types.ts'

const MERGE_KEY = '<<'

interface Prepared {
  edit: Edit
  index: number
  /** terminal resolved node for the primary path */
  resolved?: ResolvedNode
  /** resolved source node for move edits */
  from?: ResolvedNode
  /** set() on a currently missing map key */
  setMissing?: { parent: Collection; key: string | number }
  /** resolved destination parent for move/set edits */
  conflicts: EditConflict[]
}

/**
 * An opt-in, transactional set of edits against a parsed document.
 *
 * Create with {@link Document.createEditPlan}. All operations are analysed
 * against the same parsed snapshot; nothing is mutated until
 * {@link EditPlan.commit} succeeds.
 */
export class EditPlan {
  readonly doc: Document
  readonly options: EditPlanOptions
  readonly edits: readonly Edit[]
  readonly sourceHash: string

  #items: EditPlanItem[] | null = null
  #conflicts: EditConflict[] = []
  #analysed = false
  #scan: AnchorScan

  constructor(
    doc: Document,
    edits: Iterable<Edit>,
    options: EditPlanOptions = {}
  ) {
    this.doc = doc
    this.edits = [...edits]
    this.options = { verifySnapshot: true, ...options }
    const source = this.options.source
    this.sourceHash = source === undefined ? '' : hashText(source)
    this.#scan = scanAnchors(doc)
  }

  get conflicts(): readonly EditConflict[] {
    this.analyze()
    return this.#conflicts
  }

  get items(): readonly EditPlanItem[] {
    this.analyze()
    return this.#items ?? []
  }

  get ok(): boolean {
    this.analyze()
    return this.#conflicts.length === 0
  }

  addConflict(conflict: EditConflict): void {
    this.#conflicts.push(conflict)
  }

  /** Analyse every edit against the snapshot, collecting conflicts. */
  analyze(): this {
    if (this.#analysed) return this
    this.#analysed = true
    const prepared: Prepared[] = []
    const items: EditPlanItem[] = []

    for (let i = 0; i < this.edits.length; ++i) {
      const edit = this.edits[i]
      const pre: Prepared = { edit, index: i, conflicts: [] }
      this.#prepareEdit(edit, i, pre)
      prepared.push(pre)
      this.#conflicts.push(...pre.conflicts)
    }

    // Cross-edit validation (anchor lifecycle, overlap, index drift).
    if (this.#conflicts.length === 0) this.#validatePlan(prepared)

    for (const pre of prepared) items.push(this.#buildItem(pre))
    this.#items = items
    return this
  }

  #prepareEdit(edit: Edit, index: number, pre: Prepared): void {
    const fail = (conflict: Omit<EditConflict, 'editIndex'>) =>
      pre.conflicts.push({ ...conflict, editIndex: index })

    if (
      edit.type === 'set' ||
      edit.type === 'delete' ||
      edit.type === 'renameKey'
    ) {
      const r = resolvePath(this.doc, edit.path)
      if (r.failure) {
        if (
          edit.type === 'set' &&
          r.failure.kind === 'missing' &&
          r.failure.path.length === edit.path.length
        ) {
          // set on a missing leaf key: allowed when the parent exists.
          this.#prepareSetMissing(edit, r.failure, pre)
          return
        }
        fail({
          code:
            r.failure.kind === 'missing'
              ? 'PATH_NOT_FOUND'
              : 'PATH_TYPE_MISMATCH',
          message:
            r.failure.kind === 'missing'
              ? `Path not found: ${formatPath(edit.path)}`
              : `Path type mismatch at: ${formatPath(r.failure.path)}`,
          path: r.failure.path
        })
        return
      }
      if (!r.resolved) return
      const resolved = r.resolved
      pre.resolved = resolved
      this.#checkTarget(edit, resolved, fail)
      if (edit.test) this.#checkTest(resolved.node, edit.test, edit.path, fail)
      if (edit.type === 'renameKey') this.#checkRename(edit, resolved, fail)
    } else if (edit.type === 'move') {
      this.#prepareMove(edit, index, pre)
    } else {
      fail({
        code: 'INVALID_EDIT',
        message: `Unknown edit type: ${(edit as { type: string }).type}`
      })
    }
  }

  #prepareSetMissing(
    edit: Extract<Edit, { type: 'set' }>,
    failure: { path: EditPath; parent: Collection | Document },
    pre: Prepared
  ): void {
    const parent = failure.parent
    if (!(parent instanceof YAMLMap || parent instanceof YAMLSeq)) {
      pre.conflicts.push({
        code: 'PATH_TYPE_MISMATCH',
        message: `Cannot set a new entry on ${parent.constructor.name}`,
        editIndex: pre.index,
        path: failure.path
      })
      return
    }
    const key = lastKey(edit.path)
    if (parent instanceof YAMLMap || parent instanceof YAMLSet) {
      // setting a new seq index beyond length+1 is invalid
      pre.setMissing = { parent, key }
    } else {
      const idx = (key as number) < 0 ? (key as number) + parent.length : key
      if (idx !== parent.length) {
        pre.conflicts.push({
          code: 'PATH_NOT_FOUND',
          message: `Cannot create a sparse sequence entry at index ${String(key)}`,
          editIndex: pre.index,
          path: failure.path
        })
        return
      }
      pre.setMissing = { parent, key }
    }
    // merge-key parents warn; disallow setting through explicit merge entry
    if (parent instanceof YAMLMap && containsMergeKey(parent, this.doc)) {
      // setting a brand new explicit key is safe (it shadows merge values);
      // record a diagnostic on the item instead of failing.
    }
    if (edit.test) {
      // test evaluates against undefined for a missing key
      try {
        if (!edit.test(null, edit.path, this.doc))
          pre.conflicts.push({
            code: 'CONDITION_FAILED',
            message: `Edit test failed at: ${formatPath(edit.path)}`,
            editIndex: pre.index,
            path: edit.path
          })
      } catch (error) {
        pre.conflicts.push({
          code: 'EDIT_ERROR',
          message: `Edit test threw: ${(error as Error).message}`,
          editIndex: pre.index,
          path: edit.path
        })
      }
    }
  }

  #checkTarget(
    edit: Exclude<Edit, MoveEdit> | MoveEdit,
    resolved: ResolvedNode,
    fail: (c: Omit<EditConflict, 'editIndex'>) => void
  ): void {
    const path = edit.type === 'move' ? edit.from : edit.path
    const { parent, pair, candidates } = resolved

    // Duplicate keys are never silently picked.
    if (candidates && candidates.length > 1) {
      const explicit =
        typeof path[path.length - 1] === 'object' &&
        path[path.length - 1] !== null
      if (!explicit) {
        fail({
          code: 'DUPLICATE_KEY',
          message:
            `Duplicate key "${String(lastKey(path))}" has ${candidates.length} occurrences; ` +
            'disambiguate with { key, occurrence }',
          range: pair?.key.range ?? undefined,
          path: path,
          candidates: candidates.map(c => ({
            path: withOccurrence(path, c.occurrence),
            range: c.pair.key.range ?? undefined,
            current: c.live
          }))
        })
        return
      }
      // An explicit occurrence is honoured for any candidate, including a
      // shadowed one; the CST-level renderer edits precisely that entry.
      const wanted =
        typeof path[path.length - 1] === 'object'
          ? (path[path.length - 1] as { occurrence: number }).occurrence
          : 0
      if (!candidates.some(c => c.occurrence === wanted)) {
        fail({
          code: 'DUPLICATE_KEY',
          message: `Duplicate key occurrence ${wanted} does not exist`,
          range: pair?.key.range ?? undefined,
          path,
          candidates: candidates.map(c => ({
            path: withOccurrence(path, c.occurrence),
            range: c.pair.key.range ?? undefined,
            current: c.live
          }))
        })
      }
    }

    // Merge keys are not silently modified or expanded.
    if (pair && parent instanceof YAMLMap && isMergeKey(this.doc, pair.key)) {
      fail({
        code: 'MERGE_KEY',
        message:
          `Path ${formatPath(path)} targets a merge key (${MERGE_KEY}); ` +
          'merge semantics are not applied automatically',
        range: pair.key.range ?? undefined,
        path: path
      })
      return
    }

    // A set/delete on a map that *contains* a merge key is allowed, but
    // deleting a key whose effective value comes only from a merge source is
    // flagged. Here we only reject edits directly targeting the merge entry;
    // parent-merge diagnostics are attached as warnings.
  }

  #checkTest(
    node: Node,
    test: NonNullable<Extract<Edit, { test?: unknown }>['test']>,
    path: EditPath,
    fail: (c: Omit<EditConflict, 'editIndex'>) => void
  ): void {
    try {
      if (!test(node, path, this.doc))
        fail({
          code: 'CONDITION_FAILED',
          message: `Edit test failed at: ${formatPath(path)}`,
          range: node?.range ?? undefined,
          path
        })
    } catch (error) {
      fail({
        code: 'EDIT_ERROR',
        message: `Edit test threw: ${(error as Error).message}`,
        range: node?.range ?? undefined,
        path
      })
    }
  }

  #checkRename(
    edit: Extract<Edit, { type: 'renameKey' }>,
    resolved: ResolvedNode,
    fail: (c: Omit<EditConflict, 'editIndex'>) => void
  ): void {
    const parent = resolved.parent
    if (!(parent instanceof YAMLMap || parent instanceof YAMLSet)) {
      fail({
        code: 'PATH_TYPE_MISMATCH',
        message: 'renameKey requires a map key target',
        path: edit.path
      })
      return
    }
    if (typeof edit.newKey !== 'string' && typeof edit.newKey !== 'number') {
      fail({
        code: 'INVALID_EDIT',
        message: 'renameKey newKey must be a string or number',
        path: edit.path
      })
      return
    }
    const dups = findMapCandidates(parent, edit.newKey, this.doc.schema)
    if (dups.length > 0)
      fail({
        code: 'DUPLICATE_TARGET_KEY',
        message: `Rename target key "${String(edit.newKey)}" already exists`,
        range: dups[0].pair.key.range ?? undefined,
        path: edit.path.slice(0, -1).concat(edit.newKey)
      })
  }

  #prepareMove(edit: MoveEdit, index: number, pre: Prepared): void {
    const fail = (conflict: Omit<EditConflict, 'editIndex'>) =>
      pre.conflicts.push({ ...conflict, editIndex: index })

    const from = resolvePath(this.doc, edit.from)
    if (from.failure) {
      fail({
        code:
          from.failure.kind === 'missing'
            ? 'PATH_NOT_FOUND'
            : 'PATH_TYPE_MISMATCH',
        message: `Move source not found: ${formatPath(edit.from)}`,
        path: from.failure.path
      })
      return
    }
    if (!from.resolved) return
    pre.from = from.resolved
    this.#checkTarget(edit, from.resolved, fail)
    if (edit.test)
      this.#checkTest(from.resolved.node, edit.test, edit.from, fail)

    // Destination: parent path must exist and be a collection.
    const destParentPath = edit.to.slice(0, -1)
    const destParent =
      destParentPath.length === 0
        ? { resolved: this.#rootResolved() }
        : resolvePath(this.doc, destParentPath)
    if (destParent.failure) {
      fail({
        code:
          destParent.failure.kind === 'missing'
            ? 'PATH_NOT_FOUND'
            : 'PATH_TYPE_MISMATCH',
        message: `Move destination parent not found: ${formatPath(destParentPath)}`,
        path: destParent.failure.path
      })
      return
    }
    const parentNode =
      destParentPath.length === 0 ? this.doc.value : destParent.resolved!.node
    const destKey = lastKey(edit.to)
    if (
      typeof destKey === 'number'
        ? !(parentNode instanceof YAMLSeq)
        : !(parentNode instanceof YAMLMap || parentNode instanceof YAMLSet)
    ) {
      fail({
        code: 'PATH_TYPE_MISMATCH',
        message: `Move destination type mismatch: ${formatPath(edit.to)}`,
        path: edit.to
      })
      return
    }
    if (typeof destKey !== 'number') {
      const existing = findMapCandidates(
        parentNode as YAMLMap,
        destKey,
        this.doc.schema
      )
      if (existing.length > 0)
        fail({
          code: 'DUPLICATE_TARGET_KEY',
          message: `Move destination key already exists: ${String(destKey)}`,
          path: edit.to
        })
    } else if (parentNode instanceof YAMLSeq && destKey !== parentNode.length) {
      const idx = destKey < 0 ? destKey + parentNode.length : destKey
      if (idx < 0 || idx > parentNode.length)
        fail({
          code: 'PATH_NOT_FOUND',
          message: `Move destination index out of range: ${String(destKey)}`,
          path: edit.to
        })
    }
  }

  #rootResolved(): ResolvedNode {
    return {
      node: this.doc.value,
      parent: this.doc,
      occurrence: 0,
      range: this.doc.value.range ?? undefined
    }
  }

  #validatePlan(prepared: Prepared[]): void {
    // 1. Overlapping structural operations are never applied implicitly.
    const regions = prepared.map(pre => this.#editSpan(pre))
    for (let i = 0; i < prepared.length; ++i) {
      for (let j = i + 1; j < prepared.length; ++j) {
        const a = regions[i]
        const b = regions[j]
        if (a && b && rangesOverlap(a, b)) {
          this.#conflicts.push({
            code: 'OVERLAPPING_OPERATIONS',
            message: `Edits ${i} and ${j} overlap on the same subtree`,
            editIndex: i,
            range: a
          })
        }
      }
    }

    // 2. Anchor lifecycle: deleting a node that provides an anchor used by
    //    an outside alias; moving an anchor after an alias that uses it.
    for (let i = 0; i < prepared.length; ++i) {
      const pre = prepared[i]
      const removed =
        pre.edit.type === 'delete'
          ? [pre.resolved!.node]
          : pre.edit.type === 'move'
            ? []
            : []
      for (const node of removed) {
        this.#checkAnchorDeletion(node, pre)
      }
      if (pre.edit.type === 'move') this.#checkAnchorMove(pre)
    }
  }

  #editSpan(pre: Prepared): Range | null {
    if (pre.edit.type === 'move') {
      const r = pre.from?.node?.range ?? null
      return r ? ([...r] as Range) : null
    }
    const r = pre.resolved?.node?.range ?? null
    return r ? ([...r] as Range) : null
  }

  #checkAnchorDeletion(node: Node, pre: Prepared): void {
    const removedNodes: Node[] = []
    collectNodes(node, removedNodes)
    for (const n of removedNodes) {
      if (!(typeof n.anchor === 'string')) continue
      const aliases = this.#scan.aliasByName.get(n.anchor) ?? []
      for (const alias of aliases) {
        if (!removedNodes.includes(alias.alias)) {
          this.#conflicts.push({
            code: 'ALIAS_TO_DELETED_ANCHOR',
            message: `Deleting node removes anchor &${n.anchor}, referenced by an alias`,
            editIndex: pre.index,
            range: alias.alias.range ?? undefined,
            anchor: n.anchor
          })
        }
      }
    }
  }

  #checkAnchorMove(pre: Prepared): void {
    const movedRoot = pre.from!.node
    const inside: Node[] = []
    collectNodes(movedRoot, inside)
    const destOffset = this.#destInsertionOffset(pre.edit as MoveEdit)
    for (const n of inside) {
      if (typeof n.anchor !== 'string') continue
      const aliases = this.#scan.aliasByName.get(n.anchor) ?? []
      for (const a of aliases) {
        if (inside.includes(a.alias)) continue
        const aliasOffset = a.alias.range?.[0]
        if (
          destOffset !== null &&
          aliasOffset !== undefined &&
          aliasOffset < destOffset
        ) {
          this.#conflicts.push({
            code: 'ANCHOR_ORDER',
            message: `Moving &${n.anchor} places it after alias *${n.anchor}`,
            editIndex: pre.index,
            range: a.alias.range ?? undefined,
            anchor: n.anchor
          })
        }
      }
    }
  }

  #destInsertionOffset(edit: Extract<Edit, { type: 'move' }>): number | null {
    // New map keys append at the end of their parent collection; new seq
    // indices place the node at the index's offset. Use the parent's value
    // end for appends, which is always after existing aliases when they are
    // earlier in source order.
    const r = resolvePath(this.doc, edit.to.slice(0, -1))
    const parent = edit.to.length === 1 ? this.doc.value : r.resolved?.node
    if (!(parent instanceof YAMLMap || parent instanceof YAMLSeq)) return null
    return parent.range?.[2] ?? parent.range?.[0] ?? null
  }

  #buildItem(pre: Prepared): EditPlanItem {
    const edit = pre.edit
    const resolved = edit.type === 'move' ? pre.from : pre.resolved
    const node = resolved?.node ?? null
    const parent = resolved?.parent ?? this.doc
    const range = resolved?.range ?? node?.range ?? undefined

    const anchorImpacts = this.#anchorImpacts(node)
    const rewriteRoot = this.#rewriteRoot(pre)
    const rewrite = describeRewrite(pre, rewriteRoot)

    return {
      edit,
      editIndex: pre.index,
      node,
      parent,
      range,
      path: edit.type === 'move' ? edit.from : edit.path,
      anchorImpacts,
      rewriteRoot,
      rewriteReason: rewrite.reason,
      rewriteRanges: rewrite.ranges,
      diagnostics: this.#diagnostics(pre, resolved?.parent ?? null)
    }
  }

  #anchorImpacts(node: Node | null) {
    const impacts: EditPlanItem['anchorImpacts'] = []
    if (!node) return impacts
    const inside: Node[] = []
    collectNodes(node, inside)
    const seen = new Set<string>()
    for (const n of inside) {
      if (typeof n.anchor !== 'string' || seen.has(n.anchor)) continue
      seen.add(n.anchor)
      const aliases = (this.#scan.aliasByName.get(n.anchor) ?? []).map(
        a => a.alias
      )
      impacts.push({ anchor: n.anchor, anchorNode: n, aliases })
    }
    // aliases inside the subtree to external anchors
    for (const n of inside) {
      if (n instanceof Alias && !seen.has(n.source)) {
        const defs = this.#scan.anchors.get(n.source)
        impacts.push({
          anchor: n.source,
          anchorNode: defs?.[0]?.node,
          aliases: [n]
        })
      }
    }
    return impacts
  }

  #rewriteRoot(pre: Prepared): Node | Document {
    const resolved = pre.edit.type === 'move' ? pre.from : pre.resolved
    const parent = resolved?.parent
    if (parent instanceof Document) return this.doc
    return parent ?? this.doc
  }

  #diagnostics(
    pre: Prepared,
    parent: ResolvedNode['parent'] | null
  ): EditPlanItem['diagnostics'] {
    const out: EditPlanItem['diagnostics'] = []
    if (parent instanceof YAMLMap && containsMergeKey(parent, this.doc))
      out.push({
        level: 'warning',
        message:
          'Parent mapping contains a << merge key; effective JS value may differ from the explicit entry',
        range: parent.range ?? undefined
      })
    const node = pre.edit.type === 'move' ? pre.from?.node : pre.resolved?.node
    if (
      node &&
      isCollection(node) &&
      !getCollectionToken(node) &&
      this.options.source !== undefined
    )
      out.push({
        level: 'warning',
        message:
          'Target node has no srcToken; rewrite scope widens to a full re-stringify of the nearest rendered ancestor',
        range: node.range ?? undefined
      })
    return out
  }

  /**
   * Reject the plan when the document/source snapshot has drifted since
   * analysis. Node identities and recorded ranges must still match.
   */
  #verifySnapshot(): EditConflict | null {
    if (this.options.verifySnapshot === false) return null
    const source = this.options.source
    if (source === undefined) return null
    if (hashText(source) !== this.sourceHash)
      return {
        code: 'STALE_PLAN',
        message:
          'Source text changed since the plan was created; re-parse and re-plan'
      }
    for (const item of this.items) {
      const node = item.node
      if (node && 'range' in node && node.range) {
        const now = resolvePath(this.doc, item.path).resolved?.node
        if (now && now !== node)
          return {
            code: 'STALE_PLAN',
            message: `Node identity changed at path ${formatPath(item.path)}`,
            path: item.path
          }
      }
    }
    return null
  }

  /**
   * Apply the plan transactionally.
   *
   * Mutations (including custom tag `createNode` calls) are first exercised
   * on a clone and stringified; only then is the original document mutated.
   * Any failure leaves the original document fully intact.
   */
  commit(): CommitResult {
    this.analyze()
    if (this.#conflicts.length > 0)
      throw new EditPlanConflictError(this.#conflicts)
    const stale = this.#verifySnapshot()
    if (stale) throw new EditPlanConflictError([stale])

    const prepared: Prepared[] = this.edits.map((edit, i) =>
      this.#preparedFor(edit, i)
    )
    const mutations = buildMutations(this.doc, prepared)
    const source = this.options.source

    const clone = this.doc.clone()
    const blockingErrors = clone.errors.filter(
      err => err.code !== 'DUPLICATE_KEY'
    )
    if (blockingErrors.length > 0)
      throw new EditPlanConflictError(
        blockingErrors.map(err => ({
          code: 'EDIT_ERROR' as const,
          message: `Document has parse errors: ${err.message}`,
          range: 'range' in err ? (err.range as Range) : undefined
        }))
      )
    // Duplicate-key errors correspond to conflicts already reported; the
    // mutated document is re-parsed after commit to validate semantics.
    clone.errors = clone.errors.filter(err => err.code === 'DUPLICATE_KEY')
    const cloneMap = buildIdentityMap(this.doc, clone)
    try {
      applyMutations(clone, mutations, cloneMap)
      stringifyDocument(clone, this.options.toStringOptions ?? {})
    } catch (error) {
      throw new EditPlanConflictError([
        {
          code: 'EDIT_ERROR',
          message: `Edit plan failed dry-run: ${(error as Error).message}`
        }
      ])
    }

    const identity = new Map<object, object>()
    for (const [a] of cloneMap) identity.set(a, a)
    applyMutations(this.doc, mutations, identity)

    if (
      source === undefined ||
      !this.doc.value.srcToken ||
      this.#requiresFullStringify(mutations)
    ) {
      const text = this.doc.toString(this.options.toStringOptions)
      return {
        text,
        doc: this.doc,
        items: this.items as EditPlanItem[],
        replacedRanges: [
          {
            range: this.doc.value.range ?? [0, source?.length ?? 0, 0],
            reason: 'full document re-stringification'
          }
        ]
      }
    }

    const { regions } = renderRegions(
      this.doc,
      source,
      mutations,
      this.options.toStringOptions
    )
    const text = spliceRegions(source, regions)

    // When duplicate keys were present, the semantic map only kept one
    // occurrence; refresh the document by reparsing the patched source.
    if (hasDuplicateKeys(this.doc)) {
      const reparsed = parseDocumentFresh(text, {
        keepSourceTokens: true,
        version: this.doc.directives?.yaml.version,
        customTags: this.doc.schema.tags.filter(
          (t: { default?: unknown }) => !t.default
        )
      })
      adoptDocument(this.doc, reparsed)
      return {
        text,
        doc: this.doc,
        items: this.items as EditPlanItem[],
        replacedRanges: regions.map(r => ({ range: r.range, reason: r.reason }))
      }
    }

    return {
      text,
      doc: this.doc,
      items: this.items as EditPlanItem[],
      replacedRanges: regions.map(r => ({ range: r.range, reason: r.reason }))
    }
  }

  #preparedFor(edit: Edit, index: number): Prepared {
    const base: Prepared = { edit, index, conflicts: [] }
    if (edit.type === 'move')
      base.from = resolvePath(this.doc, edit.from).resolved
    else {
      const r = resolvePath(this.doc, edit.path)
      if (r.resolved) base.resolved = r.resolved
      else if (
        edit.type === 'set' &&
        r.failure?.kind === 'missing' &&
        r.failure.path.length === edit.path.length
      ) {
        const parent = r.failure.parent as Collection
        base.setMissing = { parent, key: lastKey(edit.path) }
      }
    }
    return base
  }

  #requiresFullStringify(mutations: Readonly<unknown>[]): boolean {
    for (const m of mutations) {
      const mut = m as {
        address?: { parent?: unknown }
        kind: string
      }
      if (mut.kind === 'setRoot') return true
      if (mut.kind === 'setExisting' && mut.address?.parent === this.doc)
        return true
    }
    return false
  }
}

function formatPath(path: EditPath): string {
  return path
    .map(seg =>
      typeof seg === 'object' && seg !== null
        ? `${String(seg.key)}#${seg.occurrence}`
        : String(seg)
    )
    .join('.')
}

function lastKey(path: EditPath): string | number {
  const last = path[path.length - 1]
  return typeof last === 'object' && last !== null ? last.key : last
}

function withOccurrence(path: EditPath, occurrence: number): EditPath {
  const next = path.slice()
  const last = next[next.length - 1]
  const key = typeof last === 'object' && last !== null ? last.key : last
  next[next.length - 1] = { key, occurrence }
  return next
}

function rangesOverlap(a: Range, b: Range): boolean {
  return a[0] < b[1] && b[0] < a[1]
}

function collectNodes(root: any, out: Node[]): void {
  if (!root) return
  out.push(root)
  if (root instanceof YAMLSeq) {
    for (const item of root) collectNodes(item, out)
  } else if (root instanceof YAMLMap || root instanceof YAMLSet) {
    for (const pair of root.values.values()) {
      collectNodes(pair.key, out)
      collectNodes(pair.value, out)
    }
  }
}

function containsMergeKey(map: YAMLMap, doc: Document): boolean {
  for (const pair of map.values.values())
    if (isMergeKey(doc, pair.key)) return true
  return false
}

function describeRewrite(
  pre: Prepared,
  rewriteRoot: Node | Document
): { reason: string; ranges: Range[] } {
  const ranges: Range[] = []
  if (rewriteRoot instanceof Document)
    return {
      reason: 'Edits the document root; full document re-stringification',
      ranges: rewriteRoot.value.range ? [rewriteRoot.value.range] : []
    }
  const tok = getCollectionToken(rewriteRoot as Collection)
  const range = getReplacementRange(rewriteRoot as Collection)
  const reasonParts: string[] = []
  if (pre.edit.type === 'move') reasonParts.push('subtree moved')
  else reasonParts.push(`${pre.edit.type} on entry`)
  if (!tok)
    reasonParts.push(
      'no srcToken on collection: scope widened to the collection subtree'
    )
  if (range) ranges.push(range)
  return { reason: reasonParts.join('; '), ranges }
}

function hasDuplicateKeys(doc: Document): boolean {
  return doc.errors.some(e => e.code === 'DUPLICATE_KEY')
}

function adoptDocument(target: Document, source: Document): void {
  target.value = source.value
  target.errors = source.errors
  target.warnings = source.warnings
  target.range = source.range
  target.commentBefore = source.commentBefore
  target.comment = source.comment
}
