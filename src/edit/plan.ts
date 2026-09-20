import { createHash } from 'node:crypto'
import type { Document } from '../doc/Document.ts'
import { type DocValue } from '../doc/Document.ts'
import { Alias } from '../nodes/Alias.ts'
import { isNode } from '../nodes/identity.ts'
import type { Node, Range } from '../nodes/types.ts'
import type { Pair } from '../nodes/Pair.ts'
import { Scalar } from '../nodes/Scalar.ts'
import { YAMLMap } from '../nodes/YAMLMap.ts'
import { YAMLSeq } from '../nodes/YAMLSeq.ts'
import { parseDocument } from '../public-api.ts'
import { visit } from '../visit.ts'
import { EditPlanError } from './errors.ts'
import {
  applyDelete,
  applyMove,
  applyRename,
  applySet,
  evaluateTest,
  resolveForSet
} from './mutate.ts'
import {
  buildAnchorIndex,
  conflict,
  duplicateKeyMaps,
  findMergeKey,
  mergeMaps,
  unresolvedAliases
} from './plan-validate.ts'
import {
  buildReplacements,
  spliceAll,
  type LeafEdit,
  type Replacement
} from './regions.ts'
import { findMapEntry, resolvePath, type ResolvedStep } from './resolve.ts'
import { pairLineSpan, seqItemSpan, type Span } from './spans.ts'
import type {
  CommitResult,
  EditConflict,
  EditDiagnostic,
  EditOperation,
  EditPlanOptions,
  PlannedEdit
} from './types.ts'

export interface Snapshot {
  /** Full original source, when available. */
  source?: string
  /** Hash of the complete source, used for tamper detection. */
  sourceHash?: string
  /** Node identities present in the original tree. */
  nodes: WeakSet<Node>
  /** Original text captured by every resolved target span. */
  spanText: Map<number, string>
  lineStarts: number[]
}

interface ResolvedOperation {
  op: EditOperation
  index: number
  /** Steps resolved on the original tree (mutations other than set/move). */
  steps?: ResolvedStep[]
  found: boolean
  /** Structural subtree this op touches (for overlap checks). */
  scope?: Node
  scopeRange?: Range
  removedNode?: Node
  _createMissing?: boolean
  diagnostics: EditDiagnostic[]
  planned: PlannedEdit
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function makeSnapshot(source: string | undefined, root: Node): Snapshot {
  const nodes = new WeakSet<Node>()
  const spanText = new Map<number, string>()
  const lineStarts: number[] = []
  visit(root, {
    Node: (_k, n) => {
      nodes.add(n)
    }
  })
  if (source !== undefined) {
    for (let i = 0; i < source.length; ++i)
      if (source[i] === '\n') lineStarts.push(i + 1)
    visit(root, {
      Node(_k, n) {
        if (n.range)
          spanText.set(n.range[0], source.slice(n.range[0], n.range[2]))
      }
    })
  }
  return {
    source,
    sourceHash: source !== undefined ? sha256(source) : undefined,
    nodes,
    spanText,
    lineStarts
  }
}

export function createEditPlan(
  doc: Document<DocValue>,
  operations: EditOperation[],
  options: EditPlanOptions = {}
): EditPlan {
  return EditPlan.analyse(doc, operations, options)
}

export class EditPlan {
  readonly doc: Document<DocValue>
  readonly operations: EditOperation[]
  readonly options: EditPlanOptions
  readonly snapshot: Snapshot
  readonly edits: PlannedEdit[]
  readonly conflicts: EditConflict[]
  readonly resolved: ResolvedOperation[]
  private committed = false

  private constructor(init: {
    doc: Document<DocValue>
    operations: EditOperation[]
    options: EditPlanOptions
    snapshot: Snapshot
    edits: PlannedEdit[]
    conflicts: EditConflict[]
    resolved: ResolvedOperation[]
  }) {
    this.doc = init.doc
    this.operations = init.operations
    this.options = init.options
    this.snapshot = init.snapshot
    this.edits = init.edits
    this.conflicts = init.conflicts
    this.resolved = init.resolved
  }

  get ok(): boolean {
    return this.conflicts.length === 0
  }

  static analyse(
    doc: Document<DocValue>,
    operations: EditOperation[],
    options: EditPlanOptions
  ): EditPlan {
    // Duplicate-key documents are intentionally supported: the plan surfaces
    // them as locatable DUPLICATE_KEY conflicts. Any other parse error makes
    // planning unsafe and is rejected up front.
    const blocking = doc.errors.filter(e => e.code !== 'DUPLICATE_KEY')
    if (blocking.length > 0)
      throw new Error(
        'Cannot create an edit plan for a document with parse errors: ' +
          blocking[0].message
      )

    const source = resolveSource(doc, options)
    const snapshot = makeSnapshot(source, doc.value)
    const resolved: ResolvedOperation[] = []
    const edits: PlannedEdit[] = []
    const conflicts: EditConflict[] = []
    const add = (c: EditConflict) => {
      conflicts.push(c)
      options.onDiagnostic?.(c)
    }

    // Document-wide hazard maps, computed once from the original snapshot.
    const mergeHits = mergeMaps(doc)
    const dupHits = duplicateKeyMaps(doc)
    const anchors = buildAnchorIndex(doc)

    operations.forEach((op, index) => {
      const r: ResolvedOperation = {
        op,
        index,
        found: false,
        diagnostics: [],
        planned: {
          operation: index,
          target: 'missing',
          rewrite: { reason: '' },
          anchors: [],
          diagnostics: []
        }
      }
      try {
        r._createMissing = !!options.createMissing
        resolveOperation(r, doc, snapshot, anchors, mergeHits, dupHits, add)
      } catch (err) {
        add(
          conflict(
            classifyError(err),
            err instanceof Error ? err.message : String(err),
            { operation: index }
          )
        )
      }
      resolved.push(r)
      edits.push(r.planned)
    })

    // Cross-operation checks: overlapping scopes.
    detectOverlaps(resolved, add)

    // Full trial run on a clone; validates createNode, visitor, stringify and
    // anchor resolution without touching the original document.
    if (conflicts.length === 0)
      trialCommit(doc, operations, resolved, snapshot, options, add)

    return new EditPlan({
      doc,
      operations,
      options,
      snapshot,
      edits,
      conflicts,
      resolved
    })
  }

  /** Verify the plan still matches the document and an optional source. */
  verify(source?: string): boolean {
    if (this.committed) return false
    if (!this.snapshot.nodes.has(this.doc.value)) return false
    if (source !== undefined && this.snapshot.sourceHash !== undefined)
      return sha256(source) === this.snapshot.sourceHash
    if (source === undefined && this.options.source !== undefined)
      return sha256(this.options.source) === this.snapshot.sourceHash
    return true
  }

  /**
   * Commit the plan, returning the resulting text. Throws EditPlanError if
   * conflicts exist or the plan is stale. The original document is refreshed
   * in place to reflect the result.
   */
  commit(source?: string): CommitResult {
    if (this.conflicts.length > 0) throw new EditPlanError(this.conflicts)
    const given = source ?? this.options.source ?? this.snapshot.source
    if (given !== undefined && this.snapshot.sourceHash !== undefined) {
      if (sha256(given) !== this.snapshot.sourceHash)
        throw new EditPlanError([
          conflict(
            'STALE_PLAN',
            'Source text has changed since the plan was created'
          )
        ])
    }
    if (!this.verify(source))
      throw new EditPlanError([
        conflict(
          'STALE_PLAN',
          'Document has changed since the plan was created'
        )
      ])
    if (this.committed)
      throw new EditPlanError([
        conflict('STALE_PLAN', 'Plan already committed')
      ])

    const { text, skipped } = renderResult(
      this.doc,
      this.operations,
      this.resolved,
      this.snapshot,
      this.options,
      given
    )

    // Refresh the original document from the verified result.
    refreshDocument(this.doc, text)
    this.committed = true
    return { text, edits: this.edits, skipped }
  }
}

function resolveSource(
  _doc: Document<DocValue>,
  options: EditPlanOptions
): string | undefined {
  return options.source
}

function classifyError(_err: unknown): EditConflict['code'] {
  return 'STRINGIFY_FAILED'
}

type AddConflict = (c: EditConflict) => void

export function posFor(
  snapshot: Snapshot,
  range?: Range
): { line: number; col: number } | undefined {
  if (!range || snapshot.lineStarts.length === 0) return undefined
  const off = range[0]
  let lo = 0
  let hi = snapshot.lineStarts.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (snapshot.lineStarts[mid] <= off) lo = mid + 1
    else hi = mid
  }
  const colStart = lo === 0 ? 0 : snapshot.lineStarts[lo - 1]
  return { line: lo + 1, col: off - colStart + 1 }
}

function resolveOperation(
  r: ResolvedOperation,
  doc: Document<DocValue>,
  snapshot: Snapshot,
  anchors: ReturnType<typeof buildAnchorIndex>,
  mergeHits: Map<YAMLMap, Pair>,
  dupHits: ReturnType<typeof duplicateKeyMaps>,
  add: AddConflict
): void {
  const { op, index } = r

  // test operations are evaluated during the trial commit (need a doc), but
  // their path must resolve structurally first.
  if (op.type === 'test') {
    const res = resolvePath(doc.value, op.path)
    r.found = res.found
    r.steps = res.steps
    if (!res.found) {
      add(
        conflict('MISSING_TARGET', `Test path not found: ${fmtPath(op.path)}`, {
          operation: index
        })
      )
    }
    r.planned.target = res.found ? describeLeaf(res) : 'missing'
    r.planned.node = leafNode(res) ?? undefined
    r.planned.range = leafNode(res)?.range ?? undefined
    return
  }

  if (op.type === 'move') {
    resolveMove(r, doc, snapshot, anchors, add)
    return
  }

  const res = resolvePath(doc.value, op.path)
  r.steps = res.steps
  r.found = res.found

  const parentStep = res.steps[res.steps.length - 1]
  const parent = parentStep?.container as YAMLMap | YAMLSeq | undefined

  if (op.type === 'set') {
    resolveSet(r, doc, res, snapshot, mergeHits, dupHits, anchors, add)
    return
  }

  if (!res.found) {
    add(
      conflict('MISSING_TARGET', `Path not found: ${fmtPath(op.path)}`, {
        operation: index,
        range: nearestRange(res)
      })
    )
    return
  }

  const leaf = leafNode(res)
  r.planned.node = leaf ?? undefined
  r.planned.range = leaf?.range ?? undefined
  r.planned.target = describeLeaf(res)
  r.scope = structuralScope(res)
  r.scopeRange = r.scope?.range ?? undefined

  if (op.type === 'delete' || op.type === 'rename') {
    // Merge-key guard: operating on a map that contains `<<` or on the `<<`
    // pair itself requires explicit user resolution.
    guardMerge(r, parent, leaf, add)
    guardDuplicate(r, parent, dupHits, add)
  }

  if (op.type === 'delete') {
    r.removedNode = leaf ?? undefined
    guardRemovedAnchors(r, leaf, anchors, add)
    const rec = leaf ? anchors.byNode.get(leaf) : undefined
    if (rec)
      r.planned.anchors.push({
        anchor: rec.name,
        declaration: rec.node,
        aliases: rec.aliases
      })
    r.planned.rewrite = {
      node: parent,
      range: parent?.range ?? undefined,
      reason: 'Structural deletion rewrites the enclosing collection'
    }
  }

  if (op.type === 'rename') {
    // Prevent creating a duplicate key in the same map.
    if (parent instanceof YAMLMap) {
      const toSeg =
        isNode(op.to) || typeof op.to !== 'object'
          ? { key: op.to as never, kind: 'map' as const }
          : (op.to as never)
      const existing = findMapEntry(parent, toSeg)
      if (existing.pair)
        add(
          conflict(
            'DUPLICATE_KEY',
            `Rename target key already exists in mapping`,
            { operation: index, range: existing.pair.key.range ?? undefined }
          )
        )
    }
    r.planned.rewrite = {
      node: leaf ?? undefined,
      range: leaf?.range ?? undefined,
      reason: 'Rename replaces the mapping key text'
    }
  }
}

function describeLeaf(res: ReturnType<typeof resolvePath>) {
  const last = res.steps[res.steps.length - 1]
  if (!last) return 'root'
  if (last.kind === 'map') {
    const v = last.pair?.value
    if (!v) return 'pair'
    if (v instanceof YAMLMap) return 'map'
    if (v instanceof YAMLSeq) return 'seq'
    if (v instanceof Alias) return 'alias'
    return 'scalar'
  }
  const n = last.node
  if (n instanceof YAMLMap) return 'map'
  if (n instanceof YAMLSeq) return 'seq'
  if (n instanceof Alias) return 'alias'
  return 'scalar'
}

function leafNode(res: ReturnType<typeof resolvePath>): Node | null {
  if (res.steps.length === 0) return null
  const last = res.steps[res.steps.length - 1]
  if (last.kind === 'map') return last.pair?.value ?? last.pair?.key ?? null
  return (last.node as Node) ?? null
}

function nearestRange(res: ReturnType<typeof resolvePath>): Range | undefined {
  for (let i = res.steps.length - 1; i >= 0; --i) {
    const s = res.steps[i]
    const n = (s.node as Node | null | undefined) ?? s.pair?.key
    if (n?.range) return n.range ?? undefined
  }
  return undefined
}

function structuralScope(
  res: ReturnType<typeof resolvePath>
): Node | undefined {
  return leafNode(res) ?? undefined
}

function fmtPath(path: readonly unknown[]): string {
  return path
    .map(seg => {
      if (typeof seg === 'object' && seg !== null && 'kind' in seg) {
        const o = seg as { kind: string; key?: unknown; index?: number }
        return o.kind === 'seq' ? `[${o.index}]` : String(o.key)
      }
      return String(seg)
    })
    .join('/')
}

function guardMerge(
  r: ResolvedOperation,
  parent: YAMLMap | YAMLSeq | undefined,
  leaf: Node | null,
  add: AddConflict
): void {
  // Direct operation on the `<<` pair is always blocked.
  if (
    leaf instanceof Scalar &&
    typeof leaf.value === 'symbol' &&
    leaf.value.description === '<<'
  ) {
    add(
      conflict(
        'MERGE_KEY',
        `Operation targets a YAML merge key (<<); resolve explicitly`,
        { operation: r.index, range: leaf.range ?? undefined }
      )
    )
    return
  }
  if (parent instanceof YAMLMap && findMergeKey(parent)) {
    add(
      conflict(
        'MERGE_KEY',
        `Mapping contains a YAML merge key (<<); edits to it are ambiguous`,
        { operation: r.index, range: parent.range ?? undefined }
      )
    )
  }
}

function guardDuplicate(
  r: ResolvedOperation,
  parent: YAMLMap | YAMLSeq | undefined,
  dupHits: ReturnType<typeof duplicateKeyMaps>,
  add: AddConflict
): void {
  if (!(parent instanceof YAMLMap)) return
  const hit = dupHits.find(h => h.map === parent)
  if (!hit) return
  add(
    conflict(
      'DUPLICATE_KEY',
      `Mapping has ${hit.count} occurrences of key ${JSON.stringify(hit.keyText)}; disambiguate with a candidate`,
      { operation: r.index, range: hit.range }
    )
  )
}

function guardRemovedAnchors(
  r: ResolvedOperation,
  leaf: Node | null,
  anchors: ReturnType<typeof buildAnchorIndex>,
  add: AddConflict
): void {
  if (!leaf) return
  // Any anchor declaration removed together with its subtree.
  visit(leaf, {
    Value(_key, node) {
      const rec = anchors.byNode.get(node)
      if (rec && rec.aliases.length > 0) {
        add(
          conflict(
            'DELETE_ANCHOR_IN_USE',
            `Deleting node would remove anchor &${rec.name} used by ${rec.aliases.length} alias(es)`,
            { operation: r.index, range: node.range ?? undefined }
          )
        )
        r.planned.anchors.push({
          anchor: rec.name,
          declaration: rec.node,
          aliases: rec.aliases
        })
      }
    }
  })
}

function resolveMove(
  r: ResolvedOperation,
  doc: Document<DocValue>,
  _snapshot: Snapshot,
  anchors: ReturnType<typeof buildAnchorIndex>,
  add: AddConflict
): void {
  const op = r.op as Extract<EditOperation, { type: 'move' }>
  const from = resolvePath(doc.value, op.from)
  const to = resolvePath(doc.value, op.path)

  if (!from.found) {
    add(
      conflict('MISSING_TARGET', `Move source not found: ${fmtPath(op.from)}`, {
        operation: r.index,
        range: nearestRange(from)
      })
    )
    return
  }

  const sourceNode = leafNode(from)
  r.removedNode = sourceNode ?? undefined
  r.scope = sourceNode ?? undefined
  r.scopeRange = sourceNode?.range ?? undefined
  r.planned.node = sourceNode ?? undefined
  r.planned.range = sourceNode?.range ?? undefined
  r.planned.target = describeLeaf(from)

  // Moving a node into itself or one of its descendants is invalid.
  if (sourceNode) {
    let intoSelf = false
    visit(doc.value, {
      Node(_key, node) {
        if (node === sourceNode && toPathContains(to.steps, sourceNode))
          intoSelf = true
      }
    })
    if (intoSelf || containsPath(from.steps, to.steps)) {
      add(
        conflict(
          'MOVE_INTO_SELF',
          `Cannot move a node into itself or one of its descendants`,
          { operation: r.index, range: sourceNode.range ?? undefined }
        )
      )
      return
    }
  }

  // A move destination may be an existing leaf (overwrite) or a new key/index
  // inside an existing container, exactly like a `set`.
  const toParentStep = to.steps[to.steps.length - 1]
  if (!to.found) {
    if (op.path.length === 0) {
      // moving to root is allowed
    } else if (to.steps.length < op.path.length - 1) {
      add(
        conflict(
          'MISSING_TARGET',
          `Move destination parent not found: ${fmtPath(op.path)}`,
          {
            operation: r.index
          }
        )
      )
      return
    }
  }

  // Anchors inside the moved subtree keep working (same document), but if the
  // move detaches an anchor that aliases rely on via order, that is caught in
  // the trial commit. Record affected anchors for diagnostics.
  if (sourceNode) {
    visit(sourceNode, {
      Value(_key, node) {
        const rec = anchors.byNode.get(node)
        if (rec)
          r.planned.anchors.push({
            anchor: rec.name,
            declaration: rec.node,
            aliases: rec.aliases
          })
      }
    })
  }

  r.steps = from.steps
  r.planned.rewrite = {
    node: toParentStep?.container ?? sourceNode ?? undefined,
    range: toParentStep?.container?.range ?? sourceNode?.range ?? undefined,
    reason: 'Move rewrites the source and destination collections'
  }
}

function toPathContains(steps: ResolvedStep[], node: Node): boolean {
  return steps.some(
    s => s.node === node || s.pair?.key === node || s.pair?.value === node
  )
}

/** True when `inner` path targets a node within `outer` (or is equal). */
function containsPath(outer: ResolvedStep[], inner: ResolvedStep[]): boolean {
  if (inner.length < outer.length) return false
  for (let i = 0; i < outer.length; ++i)
    if (outer[i].container !== inner[i].container) return false
  return true
}

function resolveSet(
  r: ResolvedOperation,
  doc: Document<DocValue>,
  res: ReturnType<typeof resolvePath>,
  _snapshot: Snapshot,
  _mergeHits: Map<YAMLMap, Pair>,
  _dupHits: ReturnType<typeof duplicateKeyMaps>,
  anchors: ReturnType<typeof buildAnchorIndex>,
  add: AddConflict
): void {
  const op = r.op as Extract<EditOperation, { type: 'set' }>
  const createMissing = !!createMissingOption(r)
  // Re-resolve allowing creation of intermediate nodes.
  const resolved = resolveForSet(doc, doc.value, op.path, createMissing)
  r.steps = resolved.steps
  r.found = !resolved.leafMissing

  const last = resolved.steps[resolved.steps.length - 1]
  const parent = last?.container as YAMLMap | YAMLSeq | undefined

  if (!last) {
    r.planned.target = 'root'
    r.planned.rewrite = { reason: 'Replace document root' }
    return
  }

  if (resolved.intermediateMissing) {
    // A genuinely missing intermediate parent. Appending to a sequence or
    // adding a key to an existing map still provides a leaf container.
    add(
      conflict(
        'MISSING_TARGET',
        createMissing
          ? `Cannot create intermediate parent for: ${fmtPath(op.path)}`
          : `Path not found: ${fmtPath(op.path)}`,
        { operation: r.index }
      )
    )
    return
  }

  if (parent) {
    // Setting a key in a map that contains a merge key is allowed only for
    // brand-new keys; overwriting is blocked.
    if (
      parent instanceof YAMLMap &&
      findMergeKey(parent) &&
      !resolved.leafMissing
    ) {
      add(
        conflict(
          'MERGE_KEY',
          `Overwriting within a mapping containing a merge key (<<) is ambiguous`,
          { operation: r.index, range: parent.range ?? undefined }
        )
      )
    }
    // Duplicate keys: setting an existing ambiguous key requires candidate.
    if (parent instanceof YAMLMap) {
      const seg = op.path[op.path.length - 1]
      const norm =
        typeof seg === 'object' && seg !== null && 'kind' in seg
          ? seg
          : { key: seg, kind: 'map' as const }
      if (norm.kind === 'map') {
        const found = findMapEntry(parent, norm)
        if (found.occurrences.length > 1) {
          add(
            conflict(
              'DUPLICATE_KEY',
              `Key ${JSON.stringify(norm.key)} occurs ${found.occurrences.length} times; resolve duplicates before editing`,
              {
                operation: r.index,
                range:
                  found.occurrences[0]?.pair?.key.range ??
                  parent.range ??
                  undefined
              }
            )
          )
        }
      }
    }
  }

  const leaf = leafNode(res)
  r.planned.node = leaf ?? undefined
  r.planned.range = leaf?.range ?? undefined
  r.planned.target = resolved.leafMissing ? 'missing' : describeLeaf(res)
  r.planned.rewrite = {
    node: parent,
    range: parent?.range ?? undefined,
    reason: resolved.leafMissing
      ? 'Insert a new entry into the enclosing collection'
      : narrowReason(leaf)
  }

  // Overwriting a node that declares an anchor referenced elsewhere is fine
  // (anchor can move onto the new value only if it carries the anchor), but
  // silently dropping it is not: flag for awareness unless new value retains.
  if (leaf) {
    const rec = anchors.byNode.get(leaf)
    if (rec && rec.aliases.length > 0)
      r.planned.anchors.push({
        anchor: rec.name,
        declaration: rec.node,
        aliases: rec.aliases
      })
  }
}

function narrowReason(leaf: Node | null): string {
  if (leaf instanceof Scalar || leaf instanceof Alias)
    return 'Replace the scalar/alias value text'
  return 'Rewrite the enclosing collection entry'
}

function createMissingOption(r: ResolvedOperation): boolean {
  return !!r._createMissing
}

function detectOverlaps(resolved: ResolvedOperation[], add: AddConflict): void {
  const structural = resolved.filter(
    r => (r.op.type === 'delete' || r.op.type === 'move') && r.scopeRange
  )
  for (let i = 0; i < structural.length; ++i) {
    for (let j = i + 1; j < structural.length; ++j) {
      const a = structural[i]
      const b = structural[j]
      const sa = nodeSpanish(a)
      const sb = nodeSpanish(b)
      if (sa && sb && spansOverlap(sa, sb)) {
        add(
          conflict(
            'OVERLAPPING_OPERATION',
            `Operations #${a.index} and #${b.index} overlap (${a.op.type} vs ${b.op.type}); disambiguate their paths`,
            { operation: b.index, range: b.scopeRange }
          )
        )
      }
    }
  }
}

function nodeSpanish(r: ResolvedOperation): Span | undefined {
  if (!r.scopeRange) return undefined
  return { start: r.scopeRange[0], end: r.scopeRange[2] }
}

function spansOverlap(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end
}

// ---------------------------------------------------------------------------
// Trial commit & rendering
// ---------------------------------------------------------------------------

/**
 * Execute all operations on a clone, run the visitor and stringify, surfacing
 * every failure as a conflict without mutating the original document.
 */
function trialCommit(
  doc: Document<DocValue>,
  operations: EditOperation[],
  resolved: ResolvedOperation[],
  snapshot: Snapshot,
  options: EditPlanOptions,
  add: AddConflict
): void {
  let clone: Document<DocValue>
  try {
    clone = planningClone(doc)
  } catch (err) {
    add(conflict('STRINGIFY_FAILED', `Failed to clone document: ${msg(err)}`))
    return
  }

  const skipped: number[] = []
  try {
    executeAll(clone, snapshot.source, operations, resolved, skipped, add)
    if (options.visitor) {
      try {
        visit(clone, options.visitor)
      } catch (err) {
        add(conflict('VISITOR_FAILED', msg(err)))
        return
      }
    }
    // Validate anchor/alias resolution after mutation.
    const bad = unresolvedAliases(clone)
    for (const alias of bad) {
      // Distinguish a move that broke an anchor from plain unresolved alias.
      add(
        conflict(
          'MOVE_ANCHOR_BROKEN',
          `Alias *${alias.source} no longer resolves to its anchor after edits`,
          { range: alias.range ?? undefined }
        )
      )
    }
    // Full stringification on the clone proves createNode + stringify work.
    clone.toString(options.toStringOptions)
  } catch (err) {
    add(conflict(classifyThrown(err), msg(err)))
  }
}

function classifyThrown(err: unknown): EditConflict['code'] {
  const m = msg(err)
  if (/tag|resolve|create/i.test(m)) return 'CREATE_NODE_FAILED'
  if (/visitor/i.test(m)) return 'VISITOR_FAILED'
  return 'STRINGIFY_FAILED'
}

/**
 * Clone a document for analysis, dropping DUPLICATE_KEY parse errors which
 * the plan represents as explicit, locatable conflicts.
 */
function planningClone(doc: Document<DocValue>): Document<DocValue> {
  const clone = doc.clone()
  clone.errors = clone.errors.filter(e => e.code !== 'DUPLICATE_KEY')
  return clone
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function executeAll(
  clone: Document<DocValue>,
  source: string | undefined,
  operations: EditOperation[],
  resolvedOps: ResolvedOperation[],
  skipped: number[],
  add: AddConflict
): LeafEdit[] {
  const leafEdits: LeafEdit[] = []

  operations.forEach((op, index) => {
    const r = resolvedOps[index]

    if (op.type === 'test') {
      const res = resolvePath(clone.value, op.path)
      const leaf =
        res.steps.length === 0
          ? clone.value
          : ((res.steps[res.steps.length - 1].pair ??
              res.steps[res.steps.length - 1].node) as Node | Pair)
      const pass = evaluateTest(clone, leaf, op.test)
      if (!pass) {
        if (op.soft) skipped.push(index)
        else
          add(
            conflict('TEST_FAILED', `Assertion failed at ${fmtPath(op.path)}`, {
              operation: index
            })
          )
      }
      return
    }

    if (op.type === 'move') {
      // Determine the destination parent *before* mutation so its identity is
      // captured from the original tree.
      const toRes = resolveForSet(clone, clone.value, op.path, false)
      const toLast = toRes.steps[toRes.steps.length - 1]
      const toParent = toLast?.container as YAMLMap | YAMLSeq | undefined
      const fromLast = r.steps![r.steps!.length - 1]
      const fromParent = fromLast?.container as YAMLMap | YAMLSeq | undefined

      applyMove(clone, r.steps!, op.path)

      // Render the destination collection (it now contains the moved node).
      if (toParent)
        leafEdits.push({
          operation: index,
          mode: 'collection',
          parent: toParent,
          ownerPair: ownerPairOf(r.steps!, toParent),
          oldNode: r.removedNode ?? undefined
        })
      // Render the source collection too unless it is the same collection.
      if (fromParent && fromParent !== toParent) {
        const fop = ownerPairOf(r.steps!, fromParent)
        leafEdits.push({
          operation: index,
          mode: 'collection',
          parent: fromParent,
          ownerPair: fop,
          oldNode: r.removedNode ?? undefined
        })
      }
      return
    }

    if (op.type === 'delete') {
      const last = r.steps![r.steps!.length - 1]
      const before = captureBefore(clone, r)
      if (source !== undefined && last.kind === 'map' && last.pair) {
        const deleteSpan = pairLineSpan(source, last.pair)
        applyDelete(clone.value, r.steps!)
        leafEdits.push({
          operation: index,
          mode: 'delete-pair',
          parent: last.container as YAMLMap,
          pair: last.pair,
          oldNode: before,
          deleteSpan
        })
      } else if (source !== undefined && last.kind === 'seq' && before) {
        const deleteSpan = seqItemSpan(
          source,
          last.container as YAMLSeq,
          last.index as number,
          before
        )
        applyDelete(clone.value, r.steps!)
        leafEdits.push({
          operation: index,
          mode: 'delete-seq-item',
          seq: last.container as YAMLSeq,
          index: last.index,
          oldNode: before,
          deleteSpan
        })
      } else {
        applyDelete(clone.value, r.steps!)
        leafEdits.push({
          operation: index,
          mode: 'collection',
          parent: last.container as YAMLMap | YAMLSeq,
          ownerPair: ownerPairOf(r.steps!, last.container as YAMLMap | YAMLSeq),
          oldNode: before
        })
      }
      return
    }

    if (op.type === 'rename') {
      const last = r.steps![r.steps!.length - 1]
      const newKey = isNode(op.to) ? op.to : clone.createNode(op.to)
      const oldKey = last.pair!.key
      applyRename(r.steps!, newKey)
      const narrow = oldKey instanceof Scalar && newKey instanceof Scalar
      leafEdits.push({
        operation: index,
        mode: narrow ? 'scalar-key' : 'collection',
        parent: last.container as YAMLMap,
        pair: last.pair!,
        oldNode: oldKey,
        newNode: newKey
      })
      return
    }

    // set
    if (op.if) {
      const res = resolvePath(clone.value, op.path)
      const step = res.steps[res.steps.length - 1]
      const leaf: Node | Pair = !step
        ? clone.value
        : step.kind === 'map'
          ? ((step.pair?.value ?? step.pair?.key) as Node)
          : (step.node as Node)
      if (!evaluateTest(clone, leaf, op.if)) {
        skipped.push(index)
        return
      }
    }

    const created =
      op.node !== undefined
        ? cloneNodeValue(clone, op.node)
        : clone.createNode(op.value)

    const resolved = resolveForSet(
      clone,
      clone.value,
      op.path,
      !!r._createMissing
    )
    const last = resolved.steps[resolved.steps.length - 1]

    if (!last) {
      applySet(clone, { ...op, node: undefined }, resolved, created)
      leafEdits.push({
        operation: index,
        mode: 'root',
        oldNode: doc0(clone),
        newNode: created
      })
      return
    }

    const oldLeaf = resolved.leafMissing
      ? null
      : last.kind === 'map'
        ? (last.pair!.value ?? last.pair!.key)
        : (last.node as Node)

    applySet(clone, { ...op, node: undefined }, resolved, created)

    leafEdits.push(
      classifySetEdit(
        index,
        clone,
        op,
        last,
        resolved.steps,
        resolved.leafMissing,
        oldLeaf,
        created,
        (last.container as YAMLMap).flow === true ||
          (last.container as YAMLSeq).flow === true
      )
    )
  })

  return leafEdits
}

/** The map pair whose value is `container`, when it is a mapping value. */
function nearestPositionedAncestor(
  steps: ResolvedStep[]
): YAMLMap | YAMLSeq | undefined {
  for (let i = steps.length - 1; i >= 0; --i) {
    const c = steps[i].container as YAMLMap | YAMLSeq
    if (c.range) return c
  }
  return undefined
}

function ownerPairOf(
  steps: ResolvedStep[],
  container: YAMLMap | YAMLSeq
): Pair | undefined {
  // A step's `container` is owned by the pair on the *preceding* step when
  // that pair's value equals the container.
  for (let i = steps.length - 1; i >= 0; --i) {
    const st = steps[i]
    if (st.container === container) {
      const prev = steps[i - 1]
      if (prev?.kind === 'map' && prev.pair?.value === container)
        return prev.pair
    }
    if (st.kind === 'map' && st.pair?.value === container) return st.pair
  }
  return undefined
}

function doc0(cloneDoc: Document<DocValue>): Node {
  return cloneDoc.value
}

function cloneNodeValue(_clone: Document<DocValue>, node: Node): Node {
  // Reuse provided node directly within the clone; it was constructed via
  // the same schema-compatible createNode by the caller.
  return node
}

function captureBefore(
  _clone: Document<DocValue>,
  r: ResolvedOperation
): Node | null {
  const last = r.steps![r.steps!.length - 1]
  if (!last) return null
  if (last.kind === 'map') return last.pair!.value ?? last.pair!.key
  return last.node as Node
}

function classifySetEdit(
  operation: number,
  clone: Document<DocValue>,
  op: Extract<EditOperation, { type: 'set' }>,
  last: ResolvedStep,
  allSteps: ResolvedStep[],
  leafMissing: boolean,
  oldLeaf: Node | null,
  newNode: Node,
  _parentFlow: boolean
): LeafEdit {
  const parent = last.container as YAMLMap | YAMLSeq

  if (leafMissing) {
    if (!parent.range) {
      const ancestor = nearestPositionedAncestor(allSteps) ?? clone.value
      return {
        operation,
        mode: 'collection',
        parent: ancestor as YAMLMap | YAMLSeq,
        oldNode: oldLeaf
      }
    }
    if (parent instanceof YAMLMap) {
      const segRaw = op.path[op.path.length - 1]
      const keyNode =
        typeof segRaw === 'object' && segRaw !== null && 'kind' in segRaw
          ? clone.createNode((segRaw as { key: unknown }).key)
          : clone.createNode(segRaw)
      return {
        operation,
        mode: 'insert-pair',
        parent,
        ownerPair: ownerPairOf(allSteps, parent),
        newNode: keyNode,
        valueNode: newNode
      }
    }
    return {
      operation,
      mode: 'insert-seq-item',
      seq: parent,
      index: last.index ?? parent.length,
      newNode
    }
  }

  // Narrow scalar swap when both are scalars and the surrounding context is
  // unchanged.
  if (
    (oldLeaf instanceof Scalar || oldLeaf instanceof Alias) &&
    newNode instanceof Scalar &&
    !parent.flow
  ) {
    return {
      operation,
      mode: 'scalar-value',
      parent,
      pair: last.pair,
      seq: last.kind === 'seq' ? (parent as YAMLSeq) : undefined,
      index: last.index,
      oldNode: oldLeaf,
      newNode
    }
  }
  if (last.kind === 'seq') {
    return {
      operation,
      mode: 'seq-item',
      seq: parent as YAMLSeq,
      index: last.index,
      oldNode: oldLeaf,
      newNode
    }
  }
  return {
    operation,
    mode: 'pair',
    parent: parent,
    pair: last.pair!,
    oldNode: oldLeaf,
    newNode
  }
}

// ---------------------------------------------------------------------------
// Final rendering on the real document (only reached when conflict-free)
// ---------------------------------------------------------------------------

function renderResult(
  doc: Document<DocValue>,
  operations: EditOperation[],
  resolved: ResolvedOperation[],
  _snapshot: Snapshot,
  options: EditPlanOptions,
  source: string | undefined
): { text: string; skipped: number[] } {
  const clone = planningClone(doc)
  const skipped: number[] = []
  const conflicts: EditConflict[] = []
  const add = (c: EditConflict) => conflicts.push(c)

  const leafEdits = executeAll(
    clone,
    source,
    operations,
    resolved,
    skipped,
    add
  )
  if (options.visitor) visit(clone, options.visitor)
  if (conflicts.length > 0) throw new EditPlanError(conflicts)

  if (source === undefined) {
    // No source available: fall back to a clean full stringification.
    return { text: clone.toString(options.toStringOptions), skipped }
  }

  const reps = buildReplacements(
    source,
    clone,
    leafEdits,
    options.toStringOptions
  )
  if (process.env.EDIT_DBG)
    console.error(
      'REPS',
      reps.map(r => [r.start, r.end, JSON.stringify(r.text), r.reason])
    )
  const text = spliceAll(source, normalizeReplacementEndings(source, reps))

  // Prove the spliced text round-trips and stringifies to itself.
  const check = parseDocument(text, parseOptionsFrom(doc))
  const checkErrors = check.errors.filter(e => e.code !== 'DUPLICATE_KEY')
  if (checkErrors.length > 0)
    throw new EditPlanError([
      conflict('STRINGIFY_FAILED', checkErrors[0].message)
    ])

  return { text, skipped }
}

function parseOptionsFrom(doc: Document<DocValue>) {
  return {
    keepSourceTokens: true,
    schema: doc.schema,
    logLevel: doc.options.logLevel,
    prettyErrors: doc.options.prettyErrors,
    strict: doc.options.strict,
    intAsBigInt: doc.options.intAsBigInt,
    stringKeys: doc.options.stringKeys
  }
}

/**
 * Ensure block pair/item replacements that consume a trailing newline emit
 * exactly one, and that collection replacements do not duplicate line ends.
 */
function normalizeReplacementEndings(
  source: string,
  reps: Replacement[]
): Replacement[] {
  return reps.map(rep => {
    let { text } = rep
    // Drop a synthetic trailing newline when the original span did not end
    // on one (e.g. final entry without newline or flow collections).
    const endsOnNL =
      rep.end >= source.length ||
      source[rep.end - 1] === '\n' ||
      source[rep.end - 1] === '\r'
    if (!endsOnNL && text.endsWith('\n')) {
      // keep if replacement itself is multi-line block content without final
      // newline in source: trim a single trailing newline we appended
      text = text.replace(/\n$/, '')
    }
    return { ...rep, text }
  })
}

/**
 * Refresh the live document in place from the newly produced text while
 * preserving object identity, directives and the schema instance.
 */
function refreshDocument(doc: Document<DocValue>, text: string): void {
  const fresh = parseDocument(text, parseOptionsFrom(doc))
  // Adopt the freshly composed value (correct ranges/srcTokens) while keeping
  // the same Document instance and its schema/directives wiring.
  doc.value = fresh.value
  doc.range = fresh.range
  doc.directives = fresh.directives ?? doc.directives
  doc.commentBefore = fresh.commentBefore
  doc.comment = fresh.comment
  doc.errors = fresh.errors
  doc.warnings = fresh.warnings
}
