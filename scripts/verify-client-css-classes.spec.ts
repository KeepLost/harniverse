import { describe, expect, it } from 'vitest'
import {
  collectClassReferences,
  findClassViolations,
  findComposesViolations,
  parseCssModule,
} from './verify-client-css-classes.ts'
import type { CssModuleInfo } from './verify-client-css-classes.ts'

describe('parseCssModule', () => {
  it('declares every module-local class a selector names, however it is nested', () => {
    const info = parseCssModule(`
.plain { color: red; }
.grouped, .second:hover { color: red; }
.parent { & .nested { color: red; } }
@media (min-width: 600px) { .inMedia { color: red; } }
@supports (display: grid) { @media print { .deep { color: red; } } }
.row:not(.skipped) > .child { color: red; }
`)

    expect([...info.classes.keys()].sort()).toEqual(
      ['child', 'deep', 'grouped', 'inMedia', 'nested', 'parent', 'plain', 'row', 'second', 'skipped'],
    )
  })

  it('ignores classes in comments, strings, attribute values, and :global scopes', () => {
    const info = parseCssModule(`
/* .ghostComment { color: red; } */
.real::after { content: '.ghostString'; }
.attr[data-x='.ghostAttr'] { color: red; }
:global(.ghostGlobal) .local { color: red; }
.host :global(.ghostInner .ghostDeeper(x)) { color: red; }
`)

    expect([...info.classes.keys()].sort()).toEqual(['attr', 'host', 'local', 'real'])
  })

  it('records @keyframes names and does not read their stops as selectors', () => {
    const info = parseCssModule(`
@keyframes spin { from { transform: none; } to { transform: rotate(1turn); } }
@-webkit-keyframes pulse { 50% { opacity: 0.5; } }
@font-face { font-family: 'X'; src: url(x.woff2); }
.after { animation: spin 1s; }
`)

    expect([...info.keyframes].sort()).toEqual(['pulse', 'spin'])
    expect([...info.classes.keys()]).toEqual(['after'])
  })

  it('marks a class state-only when every selector qualifies it with a pseudo-state', () => {
    const info = parseCssModule(`
.hoverOnly:hover:not(:disabled) { color: red; }
.focusOnly:focus-visible, .focusOnly:active { color: red; }
.rested:hover { color: red; }
.rested { color: blue; }
.negated:not(:disabled) { color: red; }
.ancestorState:hover .descendant { color: red; }
.elementOnly::before { content: ''; }
.wrapper:is(.insideIs) { color: red; }
`)

    const standalone = (name: string): boolean | undefined => info.classes.get(name)?.standalone
    expect(standalone('hoverOnly')).toBe(false)
    expect(standalone('focusOnly')).toBe(false)
    expect(standalone('rested')).toBe(true)
    expect(standalone('negated')).toBe(true)
    expect(standalone('ancestorState')).toBe(false)
    expect(standalone('descendant')).toBe(true)
    expect(standalone('elementOnly')).toBe(true)
    expect(standalone('insideIs')).toBe(true)
  })

  it('locates composes declarations, with or without a closing semicolon', () => {
    const info = parseCssModule(`.base { color: red; }

.derived {
  composes: base;
  padding: 0;
}

.other { composes: base from './shared.module.css' }
`)

    expect(info.composes).toEqual([
      { line: 4, text: 'composes: base' },
      { line: 8, text: "composes: base from './shared.module.css'" },
    ])
    expect(findComposesViolations('a.module.css', info)).toEqual([
      { file: 'a.module.css', line: 4, kind: 'composes', subject: 'composes: base', stylesheet: 'a.module.css' },
      {
        file: 'a.module.css',
        line: 8,
        kind: 'composes',
        subject: "composes: base from './shared.module.css'",
        stylesheet: 'a.module.css',
      },
    ])
  })

  it('does not mistake a value or a custom property for composes', () => {
    const info = parseCssModule('.a { --composes: 1; transition: composes 1s; }')

    expect(info.composes).toEqual([])
  })
})

describe('collectClassReferences', () => {
  const FILE = 'packages/client/ui-x/src/client/Panel.tsx'

  it('reads dotted and literal-key lookups through the default-import binding', () => {
    const refs = collectClassReferences(FILE, `
import css from './Panel.module.css'
import other from '../shared/Other.module.css'
export const a = css.root
export const b = css['header']
export const c = css[\`footer\`]
export const d = other.item
`)

    expect(refs.map(ref => [ref.binding, ref.name, ref.line, ref.stylesheet])).toEqual([
      ['css', 'root', 4, 'packages/client/ui-x/src/client/Panel.module.css'],
      ['css', 'header', 5, 'packages/client/ui-x/src/client/Panel.module.css'],
      ['css', 'footer', 6, 'packages/client/ui-x/src/client/Panel.module.css'],
      ['other', 'item', 7, 'packages/client/ui-x/src/shared/Other.module.css'],
    ])
  })

  it('skips dynamic keys, other objects, side-effect imports, and comments', () => {
    const refs = collectClassReferences(FILE, `
import css from './Panel.module.css'
import './xterm-base.module.css'
import util from './util.ts'
// css.inComment
export const a = css[variant]
export const b = css[\`chip_\${state}\`]
export const c = util.root
export const d = other.root
export const e = 'css.inString'
`)

    expect(refs).toEqual([])
  })

  it('finds lookups inside JSX and template-literal spans', () => {
    const refs = collectClassReferences(FILE, `
import styles from './Panel.module.css'
export const View = () => (
  <div className={\`\${styles['iconButton']} \${styles.danger}\`}>
    <span className={clsx(styles.label, open && styles.open)} />
  </div>
)
`)

    expect(refs.map(ref => [ref.name, ref.line])).toEqual([
      ['iconButton', 4], ['danger', 4], ['label', 5], ['open', 5],
    ])
  })

  it('groups the lookups of a native element className made of module classes alone', () => {
    const refs = collectClassReferences(FILE, `
import css from './Panel.module.css'
export const View = () => (
  <>
    <button className={css.single} />
    <button className={\`\${css.a} \${css.b}\`} />
    <button className={clsx(css.c, css['d'])} />
    <Button className={css.component} />
    <button className={\`\${css.mixed} extra\`} />
    <button className={clsx(css.cond, on && css.other)} />
    <button className={css.plain + props.className} />
  </>
)
`)

    const group = (name: string): number | undefined => refs.find(ref => ref.name === name)?.group
    expect(group('single')).toBeTypeOf('number')
    expect(group('a')).toBe(group('b'))
    expect(group('c')).toBe(group('d'))
    expect(new Set([group('single'), group('a'), group('c')]).size).toBe(3)
    for (const name of ['component', 'mixed', 'cond', 'other', 'plain']) expect(group(name)).toBeUndefined()
  })
})

describe('findClassViolations', () => {
  const SHEET = 'packages/client/ui-x/src/client/Panel.module.css'
  const modules: Record<string, CssModuleInfo> = {
    [SHEET]: parseCssModule(`
.root { color: red; }
.danger:hover:not(:disabled) { color: red; }
.ghostHover:hover { color: red; }
@keyframes spin { to { transform: none; } }
`),
  }
  const lookup = (stylesheet: string): CssModuleInfo | undefined => modules[stylesheet]
  const check = (source: string) => findClassViolations(collectClassReferences('packages/client/ui-x/src/client/Panel.tsx', source), lookup)

  it('accepts declared classes and keyframe names', () => {
    expect(check(`
import css from './Panel.module.css'
export const a = [css.root, css.danger, css.spin]
`)).toEqual([])
  })

  it('reports a class the stylesheet never declares at its reference line', () => {
    expect(check(`
import css from './Panel.module.css'
export const a = css.root
export const b = css['deleteConfirmText']
`)).toEqual([
      { file: 'packages/client/ui-x/src/client/Panel.tsx', line: 4, kind: 'undefined-class', subject: 'deleteConfirmText', stylesheet: SHEET },
    ])
  })

  it('reports an absent stylesheet once per importing file', () => {
    const violations = findClassViolations(
      collectClassReferences('packages/client/ui-x/src/client/Panel.tsx', `
import css from './Gone.module.css'
export const a = css.one
export const b = css.two
`),
      lookup,
    )

    expect(violations).toEqual([
      {
        file: 'packages/client/ui-x/src/client/Panel.tsx',
        line: 3,
        kind: 'missing-stylesheet',
        subject: 'packages/client/ui-x/src/client/Gone.module.css',
        stylesheet: 'packages/client/ui-x/src/client/Gone.module.css',
      },
    ])
  })

  it('reports each distinct finding once when a line repeats a lookup', () => {
    expect(check(`
import css from './Panel.module.css'
export const a = [css.missing, css.missing]
`)).toHaveLength(1)
  })

  it('reports a native element carrying only state-only classes', () => {
    expect(check(`
import css from './Panel.module.css'
export const View = () => <button className={css.danger} />
`)).toEqual([
      { file: 'packages/client/ui-x/src/client/Panel.tsx', line: 3, kind: 'state-only', subject: 'danger', stylesheet: SHEET },
    ])
  })

  it('reports state-only classes together with an undeclared base', () => {
    const kinds = check(`
import css from './Panel.module.css'
export const View = () => <button className={\`\${css.iconButton} \${css.danger}\`} />
`).map(violation => [violation.kind, violation.subject])

    expect(kinds).toEqual([['undefined-class', 'iconButton'], ['state-only', 'danger']])
  })

  it('accepts a state-only modifier beside a base class that styles the resting state', () => {
    expect(check(`
import css from './Panel.module.css'
export const View = () => <button className={\`\${css.root} \${css.danger}\`} />
`)).toEqual([])
  })

  it('accepts a state-only modifier on a component or in a mixed class expression', () => {
    expect(check(`
import css from './Panel.module.css'
export const View = () => (
  <>
    <Button className={css.ghostHover} />
    <button className={clsx(css.ghostHover, props.className)} />
  </>
)
`)).toEqual([])
  })
})
