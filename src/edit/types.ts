import type { Document, DocValue } from '../doc/Document.ts'
import type { Alias } from '../nodes/Alias.ts'
import type { Node, Primitive, Range } from '../nodes/types.ts'
import type { visitor } from '../visit.ts'
import type { ToStringOptions } from '../options.ts'

/**
 * A single selector within an edit path.
 *
 * - A `string`/`number`/`boolean`/`bigint`/`null` selects a mapping key.
 * - A `number` selects either a mapping with a numeric key or a sequence
 *   index; use {@link SeqSegment} to disambiguate.
 * - A {@link Node} selects the mapping pair whose key is the exact node.
 */
export type PathKey = Primitive | Node

export type PathSegment = PathKey | SeqSegment | MapSegment

/** Explicitly select a sequence index, even when it is a valid mapping key. */
export interface SeqSegment {
  index: number
  kind: 'seq'
}

/**
 * Select a mapping entry.
 *
 * `candidate` disambiguates repeated keys by selecting the 0-based
 * occurrence in source order. Negative counts from the end, so `-1` is the
 * last (semantically active) occurrence. Ignored for non-duplicate keys.
 */
export interface MapSegment {
  key: PathKey
  kind: 'map'
  candidate?: number
}

export type EditPath = readonly PathSegment[]

export type EditOperationType = 'set' | 'delete' | 'rename' | 'move' | 'test'

interface OperationBase {
  /**
   * Path to the target, resolved against the original snapshot.
   * Missing intermediate parents are an error for every operation
   * except `set`, which creates them as needed.
   */
  path: EditPath

  /** Optional free-form label echoed in diagnostics and results. */
  comment?: string
}

export interface SetOperation extends OperationBase {
  type: 'set'
  /** New value; raw JS values are converted through the document schema. */
  value?: unknown
  /** Use an already-constructed node/pair as the replacement value. */
  node?: Node
  /**
   * When combined with a {@link TestClause}, skip the mutation rather than
   * failing if the condition does not hold.
   */
  if?: TestClause
  test?: never
}

export interface DeleteOperation extends OperationBase {
  type: 'delete'
}

export interface RenameOperation extends OperationBase {
  type: 'rename'
  /** The new mapping key. */
  to: PathKey
}

export interface MoveOperation extends OperationBase {
  type: 'move'
  /** Source path; `path` is the destination. */
  from: EditPath
}

export interface TestOperation extends OperationBase {
  type: 'test'
  test: TestClause
  /**
   * If false (default), a failing test is a blocking conflict.
   * If true, a failing test only records a non-blocking warning.
   */
  soft?: boolean
}

export type EditOperation =
  | SetOperation
  | DeleteOperation
  | RenameOperation
  | MoveOperation
  | TestOperation

/**
 * An assertion about the current value at a path.
 *
 * - `exists`: the target node exists (or not, when false).
 * - `equals`: the target's plain-JS value deep-equals `value`.
 * - `match`: a custom predicate receiving the node and document.
 */
export type TestClause =
  | { exists: boolean }
  | { equals: unknown }
  | {
      match: (
        node: Node | Pair | null | undefined,
        doc: Document<DocValue>
      ) => boolean
    }

export interface EditPlanOptions {
  /**
   * The original source text. Required for byte-preserving edits and for
   * tamper detection; when omitted the plan falls back to a full
   * stringification of the document.
   */
  source?: string

  /** Options forwarded to the verifying `toString()` call. */
  toStringOptions?: ToStringOptions

  /**
   * Optional visitor run against the mutated clone during analysis.
   * A thrown error aborts the plan with a `VISITOR_FAILED` conflict and
   * leaves the original document untouched.
   */
  visitor?: visitor

  /**
   * Create missing intermediate mappings/sequences during a `set`.
   * Numeric segments are created as sequences, other segments as mappings.
   * Default: `false`.
   */
  createMissing?: boolean

  /** Called for every collected diagnostic while the plan is analysed. */
  onDiagnostic?: (diagnostic: EditDiagnostic) => void
}

export type EditConflictCode =
  | 'CREATE_NODE_FAILED'
  | 'DELETE_ANCHOR_IN_USE'
  | 'DUPLICATE_KEY'
  | 'MERGE_KEY'
  | 'MISSING_TARGET'
  | 'MOVE_INTO_SELF'
  | 'MOVE_ANCHOR_BROKEN'
  | 'NON_COLLECTION_PARENT'
  | 'OVERLAPPING_OPERATION'
  | 'STALE_PLAN'
  | 'STRINGIFY_FAILED'
  | 'TEST_FAILED'
  | 'TYPE_MISMATCH'
  | 'UNRESOLVED_ALIAS'
  | 'VISITOR_FAILED'

export interface EditDiagnostic {
  code: EditConflictCode
  /** Human-readable explanation. */
  message: string
  /** Index of the operation responsible, when applicable. */
  operation?: number
  /** Source range the diagnostic applies to, when known. */
  range?: Range
  /** Source location, when a line counter is available. */
  pos?: { line: number; col: number }
}

/** A hard conflict preventing the plan from being committed. */
export type EditConflict = EditDiagnostic

export interface AnchorUsage {
  anchor: string
  /** Node declaring the anchor. */
  declaration: Node
  /** Alias nodes referencing the declaration. */
  aliases: Alias[]
}

export interface PlannedEdit {
  /** Operation index that produced this edit. */
  operation: number
  /** Kind of the resolved target. */
  target: 'scalar' | 'map' | 'seq' | 'pair' | 'alias' | 'root' | 'missing'
  /** The resolved target node, when present. */
  node?: Node
  /** Original source range of the target. */
  range?: Range
  /**
   * The smallest ancestor collection that will be rewritten to effect the
   * change. Narrow scalar edits rewrite only the scalar value.
   */
  rewrite: {
    node?: Node
    range?: Range
    /** Why this (possibly widened) region needs rewriting. */
    reason: string
  }
  /** Anchors/aliases whose text or resolution is touched by this edit. */
  anchors: AnchorUsage[]
  diagnostics: EditDiagnostic[]
}

export interface CommitResult {
  /** The resulting YAML source. */
  text: string
  /** Per-operation resolved edits. */
  edits: PlannedEdit[]
  /** True when a conditional `set` was skipped because its test failed. */
  skipped: number[]
}

// Imported for type position only.
import type { Pair } from '../nodes/Pair.ts'
