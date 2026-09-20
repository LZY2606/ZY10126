import type { Document } from '../doc/Document.ts'
import { EditPlan } from './plan.ts'

export { EditPlanConflictError } from './errors.ts'
import type { Edit, EditPlanOptions } from './types.ts'

export { EditPlan } from './plan.ts'

export function createEditPlan(
  doc: Document,
  edits: Iterable<Edit>,
  options?: EditPlanOptions
): EditPlan {
  return new EditPlan(doc, edits, options)
}

export type {
  CommitResult,
  Edit,
  EditConflict,
  EditConflictCode,
  EditPath,
  EditPathSegment,
  EditPlanItem,
  EditPlanOptions,
  EditTest,
  SetEdit,
  DeleteEdit,
  RenameKeyEdit,
  MoveEdit
} from './types.ts'
