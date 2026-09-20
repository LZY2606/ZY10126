import { Document, parseDocument, Scalar } from 'yaml'
import { createEditPlan, EditPlanError } from 'yaml/edit'

function make(source: string, options: Record<string, unknown> = {}) {
  return parseDocument(source, { keepSourceTokens: true, ...options })
}

function commit(
  source: string,
  ops: Parameters<typeof createEditPlan>[1],
  parseOptions: Record<string, unknown> = {},
  planOptions: Parameters<typeof createEditPlan>[2] = {}
) {
  const doc = make(source, parseOptions)
  const plan = createEditPlan(doc, ops, { source, ...planOptions })
  if (!plan.ok) throw new EditPlanError(plan.conflicts)
  return { doc, result: plan.commit(source), plan }
}

describe('edit plans: basic set', () => {
  test('narrow scalar set preserves surrounding bytes', () => {
    const source = 'a: one # keep\nb: untouched\n'
    const { result } = commit(source, [
      { type: 'set', path: ['a'], value: 'ONE' }
    ])
    expect(result.text).toBe('a: ONE # keep\nb: untouched\n')
    expect(result.edits[0].rewrite.reason).toBeTruthy()
  })

  test('set nested scalar value', () => {
    const source = 'b:\n  c: two\n  d: keep\n'
    const { result } = commit(source, [
      { type: 'set', path: ['b', 'c'], value: 22 }
    ])
    expect(result.text).toBe('b:\n  c: 22\n  d: keep\n')
  })

  test('set updates JS semantics', () => {
    const { result, doc } = commit('a: 1\n', [
      { type: 'set', path: ['a'], value: 42 }
    ])
    expect(doc.toJS()).toEqual({ a: 42 })
    const reparsed = parseDocument(result.text)
    expect(reparsed.toJS()).toEqual({ a: 42 })
  })

  test('insert a new map key', () => {
    const source = 'a: 1\nb: 2\n'
    const { result } = commit(source, [{ type: 'set', path: ['c'], value: 3 }])
    expect(result.text).toBe('a: 1\nb: 2\nc: 3\n')
  })

  test('insert into nested map preserves indentation', () => {
    const source = 'outer:\n  inner:\n    x: 1\n'
    const { result } = commit(source, [
      { type: 'set', path: ['outer', 'inner', 'y'], value: 2 }
    ])
    expect(result.text).toBe('outer:\n  inner:\n    x: 1\n    y: 2\n')
  })

  test('set scalar to collection rewrites entry', () => {
    const source = 'a: 1\nb: keep\n'
    const { result } = commit(source, [
      { type: 'set', path: ['a'], value: { nested: [1, 2] } }
    ])
    expect(result.text).toBe('a:\n  nested:\n    - 1\n    - 2\nb: keep\n')
  })

  test('set missing intermediate path fails without createMissing', () => {
    const doc = make('a: 1\n')
    const plan = createEditPlan(
      doc,
      [{ type: 'set', path: ['x', 'y'], value: 1 }],
      { source: 'a: 1\n' }
    )
    expect(plan.ok).toBe(false)
    expect(plan.conflicts[0].code).toBe('MISSING_TARGET')
  })

  test('set with createMissing builds intermediate maps', () => {
    const { result } = commit(
      'a: 1\n',
      [{ type: 'set', path: ['x', 'y'], value: 1 }],
      {},
      { createMissing: true }
    )
    expect(parseDocument(result.text).toJS()).toEqual({ a: 1, x: { y: 1 } })
  })
})

describe('edit plans: delete / rename / move', () => {
  test('delete a block map entry', () => {
    const { result } = commit('a: 1\nb: 2\nc: 3\n', [
      { type: 'delete', path: ['b'] }
    ])
    expect(result.text).toBe('a: 1\nc: 3\n')
  })

  test('delete a sequence element', () => {
    const { result } = commit('list:\n  - a\n  - b\n  - c\n', [
      { type: 'delete', path: ['list', { kind: 'seq', index: 0 }] }
    ])
    expect(result.text).toBe('list:\n  - b\n  - c\n')
    expect(parseDocument(result.text).toJS()).toEqual({ list: ['b', 'c'] })
  })

  test('rename a key', () => {
    const { result } = commit('alpha: 1\nbeta: 2\n', [
      { type: 'rename', path: ['alpha'], to: 'ALPHA' }
    ])
    expect(result.text).toBe('ALPHA: 1\nbeta: 2\n')
    expect(parseDocument(result.text).toJS()).toEqual({ ALPHA: 1, beta: 2 })
  })

  test('move a subtree between maps', () => {
    const source = 'a:\n  x: 1\nb:\n  y: 2\n'
    const { result } = commit(source, [
      { type: 'move', from: ['a', 'x'], path: ['b', 'z'] }
    ])
    expect(result.text).toBe('a:\n  {}\nb:\n  y: 2\n  z: 1\n')
    expect(parseDocument(result.text).toJS()).toEqual({
      a: {},
      b: { y: 2, z: 1 }
    })
  })

  test('moving into self is a conflict', () => {
    const doc = make('a:\n  x: 1\n')
    const plan = createEditPlan(
      doc,
      [{ type: 'move', from: ['a'], path: ['a', 'child'] }],
      { source: 'a:\n  x: 1\n' }
    )
    expect(plan.ok).toBe(false)
    expect(plan.conflicts[0].code).toBe('MOVE_INTO_SELF')
  })

  test('rename into existing key is a duplicate conflict', () => {
    const doc = make('a: 1\nb: 2\n')
    const plan = createEditPlan(
      doc,
      [{ type: 'rename', path: ['a'], to: 'b' }],
      { source: 'a: 1\nb: 2\n' }
    )
    expect(plan.ok).toBe(false)
    expect(plan.conflicts[0].code).toBe('DUPLICATE_KEY')
  })
})

describe('edit plans: flow/block & sequence', () => {
  test('edit flow sequence element', () => {
    const { result } = commit('a: [1, 2, 3]\nb: keep\n', [
      { type: 'set', path: ['a', { kind: 'seq', index: 1 }], value: 20 }
    ])
    expect(result.text).toBe('a: [1, 20, 3]\nb: keep\n')
  })

  test('delete flow map entry', () => {
    const { result } = commit('a: {x: 1, y: 2}\nb: keep\n', [
      { type: 'delete', path: ['a', 'x'] }
    ])
    expect(result.text).toBe('a: {y: 2}\nb: keep\n')
  })

  test('append to a block sequence', () => {
    const { result } = commit('a:\n  - 1\n  - 2\nb: keep\n', [
      { type: 'set', path: ['a', { kind: 'seq', index: 2 }], value: 3 }
    ])
    expect(result.text).toBe('a:\n  - 1\n  - 2\n  - 3\nb: keep\n')
  })

  test('replace an existing sequence element', () => {
    const { result } = commit('a:\n  - 1\n  - 2\n  - 3\n', [
      { type: 'set', path: ['a', { kind: 'seq', index: 1 }], value: 99 }
    ])
    expect(result.text).toBe('a:\n  - 1\n  - 99\n  - 3\n')
  })
})

describe('edit plans: anchors & aliases', () => {
  test('deleting an anchor in use is a locatable conflict', () => {
    const source = 'x: &a 1\ny: *a\n'
    const doc = make(source)
    const plan = createEditPlan(doc, [{ type: 'delete', path: ['x'] }], {
      source
    })
    expect(plan.ok).toBe(false)
    expect(plan.conflicts[0].code).toBe('DELETE_ANCHOR_IN_USE')
    expect(plan.conflicts[0].range).toBeTruthy()
    expect(plan.edits[0].anchors[0].anchor).toBe('a')
    expect(plan.edits[0].anchors[0].aliases).toHaveLength(1)
  })

  test('deleting an unused anchor is allowed', () => {
    const { result } = commit('x: &a 1\ny: 2\n', [
      { type: 'delete', path: ['x'] }
    ])
    expect(parseDocument(result.text).toJS()).toEqual({ y: 2 })
  })

  test('moving an anchored subtree keeps alias resolution', () => {
    const source = 'a:\n  x: &v 1\nb:\n  y: 2\nref: *v\n'
    const { result } = commit(source, [
      { type: 'move', from: ['a', 'x'], path: ['b', 'z'] }
    ])
    const reparsed = parseDocument(result.text)
    expect(reparsed.toJS()).toEqual({
      a: {},
      b: { y: 2, z: 1 },
      ref: 1
    })
    // anchor &v should still be declared and referenced exactly once
    const anchors = result.text.match(/&v/g) ?? []
    const aliases = result.text.match(/\*v/g) ?? []
    expect(anchors).toHaveLength(1)
    expect(aliases).toHaveLength(1)
  })

  test('alias reference relationships survive an unrelated edit', () => {
    const source = 'x: &a\n  p: 1\ny: *a\nz: untouched\n'
    const { result } = commit(source, [{ type: 'set', path: ['z'], value: 9 }])
    const reparsed = parseDocument(result.text)
    expect(reparsed.toJS()).toEqual({ x: { p: 1 }, y: { p: 1 }, z: 9 })
    expect(result.text).toContain('*a')
    expect(result.text).toContain('&a')
  })
})

describe('edit plans: duplicate keys', () => {
  test('operating on a duplicate-key map is a conflict by default', () => {
    const source = 'a: 1\na: 2\nb: 3\n'
    const doc = make(source)
    const plan = createEditPlan(doc, [{ type: 'delete', path: ['a'] }], {
      source
    })
    expect(plan.ok).toBe(false)
    expect(plan.conflicts[0].code).toBe('DUPLICATE_KEY')
    expect(plan.conflicts[0].range).toBeTruthy()
  })

  test('setting into a duplicate-key map is a conflict', () => {
    const source = 'a: 1\na: 2\n'
    const doc = make(source)
    const plan = createEditPlan(doc, [{ type: 'set', path: ['a'], value: 9 }], {
      source
    })
    expect(plan.ok).toBe(false)
    expect(plan.conflicts[0].code).toBe('DUPLICATE_KEY')
  })

  test('unrelated duplicate elsewhere does not block a clean edit', () => {
    const source = 'dup: 1\ndup: 2\nother:\n  k: v\n'
    const { result } = commit(source, [
      { type: 'set', path: ['other', 'k'], value: 'w' }
    ])
    expect(result.text).toContain('k: w')
  })
})

describe('edit plans: merge keys (YAML 1.1)', () => {
  const source = 'base: &b\n  x: 1\nchild:\n  <<: *b\n  zeta: 2\n'
  const opts = { version: '1.1' as const }

  test('deleting in a map with << is a merge conflict', () => {
    const doc = make(source, opts)
    const plan = createEditPlan(
      doc,
      [{ type: 'delete', path: ['child', 'zeta'] }],
      { source }
    )
    expect(plan.ok).toBe(false)
    expect(plan.conflicts[0].code).toBe('MERGE_KEY')
  })

  test('adding a new key near << is allowed', () => {
    const { result } = commit(
      source,
      [{ type: 'set', path: ['child', 'new'], value: 3 }],
      opts
    )
    expect(result.text).toContain('  new: 3')
    expect(parseDocument(result.text, opts).toJS()).toMatchObject({
      child: { x: 1, zeta: 2, new: 3 }
    })
  })

  test('overwriting within a << map is a merge conflict', () => {
    const doc = make(source, opts)
    const plan = createEditPlan(
      doc,
      [{ type: 'set', path: ['child', 'zeta'], value: 9 }],
      { source }
    )
    expect(plan.ok).toBe(false)
    expect(plan.conflicts[0].code).toBe('MERGE_KEY')
  })
})

describe('edit plans: conditions (test)', () => {
  test('a passing test permits the mutation', () => {
    const { result } = commit('a: 1\n', [
      { type: 'test', path: ['a'], test: { equals: 1 } },
      { type: 'set', path: ['a'], value: 2 }
    ])
    expect(result.text).toBe('a: 2\n')
  })

  test('a failing test is a blocking conflict and leaves the doc intact', () => {
    const source = 'a: 1\n'
    const doc = make(source)
    const plan = createEditPlan(
      doc,
      [{ type: 'test', path: ['a'], test: { equals: 5 } }],
      { source }
    )
    expect(plan.ok).toBe(false)
    expect(plan.conflicts[0].code).toBe('TEST_FAILED')
    expect(doc.toString()).toBe(source)
  })

  test('inline if skips the mutation when the test fails', () => {
    const source = 'a: 1\n'
    const { result } = commit(source, [
      { type: 'set', path: ['a'], value: 2, if: { equals: 5 } }
    ])
    expect(result.skipped).toEqual([0])
    expect(result.text).toBe(source)
  })

  test('inline if applies when the test passes', () => {
    const { result } = commit('a: 1\n', [
      { type: 'set', path: ['a'], value: 2, if: { equals: 1 } }
    ])
    expect(result.skipped).toEqual([])
    expect(result.text).toBe('a: 2\n')
  })

  test('exists and match clauses work', () => {
    const { result } = commit('a:\n  x: 1\n', [
      { type: 'test', path: ['a'], test: { exists: true } },
      {
        type: 'set',
        path: ['a', 'x'],
        value: 2,
        if: { match: node => node instanceof Scalar && node.value === 1 }
      }
    ])
    expect(result.text).toContain('x: 2')
  })
})

describe('edit plans: CRLF', () => {
  test('narrow scalar set keeps CRLF', () => {
    const source = 'a: 1\r\nb: 2\r\n'
    const { result } = commit(source, [{ type: 'set', path: ['b'], value: 20 }])
    expect(result.text).toBe('a: 1\r\nb: 20\r\n')
    expect(result.text).not.toMatch(/(?<!\r)\n/)
  })

  test('delete keeps CRLF elsewhere', () => {
    const source = 'a: 1\r\nb: 2\r\nc: 3\r\n'
    const { result } = commit(source, [{ type: 'delete', path: ['b'] }])
    expect(result.text).toBe('a: 1\r\nc: 3\r\n')
  })
})

describe('edit plans: byte preservation', () => {
  test('untouched subtrees are byte-identical', () => {
    const source =
      'header: keep # c1\n' +
      'big:\n' +
      '  block: |\n' +
      '    line one\n' +
      '    line two\n' +
      '  quoted: "hello"\n' +
      'edit: me\n'
    const { result } = commit(source, [
      { type: 'set', path: ['edit'], value: 'you' }
    ])
    expect(result.text.slice(0, source.indexOf('edit:'))).toBe(
      source.slice(0, source.indexOf('edit:'))
    )
  })

  test('commentBefore/spaceBefore on untouched nodes survive', () => {
    const source = '# top\n\n\na: 1 # trailing\nb:\n  # before c\n  c: 2\n'
    const { result } = commit(source, [{ type: 'set', path: ['a'], value: 10 }])
    expect(result.text).toBe(
      '# top\n\n\na: 10 # trailing\nb:\n  # before c\n  c: 2\n'
    )
  })

  test('flow style of an untouched sibling collection is retained', () => {
    const source = 'a: {x: 1}\nb: [1, 2, 3]\nc: edit\n'
    const { result } = commit(source, [
      { type: 'set', path: ['c'], value: 'done' }
    ])
    expect(result.text).toBe('a: {x: 1}\nb: [1, 2, 3]\nc: done\n')
  })

  test('the rewrite reason is documented for widened edits', () => {
    const source = 'a:\n  - 1\n  - 2\n'
    const doc = make(source)
    const plan = createEditPlan(
      doc,
      [{ type: 'set', path: ['a'], value: { now: 'map' } }],
      { source }
    )
    expect(plan.edits[0].rewrite.reason).toBeTruthy()
  })
})

describe('edit plans: custom tags', () => {
  const customTags = [
    {
      tag: '!point',
      identify: (v: unknown) =>
        v && typeof v === 'object' && Array.isArray((v as { p?: unknown }).p),
      resolve: (str: string) => ({ p: str.split(',').map(Number) }),
      stringify: (item: { value?: { p: number[] }; p?: number[] }) => {
        const v = item.value ?? item
        return '!point ' + (v.p ?? []).join(',')
      }
    }
  ]

  test('a tagged value is preserved for an unrelated edit', () => {
    const source = 'p: !point 1,2\nother: x\n'
    const { result } = commit(
      source,
      [{ type: 'set', path: ['other'], value: 'y' }],
      { customTags }
    )
    expect(result.text).toContain('!point 1,2')
    expect(result.text).toContain('other: y')
  })

  test('a failing custom tag createNode aborts and keeps the document intact', () => {
    const source = 'a: 1\n'
    const doc = make(source, {
      customTags: [
        {
          tag: '!boom',
          identify: (v: unknown) =>
            !!v && typeof v === 'object' && (v as { __b?: boolean }).__b,
          resolve: (v: unknown) => v,
          createNode: () => {
            throw new Error('createNode exploded')
          },
          stringify: () => 'x'
        }
      ]
    })
    const plan = createEditPlan(
      doc,
      [{ type: 'set', path: ['a'], value: { __b: true } }],
      { source }
    )
    expect(plan.ok).toBe(false)
    expect(plan.conflicts[0].code).toBe('CREATE_NODE_FAILED')
    expect(doc.toString()).toBe(source)
  })
})

describe('edit plans: stale plan / tamper detection', () => {
  test('commit rejects a plan when the source text changed', () => {
    const source = 'a: 1\nb: 2\n'
    const doc = make(source)
    const plan = createEditPlan(
      doc,
      [{ type: 'set', path: ['b'], value: 20 }],
      { source }
    )
    const tampered = 'a: 99\nb: 2\n'
    expect(() => plan.commit(tampered)).toThrow(EditPlanError)
    try {
      plan.commit(tampered)
    } catch (err) {
      expect((err as EditPlanError).conflicts[0].code).toBe('STALE_PLAN')
    }
  })

  test('tampering with prefix text invalidates the plan hash', () => {
    const source = 'a: 1\nb: 2\n'
    const doc = make(source)
    const plan = createEditPlan(
      doc,
      [{ type: 'set', path: ['b'], value: 20 }],
      { source }
    )
    const tampered = 'a: 1\nb: 2\n\n# injected comment\n'
    expect(() => plan.commit(tampered)).toThrow(EditPlanError)
  })

  test('verify() reports the snapshot state', () => {
    const source = 'a: 1\n'
    const doc = make(source)
    const plan = createEditPlan(doc, [{ type: 'set', path: ['a'], value: 2 }], {
      source
    })
    expect(plan.verify(source)).toBe(true)
    expect(plan.verify('a: 5\n')).toBe(false)
  })

  test('a committed plan cannot be reused', () => {
    const source = 'a: 1\n'
    const doc = make(source)
    const plan = createEditPlan(doc, [{ type: 'set', path: ['a'], value: 2 }], {
      source
    })
    plan.commit()
    expect(plan.verify(source)).toBe(false)
    expect(() => plan.commit()).toThrow(EditPlanError)
  })
})

describe('edit plans: multiple operations against one snapshot', () => {
  test('later paths do not drift when an earlier op deletes a seq item', () => {
    const source = 'list:\n  - a\n  - b\n  - c\n'
    const { result } = commit(source, [
      { type: 'delete', path: ['list', { kind: 'seq', index: 0 }] },
      { type: 'set', path: ['list', { kind: 'seq', index: 1 }], value: 'B-new' }
    ])
    // index 1 resolved on the original snapshot is 'b', not 'c'
    expect(result.text).toBe('list:\n  - b\n  - B-new\n')
    expect(parseDocument(result.text).toJS()).toEqual({
      list: ['b', 'B-new']
    })
  })

  test('multiple disjoint scalar edits are applied together', () => {
    const source = 'a: 1\nb: 2\nc: 3\n'
    const { result } = commit(source, [
      { type: 'set', path: ['a'], value: 10 },
      { type: 'set', path: ['c'], value: 30 }
    ])
    expect(result.text).toBe('a: 10\nb: 2\nc: 30\n')
  })

  test('overlapping delete and move are reported as one conflict', () => {
    const source = 'a:\n  x: 1\n  y: 2\nb: 3\n'
    const doc = make(source)
    const plan = createEditPlan(
      doc,
      [
        { type: 'delete', path: ['a'] },
        { type: 'move', from: ['a', 'x'], path: ['b'] }
      ],
      { source }
    )
    expect(plan.ok).toBe(false)
    expect(plan.conflicts.map(c => c.code)).toContain('OVERLAPPING_OPERATION')
  })

  test('a failing visitor aborts all operations atomically', () => {
    const source = 'a: 1\nb: 2\n'
    const doc = make(source)
    const plan = createEditPlan(
      doc,
      [
        { type: 'set', path: ['a'], value: 10 },
        { type: 'set', path: ['b'], value: 20 }
      ],
      {
        source,
        visitor: () => {
          throw new Error('nope')
        }
      }
    )
    expect(plan.ok).toBe(false)
    expect(plan.conflicts[0].code).toBe('VISITOR_FAILED')
    expect(doc.toString()).toBe(source)
  })
})

describe('edit plans: diagnostics & metadata', () => {
  test('plan items record node, range, anchors and rewrite', () => {
    const source = 'x: &a 1\ny: *a\n'
    const doc = make(source)
    const plan = createEditPlan(doc, [{ type: 'delete', path: ['x'] }], {
      source
    })
    const edit = plan.edits[0]
    expect(edit.node).toBeInstanceOf(Scalar)
    expect(edit.range).toBeTruthy()
    expect(edit.anchors[0].anchor).toBe('a')
    expect(edit.rewrite.reason).toBeTruthy()
    expect(plan.conflicts[0].range).toBeTruthy()
  })

  test('path disambiguates numeric map keys from sequence indices', () => {
    const source = 'seq:\n  - 0\n  - 1\nmap:\n  0: zero\n  1: one\n'
    const { result } = commit(source, [
      // sequence element
      { type: 'set', path: ['seq', { kind: 'seq', index: 0 }], value: 'A' },
      // numeric map key
      { type: 'set', path: ['map', { kind: 'map', key: 0 }], value: 'ZERO' }
    ])
    expect(parseDocument(result.text).toJS()).toEqual({
      seq: ['A', 1],
      map: { 0: 'ZERO', 1: 'one' }
    })
  })

  test('existing Document methods are unchanged (direct mutation still works)', () => {
    const doc = new Document({ a: 1 })
    doc.set('a', 2)
    expect(doc.toJS()).toEqual({ a: 2 })
    expect(typeof createEditPlan).toBe('function')
  })
})
