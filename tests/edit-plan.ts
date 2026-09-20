import {
  Scalar,
  createEditPlan,
  EditPlanConflictError,
  parse,
  parseDocument,
  stringify,
  visit,
  type Document
} from 'yaml'

function makePlan(src: string, edits: any[], options: any = {}) {
  const doc = parseDocument(src, {
    keepSourceTokens: true,
    ...options.parse
  })
  return {
    doc,
    plan: createEditPlan(doc, edits, { source: src, ...options.plan })
  }
}

function commit(src: string, edits: any[], options: any = {}) {
  const { doc, plan } = makePlan(src, edits, options)
  expect(plan.ok, plan.conflicts.map(String).join('; ')).toBe(true)
  const res = plan.commit()
  return { doc, res, text: res.text }
}

describe('edit plan: basic operations', () => {
  test('set map and seq values, byte-preserving', () => {
    const src = 'foo: bar\nlist:\n  - one\n  - two\nn:\n  a: 1\n'
    const { text, res } = commit(src, [
      { type: 'set', path: ['n', 'a'], value: 2 },
      { type: 'set', path: ['list', 1], value: 'TWO' }
    ])
    expect(parse(text)).toEqual({
      foo: 'bar',
      list: ['one', 'TWO'],
      n: { a: 2 }
    })
    // unchanged bytes
    expect(text.startsWith('foo: bar\nlist:\n  - one\n')).toBe(true)
    expect(res.replacedRanges.length).toBe(2)
  })

  test('delete and insert map keys', () => {
    const src = 'a: 1\nb: 2\nc: 3\n'
    const { text } = commit(src, [
      { type: 'delete', path: ['b'] },
      { type: 'set', path: ['d'], value: 4 }
    ])
    expect(text).toBe('a: 1\nc: 3\nd: 4\n')
  })

  test('rename key keeps value and comments', () => {
    const src = 'name: x # keep\n'
    const { text } = commit(src, [
      { type: 'renameKey', path: ['name'], newKey: 'label' }
    ])
    expect(text).toBe('label: x # keep\n')
    expect(parse(text)).toEqual({ label: 'x' })
  })

  test('set a missing leaf key', () => {
    const src = 'a: 1\n'
    const { text } = commit(src, [{ type: 'set', path: ['b'], value: 2 }])
    expect(text).toBe('a: 1\nb: 2\n')
  })

  test('append seq item', () => {
    const src = 's:\n  - 1\n  - 2\n'
    const { text } = commit(src, [{ type: 'set', path: ['s', 2], value: 3 }])
    expect(text).toBe('s:\n  - 1\n  - 2\n  - 3\n')
  })
})

test('nested and sibling edits compose without overlap', () => {
  const src =
    'service:\n  name: app\n  port: 8080\n  upstreams:\n    - port: 80\nfeatures:\n  cache: false\n'
  const { text } = commit(src, [
    { type: 'renameKey', path: ['service', 'port'], newKey: 'listen' },
    { type: 'set', path: ['service', 'upstreams', 0, 'port'], value: 8080 },
    { type: 'set', path: ['features', 'cache'], value: true }
  ])
  expect(parseDocument(text).toJS()).toEqual({
    service: {
      name: 'app',
      listen: 8080,
      upstreams: [{ port: 8080 }]
    },
    features: { cache: true }
  })
  expect(text).toContain('  name: app\n')
})

describe('edit plan: flow collections', () => {
  test('flow map set and delete', () => {
    const src = 'm: { a: 1, b: 2, c: 3 }\n'
    const { text } = commit(src, [
      { type: 'set', path: ['m', 'b'], value: 22 },
      { type: 'delete', path: ['m', 'c'] }
    ])
    expect(text).toBe('m: { a: 1, b: 22 }\n')
  })

  test('multiline flow map', () => {
    const src = 'm: {\n  a: 1,\n  b: 2\n}\n'
    const { text } = commit(src, [
      { type: 'set', path: ['m', 'a'], value: 11 },
      { type: 'set', path: ['m', 'c'], value: 3 }
    ])
    expect(parse(text)).toEqual({ m: { a: 11, b: 2, c: 3 } })
    expect(text).toContain('a: 11')
    expect(text).toContain('c: 3')
  })

  test('flow seq reordering via move', () => {
    const src = 's: [a, b, c]\n'
    const { text } = commit(src, [
      { type: 'move', from: ['s', 0], to: ['s', 2] }
    ])
    expect(text).toBe('s: [ b, c, a ]\n')
    expect(parse(text)).toEqual({ s: ['b', 'c', 'a'] })
  })

  test('mixed flow/block untouched subtrees kept byte-for-byte', () => {
    const src =
      'a:\n  inner: { x: 1, y: 2 }\n  other:\n    - 1\n    - 2\nb: end\n'
    const { text } = commit(src, [{ type: 'set', path: ['b'], value: 'END' }])
    expect(text.startsWith('a:\n  inner: { x: 1, y: 2 }\n  other:')).toBe(true)
    expect(text.endsWith('b: END\n')).toBe(true)
  })
})

describe('edit plan: anchors and aliases', () => {
  test('setting a value inside an anchored map keeps the alias', () => {
    const src = 'base: &x\n  k: 1\nref: *x\n'
    const { text } = commit(src, [
      { type: 'set', path: ['base', 'k'], value: 2 }
    ])
    expect(text).toContain('&x')
    expect(text).toContain('*x')
    const reparsed = parseDocument(text)
    expect(reparsed.errors).toHaveLength(0)
    const base = reparsed.get('base') as any
    const ref = (reparsed.get('ref') as any).resolve(reparsed)
    expect(ref).toBe(base)
    expect(base.toJS()).toEqual({ k: 2 })
  })

  test('deleting an anchored node referenced elsewhere is a conflict', () => {
    const src = 'a: &x 1\nb: *x\n'
    const { plan } = makePlan(src, [{ type: 'delete', path: ['a'] }])
    expect(plan.ok).toBe(false)
    expect(plan.conflicts[0].code).toBe('ALIAS_TO_DELETED_ANCHOR')
    expect(plan.conflicts[0].anchor).toBe('x')
    expect(plan.conflicts[0].range).toEqual([11, 13, 14])
    // original document still outputs the original text
    expect(stringify(plan.doc)).toBe(src)
  })

  test('moving an anchor after an alias is a conflict', () => {
    const src = 'ref: *x\nbase: &x\n  k: 1\n'
    const { plan } = makePlan(src, [
      { type: 'move', from: ['base'], to: ['later'] }
    ])
    expect(plan.ok).toBe(false)
    expect(plan.conflicts.some(c => c.code === 'ANCHOR_ORDER')).toBe(true)
  })

  test('plan items record anchor impacts', () => {
    const src = 'a: &x 1\nb: *x\n'
    const { plan } = makePlan(src, [{ type: 'set', path: ['a'], value: 2 }])
    expect(plan.items[0].anchorImpacts.some(i => i.anchor === 'x')).toBe(true)
  })
})

describe('edit plan: merge keys', () => {
  test('direct merge-key edits are conflicts', () => {
    const src = 'base: &b\n  x: 1\nm:\n  <<: *b\n  y: 2\n'
    const { plan } = makePlan(src, [{ type: 'delete', path: ['m', '<<'] }], {
      parse: { version: '1.1' }
    })
    expect(plan.conflicts.some(c => c.code === 'MERGE_KEY')).toBe(true)
  })

  test('editing a map containing a merge key adds a diagnostic', () => {
    const src = 'base: &b\n  x: 1\nm:\n  <<: *b\n  y: 2\n'
    const { plan } = makePlan(
      src,
      [{ type: 'set', path: ['m', 'y'], value: 9 }],
      { parse: { version: '1.1' } }
    )
    expect(plan.ok).toBe(true)
    expect(
      plan.items[0].diagnostics.some(d => d.message.includes('merge'))
    ).toBe(true)
  })
})

describe('edit plan: duplicate keys', () => {
  test('ambiguous duplicate key is a locatable conflict with candidates', () => {
    const src = 'k: 1\nk: 2\nx: 3\n'
    const { plan } = makePlan(src, [{ type: 'set', path: ['k'], value: 9 }])
    expect(plan.ok).toBe(false)
    const c = plan.conflicts.find(c => c.code === 'DUPLICATE_KEY')!
    expect(c.candidates).toHaveLength(2)
    expect(c.candidates![0].current).toBe(true)
    expect(c.candidates![1].current).toBe(false)
  })

  test('explicit occurrence selects a candidate', () => {
    const src = 'k: 1\nk: 2\nx: 3\n'
    const { text } = commit(src, [
      { type: 'set', path: [{ key: 'k', occurrence: 1 }], value: 9 }
    ])
    expect(text).toBe('k: 1\nk: 9\nx: 3\n')
    // the targeted occurrence is the one updated; document still warns
    const reparsed = parseDocument(text, { logLevel: 'silent' })
    expect(reparsed.get('k') as any).toMatchObject({ value: 9 })
  })
})

describe('edit plan: comments and whitespace', () => {
  test('commentBefore/spaceBefore and unrelated comments preserved', () => {
    const src = [
      '# header',
      'foo: bar',
      'baz:',
      '  - a',
      '  # mid comment',
      '  - b',
      'tail: v',
      ''
    ].join('\n')
    const { text } = commit(src, [
      { type: 'set', path: ['baz', 1], value: 'B' }
    ])
    expect(text).toContain('# header')
    expect(text).toContain('# mid comment')
    expect(text).toContain('tail: v')
  })

  test('CRLF line endings preserved in untouched regions', () => {
    const src = 'a: 1\r\nb: 2\r\nc: 3\r\n'
    const { text } = commit(src, [{ type: 'set', path: ['b'], value: 22 }])
    expect(text).toBe('a: 1\r\nb: 22\r\nc: 3\r\n')
  })
})

describe('edit plan: custom tags and failures', () => {
  test('createNode failure leaves the document unchanged', () => {
    const src = 'a: 1\n'
    const doc = parseDocument(src, {
      keepSourceTokens: true,
      customTags: [
        {
          tag: '!boom',
          identify: (v: unknown) =>
            typeof v === 'object' && v !== null && (v as any).$boom === true,
          createNode: () => {
            throw new Error('boom: cannot create node')
          },
          resolve: () => null,
          stringify: () => ''
        } as any
      ]
    })
    const p = createEditPlan(
      doc,
      [{ type: 'set', path: ['a'], value: { $boom: true } }],
      { source: src }
    )
    const before = stringify(doc)
    expect(() => p.commit()).toThrow(EditPlanConflictError)
    expect(stringify(doc)).toBe(before)
  })

  test('custom tag value is created and rendered', () => {
    const customTag = {
      tag: '!tag',
      identify: (v: unknown) =>
        typeof v === 'object' && v !== null && (v as any).$custom === true,
      createNode: () => Object.assign(new Scalar('CUSTOM'), { tag: '!tag' }),
      resolve: () => new Scalar('CUSTOM'),
      stringify: (item: { value: string }) => item.value ?? 'CUSTOM'
    }
    const src = 'a: 1\n'
    const doc = parseDocument(src, {
      keepSourceTokens: true,
      customTags: [customTag as any]
    })
    const p = createEditPlan(
      doc,
      [{ type: 'set', path: ['a'], value: { $custom: true } }],
      { source: src }
    )
    const res = p.commit()
    expect(res.text).toContain('!tag CUSTOM')
  })
})

describe('edit plan: conditions and overlaps', () => {
  test('failing test is a conflict', () => {
    const src = 'v: 5\n'
    const { plan } = makePlan(src, [
      { type: 'set', path: ['v'], value: 10, test: (n: any) => n.value === 99 }
    ])
    expect(plan.conflicts[0].code).toBe('CONDITION_FAILED')
  })

  test('overlapping move/delete is a conflict', () => {
    const src = 'a:\n  x: 1\nb: 2\n'
    const { plan } = makePlan(src, [
      { type: 'move', from: ['a', 'x'], to: ['y'] },
      { type: 'delete', path: ['a'] }
    ])
    expect(plan.conflicts.some(c => c.code === 'OVERLAPPING_OPERATIONS')).toBe(
      true
    )
  })
})

describe('edit plan: snapshot verification', () => {
  test('tampering with the prefix rejects the old plan', () => {
    const src = 'a: 1\nb: 2\n'
    const doc = parseDocument(src, { keepSourceTokens: true })
    const p = createEditPlan(doc, [{ type: 'set', path: ['b'], value: 22 }], {
      source: src
    })
    expect(p.ok).toBe(true)
    // Simulate the file being changed on disk before commit: plan is stale.
    ;(p as unknown as { options: { source: string } }).options.source =
      'prefix inserted\na: 1\nb: 2\n'
    let err: EditPlanConflictError | undefined
    try {
      p.commit()
    } catch (e) {
      err = e as EditPlanConflictError
    }
    expect(err).toBeInstanceOf(EditPlanConflictError)
    expect(err!.conflicts[0].code).toBe('STALE_PLAN')
  })

  test('seq indices do not drift between operations', () => {
    const src = 's:\n  - a\n  - b\n  - c\n'
    const { text } = commit(src, [
      { type: 'delete', path: ['s', 0] },
      { type: 'set', path: ['s', 1], value: 'B' }
    ])
    // second edit addresses the *original* index 1 -> b
    expect(parse(text)).toEqual({ s: ['B', 'c'] })
    void 0
  })
})

describe('edit plan: round-trip references and byte coverage', () => {
  test('reparsed document shares anchor identity', () => {
    const src = 'list:\n  - &item\n    v: 1\nref: *item\n'
    const { text } = commit(src, [
      { type: 'set', path: ['list', 0, 'v'], value: 2 }
    ])
    const doc2 = parseDocument(text)
    expect(doc2.errors).toHaveLength(0)
    const list = doc2.get('list') as any
    expect((doc2.get('ref') as any).resolve(doc2)).toBe(list[0])
  })

  test('untouched span bytes are identical', () => {
    const src = 'a:\n  x: 1\n  y: 2\nb: keep me\n'
    const { res, text } = commit(src, [
      { type: 'set', path: ['b'], value: 'changed' }
    ])
    // All bytes outside the replaced ranges must come from the source.
    const outside = (t: string) =>
      res.replacedRanges
        .slice()
        .sort((a, b) => b.range[0] - a.range[0])
        .reduce((acc, r) => acc.slice(0, r.range[0]) + acc.slice(r.range[1]), t)
    expect(outside(text)).toBe(outside(src))
    expect(text).toContain('b: changed')
  })

  test('no source option falls back to a full stringify', () => {
    const doc = parseDocument('a: 1\nb: 2\n', { keepSourceTokens: true })
    const p = createEditPlan(doc, [{ type: 'set', path: ['b'], value: 22 }])
    const res = p.commit()
    expect(res.text).toBe('a: 1\nb: 22\n')
    expect(res.replacedRanges[0].reason).toContain('full document')
  })
})

test('Document has the opt-in createEditPlan method', () => {
  const doc = parseDocument('a: 1\n') as Document
  const p = doc.createEditPlan([{ type: 'set', path: ['a'], value: 2 }], {
    source: 'a: 1\n'
  })
  expect(p.commit().text).toBe('a: 2\n')
  // direct mutation API semantics unchanged
  const d2 = parseDocument('a: 1\n')
  d2.set('a', 9)
  expect((d2.get('a') as any).value).toBe(9)
  void visit
})
