import type { Document, DocValue } from '../doc/Document.ts'
import type { Node } from '../nodes/types.ts'
import { Pair } from '../nodes/Pair.ts'
import { YAMLMap } from '../nodes/YAMLMap.ts'
import type { YAMLSeq } from '../nodes/YAMLSeq.ts'
import type { ToStringOptions } from '../options.ts'
import {
  createStringifyContext,
  stringify as stringifyNode,
  type StringifyContext
} from '../stringify/stringify.ts'
import { stringifyPair } from '../stringify/stringifyPair.ts'

export interface RegionStyle {
  indent: string
  inFlow: boolean
}

export function makeContext(
  doc: Document<DocValue>,
  options: ToStringOptions | undefined,
  indent: string,
  inFlow: boolean
): StringifyContext {
  const ctx = createStringifyContext(doc, options)
  ctx.indent = indent
  ctx.inFlow = inFlow
  return ctx
}

function leadingColumn(src: string, offset: number): number {
  const lineStart = src.lastIndexOf('\n', offset - 1) + 1
  return offset - lineStart
}

/**
 * Leading whitespace of the line on which `offset` sits.
 * Uses source tokens (spaces before the node) when possible, else the
 * character column.
 */
export function lineIndent(src: string, offset: number): string {
  return ' '.repeat(leadingColumn(src, offset))
}

/**
 * The indent string a value needs when rendered as the value of a map pair
 * whose key starts at `keyOffset` with `keyIndent` spaces of indentation.
 */
function blockValueIndent(step: string, keyIndent: string): string {
  return keyIndent + step
}

/** Style/indentation for rendering a replacement value inside `parent`. */
export function valueStyle(
  src: string,
  _doc: Document<DocValue>,
  parent: YAMLMap | YAMLSeq,
  holder: { key?: Node; range?: [number, number, number] },
  options?: ToStringOptions
): RegionStyle {
  const step =
    typeof options?.indent === 'number' ? ' '.repeat(options.indent) : '  '

  if (parent instanceof YAMLMap) {
    const pairKey = holder.key
    const keyOff = pairKey?.range?.[0] ?? parent.range?.[0] ?? 0
    const keyIndent = lineIndent(src, keyOff)
    if (parent.flow) return { indent: '', inFlow: true }
    return { indent: blockValueIndent(step, keyIndent), inFlow: false }
  }

  // Block sequence: element renders at the dash column.
  if (parent.flow) return { indent: '', inFlow: true }
  const nodeOff = holder.range?.[0] ?? parent.range?.[0] ?? 0
  const ind = lineIndent(src, nodeOff)
  return { indent: ind, inFlow: false }
}

/** Indentation at which a new child pair of a block map should be rendered. */
export function mapChildIndent(
  src: string,
  map: YAMLMap,
  options?: ToStringOptions
): string {
  if (map.flow) return ''
  const step =
    typeof options?.indent === 'number' ? ' '.repeat(options.indent) : '  '
  const off = map.range?.[0] ?? 0
  // A map used as a block seq value starts at its first `-`; children are
  // indented one additional step.
  return lineIndent(src, off) + step
}

export function renderValue(
  doc: Document<DocValue>,
  node: Node,
  style: RegionStyle,
  options?: ToStringOptions
): string {
  const ctx = makeContext(doc, options, style.indent, style.inFlow)
  return stringifyNode(node, ctx)
}

export function renderPair(
  doc: Document<DocValue>,
  pair: Pair,
  indent: string,
  inFlow: boolean,
  options?: ToStringOptions
): string {
  const ctx = makeContext(doc, options, indent, inFlow)
  return stringifyPair(pair, ctx)
}

/** Render a block-sequence element including its `- ` marker. */
export function renderSeqItem(
  doc: Document<DocValue>,
  node: Node,
  indent: string,
  options?: ToStringOptions
): string {
  const ctx = makeContext(doc, options, indent, false)
  if (node instanceof Pair) return `- ${stringifyPair(node, ctx)}`
  const body = stringifyNode(node, ctx)
  return body === '' ? '-' : `- ${body}`
}

/** Render an element of a flow collection (no leading/trailing comma). */
export function renderFlowItem(
  doc: Document<DocValue>,
  node: Node | Pair,
  options?: ToStringOptions
): string {
  const ctx = makeContext(doc, options, '', true)
  if (node instanceof Pair) return stringifyPair(node, ctx)
  return stringifyNode(node, ctx)
}
