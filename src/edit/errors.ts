import type { EditConflict } from './types.ts'

/** Thrown when committing a plan that still has conflicts. */
export class EditPlanConflictError extends Error {
  readonly conflicts: EditConflict[]
  constructor(conflicts: EditConflict[]) {
    super(
      conflicts.length === 1
        ? conflicts[0].message
        : `Edit plan has ${conflicts.length} conflicts`
    )
    this.name = 'EditPlanConflictError'
    this.conflicts = conflicts
  }
}
