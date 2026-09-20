import type { EditConflict } from './types.ts'

/** Error thrown when committing a plan that has blocking conflicts. */
export class EditPlanError extends Error {
  conflicts: EditConflict[]
  constructor(conflicts: EditConflict[]) {
    super(
      conflicts.length === 1
        ? conflicts[0].message
        : `Edit plan has ${conflicts.length} conflicts`
    )
    this.name = 'EditPlanError'
    this.conflicts = conflicts
  }
}
