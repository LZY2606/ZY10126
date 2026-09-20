/**
 * Opt-in, transactional edit plans.
 *
 * An {@link EditPlan} analyses a set of semantic-path operations against a
 * single parse snapshot before changing anything. Plans either commit as a
 * whole or report locatable conflicts; the underlying `Document` methods are
 * not affected.
 *
 * @example
 * ```js
 * import { parseDocument } from 'yaml'
 * import { createEditPlan } from 'yaml/edit'
 *
 * const source = 'a: 1\nb: 2\n'
 * const doc = parseDocument(source, { keepSourceTokens: true })
 * const plan = createEditPlan(doc, [{ type: 'set', path: ['b'], value: 3 }], {
 *   source
 * })
 * if (!plan.ok) for (const c of plan.conflicts) console.error(c)
 * else console.log(plan.commit().text)
 * ```
 *
 * @module
 */

export { createEditPlan, EditPlan, type Snapshot } from './plan.ts'
export { EditPlanError } from './errors.ts'
export type {
  AnchorUsage,
  CommitResult,
  EditConflict,
  EditConflictCode,
  EditDiagnostic,
  EditOperation,
  EditPlanOptions,
  EditPath,
  MapSegment,
  PathKey,
  PathSegment,
  PlannedEdit,
  SeqSegment,
  SetOperation,
  TestClause
} from './types.ts'
