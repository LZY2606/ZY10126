# Edit Plans

For configuration migrations and other tooling, it is often necessary to apply
a set of semantic edits to an existing YAML document while preserving as much of
the original formatting as possible: anchors, aliases, comments, flow/block
styles, and the layout of nodes you never touched.

Directly mutating a parsed `Document` (with `map.set`, `seq.splice`, etc.)
applies changes immediately and independently, which makes it hard to validate a
whole migration up front or to keep unrelated formatting stable. The optional
**edit plan** API instead analyses a group of operations against a single parse
snapshot, reports every risk as a locatable conflict, and only then commits all
of the changes atomically.

```js
import { parseDocument } from 'yaml'
import { createEditPlan } from 'yaml/edit'
```

The API is opt-in and does not change the behaviour of any existing `Document`
or collection method. Parse with `keepSourceTokens: true` and keep the original
source string available to enable byte-preserving edits and tamper detection.

## 1. Preview — analyse without changing anything

Pass the document, an array of operations, and the original source.
`createEditPlan` resolves every path against the same snapshot and returns a
plan; nothing is written to the document.

```js
const source = [
  'server:',
  '  host: localhost',
  '  port: 8080',
  'features:',
  '  - tls',
  '  - gzip'
].join('\n') + '\n'

const doc = parseDocument(source, { keepSourceTokens: true })

const plan = createEditPlan(
  doc,
  [
    { type: 'set', path: ['server', 'port'], value: 443 },
    { type: 'set', path: ['features', { kind: 'seq', index: 0 }], value: 'https' }
  ],
  { source }
)
```

Each plan item records:

- the resolved `Node` and its original source range,
- the anchors and aliases affected by the edit,
- the smallest ancestor that will be rewritten and a `reason` explaining it,
- structured diagnostics with source positions.

```js
for (const edit of plan.edits) {
  console.log(edit.target, edit.range, edit.rewrite.reason, edit.anchors)
}
```

All operations are resolved from the **original snapshot** using stable node
identity, so a later operation never "drifts" because an earlier operation
deleted a sequence element: index `1` always refers to whatever was at index `1`
in the original document.

### Path segments

Path segments distinguish mapping keys from sequence indices, even when a map
key is numeric:

- `'name'` / `0` / `true` / `null` — a mapping key
- `{ kind: 'seq', index: 2 }` — a sequence index (negative counts from the end)
- `{ kind: 'map', key: 'id', candidate: 0 }` — a mapping key with an explicit
  disambiguation selector for repeated keys

### Operations

| Operation | Shape | Effect |
| --- | --- | --- |
| `set` | `{ type: 'set', path, value }` | Set a value (creating the leaf key/index) |
| `set` (node) | `{ type: 'set', path, node }` | Set using an already-constructed node |
| `delete` | `{ type: 'delete', path }` | Remove a mapping entry or sequence element |
| `rename` | `{ type: 'rename', path, to }` | Change a mapping key |
| `move` | `{ type: 'move', from, path }` | Move a subtree to a destination |
| `test` | `{ type: 'test', path, test }` | Assert a precondition |

A `set` may carry an inline `if` clause (`{ exists }`, `{ equals }`, or a
`{ match(node, doc) }` predicate); when it does not match the mutation is
recorded in `result.skipped` rather than failing. A standalone `test` that fails
is a blocking conflict.

## 2. Resolve conflicts before committing

If any operation is ambiguous or unsafe, `plan.ok` is `false` and
`plan.conflicts` describes each problem with a machine-readable `code`, a human
message, the responsible `operation` index, and a source `range`/`pos`. Nothing
is mutated.

```js
if (!plan.ok) {
  for (const c of plan.conflicts) {
    console.error(`${c.code} at ${c.pos?.line}:${c.pos?.col} — ${c.message}`)
  }
  // Adjust the input or the operations, then re-create the plan.
}
```

Conflicts are returned rather than silently resolved. The API never silently
picks among alternatives or expands an alias on your behalf. Conflict codes
include:

- `DUPLICATE_KEY` — the target mapping has repeated keys, making a plain key
  ambiguous.
- `MERGE_KEY` — the operation touches a mapping containing a YAML 1.1 `<<`
  merge key (or the merge key itself).
- `DELETE_ANCHOR_IN_USE` — deletion would remove an anchor that one or more
  aliases still reference.
- `MOVE_ANCHOR_BROKEN` — after the edits an alias no longer resolves to its
  anchor.
- `MOVE_INTO_SELF` — a node would be moved into itself or a descendant.
- `OVERLAPPING_OPERATION` — two structural edits (e.g. a delete and a move)
  target overlapping subtrees.
- `MISSING_TARGET`, `TYPE_MISMATCH`, `UNRESOLVED_ALIAS`, `TEST_FAILED` —
  resolution/assertion failures.
- `CREATE_NODE_FAILED`, `VISITOR_FAILED`, `STRINGIFY_FAILED` — a custom tag,
  your `visitor`, or the serializer threw.

For example, repeated keys and merge keys always require an explicit decision:

```js
const dup = parseDocument('name: a\nname: b\n', { keepSourceTokens: true })
const bad = createEditPlan(
  dup,
  [{ type: 'set', path: ['name'], value: 'c' }],
  { source: 'name: a\nname: b\n' }
)
bad.ok // false
bad.conflicts[0].code // 'DUPLICATE_KEY'
```

You may provide an optional `visitor`; it runs against the proposed (cloned)
document during analysis, so a validation error aborts the whole plan before any
commit.

## 3. Commit — apply atomically and preserve untouched bytes

When `plan.ok` is true, call `commit()`. All edits are first applied to an
internal clone, passed through the visitor, and fully stringified; only if that
entire trial succeeds is the result written back and the live `Document`
refreshed in place. If anything throws, the original `Document` is left
untouched and still stringifies to the original text.

```js
const result = plan.commit()
result.text // resulting YAML source
result.edits // resolved edits
result.skipped // indices of conditional sets whose `if` did not match

console.log(result.text)
// server:
//   host: localhost
//   port: 443
// features:
//   - https
//   - gzip
```

Untouched subtrees that carry a `srcToken` are kept **byte-for-byte**: the
editor splices replacements into the original source rather than re-emitting the
whole document. Narrow scalar/key changes replace only the value text; structural
changes (insert/delete/move) rewrite the smallest enclosing collection, and that
widening is reported in the edit's `rewrite.reason`.

### Stale plans and tamper detection

Plans capture a hash of the source at analysis time. Committing against changed
text (or reusing an already-committed plan) throws an `EditPlanError` with a
`STALE_PLAN` conflict:

```js
import { EditPlanError } from 'yaml/edit'

try {
  plan.commit(possiblyChangedSource)
} catch (err) {
  if (err instanceof EditPlanError && err.conflicts[0].code === 'STALE_PLAN') {
    // Re-parse and re-create the plan against the new source.
  }
}
```

`plan.verify(source)` performs the same check without committing.

### Byte preservation details

- Trailing comments, `commentBefore`, blank lines (`spaceBefore`) and the
  flow/block style of untouched nodes are retained.
- CRLF line endings in untouched regions are preserved; narrow edits keep the
  surrounding line endings.
- Anchors stay with their nodes during `set`/`move`; a move that would detach
  an anchor still referenced elsewhere is reported as `MOVE_ANCHOR_BROKEN`.
- When a change cannot be expressed as a narrow splice (for example inserting
  into a freshly created intermediate mapping, or replacing a scalar with a
  collection), the editor rewrites the nearest positioned ancestor and says so
  in `rewrite.reason`.

Always re-parse `result.text` if you need to continue working with the document;
the committed `Document` is refreshed automatically to match the new source.
