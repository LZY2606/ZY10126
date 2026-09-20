import type { Document } from '../doc/Document.ts'
import type { Alias } from '../nodes/Alias.ts'
import type { Pair } from '../nodes/Pair.ts'
import type { Node, Range } from '../nodes/types.ts'
import type { ToStringOptions } from '../options.ts'

/**
 * A single segment of a semantic path into a document.
 *
 * - Strings select map keys; numbers select sequence indices.
 * - `{ key, occurrence }` disambiguates duplicate map keys,
 *   using a zero-based occurrence index among equal key values.
 */
export type EditPathSegment =
  string | number | { key: string | number; occurrence: number }

/** A semantic path from the document root to a target node. */
export type EditPath = readonly EditPathSegment[]

/** A predicate evaluated against the current node at a path. */
export type EditTest = (
  node: Node | null,
  path: EditPath,
  doc: Document
) => boolean

export type SetEdit = {
  type: 'set'
  path: EditPath
  value: unknown
  /** Only apply when the test passes. A failing test is reported as a conflict. */
  test?: EditTest
}

export type DeleteEdit = {
  type: 'delete'
  path: EditPath
  /** Only delete when the test passes. A failing test is reported as a conflict. */
  test?: EditTest
}

export type RenameKeyEdit = {
  type: 'renameKey'
  /** Path to the pair whose key is renamed. */
  path: EditPath
  /** The new key value (wrapped into a node via the document schema). */
  newKey: unknown
  test?: EditTest
}

export type MoveEdit = {
  type: 'move'
  /** Path of the subtree to move. */
  from: EditPath
  /** Destination path. Map keys must not already exist; sequence indices
   *  are interpreted against the original snapshot. */
  to: EditPath
  test?: EditTest
}

export type Edit = SetEdit | DeleteEdit | RenameKeyEdit | MoveEdit

/** Error codes used by edit plan conflicts. */
export type EditConflictCode =
  | 'PATH_NOT_FOUND'
  | 'PATH_TYPE_MISMATCH'
  | 'DUPLICATE_KEY'
  | 'MERGE_KEY'
  | 'DUPLICATE_TARGET_KEY'
  | 'ALIAS_TO_DELETED_ANCHOR'
  | 'ANCHOR_ORDER'
  | 'OVERLAPPING_OPERATIONS'
  | 'CONDITION_FAILED'
  | 'INVALID_EDIT'
  | 'STALE_PLAN'
  | 'EDIT_ERROR'

/** A localisable, positionable problem detected while planning edits. */
export interface EditConflict {
  code: EditConflictCode
  /** Human-readable explanation. */
  message: string
  /** Index of the edit that caused the conflict. */
  editIndex?: number
  /** Source range of the offending node or token, when known. */
  range?: Range
  path?: EditPath
  /** Additional structured context, e.g. duplicate-key candidates. */
  candidates?: Array<{
    path: EditPath
    range?: Range
    current?: boolean
  }>
  anchor?: string
}

/** An anchor/alias relationship affected by an edit. */
export interface AnchorImpact {
  anchor: string
  /** The node carrying the anchor, when present in the document. */
  anchorNode?: Node
  /** Alias nodes referencing the anchor. */
  aliases: Alias[]
}

export interface EditPlanDiagnostic {
  level: 'info' | 'warning'
  message: string
  range?: Range
}

/** The result of planning a single edit. */
export interface EditPlanItem {
  edit: Edit
  editIndex: number
  /** The node hit by the edit path, if any. */
  node: Node | Pair | null
  /** The parent collection of the target, when applicable. */
  parent: Node | Document | null
  /** Original source range of the target node. */
  range?: Range
  path: EditPath
  /** Anchors and aliases touched by the edit. */
  anchorImpacts: AnchorImpact[]
  /** The innermost original collection that will be rewritten. */
  rewriteRoot: Node | Document | null
  /** Why the rewrite scope was (possibly) enlarged. */
  rewriteReason: string
  /** Source ranges that are replaced when the plan is committed. */
  rewriteRanges: Range[]
  diagnostics: EditPlanDiagnostic[]
}

export interface CommitResult {
  /** The rendered document after applying the plan. */
  text: string
  /** The document after applying the plan. */
  doc: Document
  items: EditPlanItem[]
  /** Source ranges replaced with re-rendered text. */
  replacedRanges: Array<{ range: Range; reason: string }>
}

export interface EditPlanOptions {
  /**
   * Original source text. Required for byte-level preservation:
   * untouched subtrees with `srcToken` values are copied verbatim.
   * When omitted, the commit falls back to a full document stringify.
   */
  source?: string
  /** Stringify options used for re-rendered parts of the document. */
  toStringOptions?: ToStringOptions
  /**
   * If true (default), commits refuse plans whose pre-image no longer
   * matches the document/source snapshot.
   */
  verifySnapshot?: boolean
}
