/**
 * The hero's tool pill: a copy of the app's tool pill (apps/desktop/src/renderer/src/tools.ts TOOLS,
 * components/BoardControls.tsx). The icons are the app's lucide icons (lucide-react 1.61),
 * inlined as their SVG nodes so the site needs no icon package. The app shell
 * (components/AppShell.tsx) takes its other icons from here too: one copy of each.
 */
import type { ReactElement } from 'react'

export type ToolId = 'select' | 'hand' | 'rect' | 'ellipse' | 'arrow' | 'line' | 'pen' | 'text' | 'eraser'

type Node = ['path', { d: string }] | ['rect', Record<string, string>] | ['circle', Record<string, string>]

type ShellIcon = 'squarePen' | 'search' | 'folder' | 'chevronsUpDown' | 'chevronLeft' | 'chevronRight' | 'panelLeft' | 'undo' | 'redo' | 'ellipsis' | 'minus' | 'plus'

const ICONS: Record<ToolId | 'lock' | 'lockOpen' | ShellIcon, Node[]> = {
  lock: [
    ['rect', { width: '18', height: '11', x: '3', y: '11', rx: '2', ry: '2' }],
    ['path', { d: 'M7 11V7a5 5 0 0 1 10 0v4' }]
  ],
  lockOpen: [
    ['rect', { width: '18', height: '11', x: '3', y: '11', rx: '2', ry: '2' }],
    ['path', { d: 'M7 11V7a5 5 0 0 1 9.9-1' }]
  ],
  select: [['path', { d: 'M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z' }]],
  hand: [
    ['path', { d: 'M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2' }],
    ['path', { d: 'M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2' }],
    ['path', { d: 'M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8' }],
    ['path', { d: 'M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15' }]
  ],
  rect: [['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }]],
  ellipse: [['circle', { cx: '12', cy: '12', r: '10' }]],
  arrow: [
    ['path', { d: 'M13 5H19V11' }],
    ['path', { d: 'M19 5L5 19' }]
  ],
  line: [['path', { d: 'M22 2 2 22' }]],
  pen: [
    ['path', { d: 'M13 21h8' }],
    ['path', { d: 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z' }]
  ],
  text: [
    ['path', { d: 'M12 4v16' }],
    ['path', { d: 'M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2' }],
    ['path', { d: 'M9 20h6' }]
  ],
  eraser: [
    ['path', { d: 'M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21' }],
    ['path', { d: 'm5.082 11.09 8.828 8.828' }]
  ],
  // The app shell's icons (Sidebar.tsx, TitleLead.tsx, SidebarToggle.tsx, BoardControls.tsx).
  squarePen: [
    ['path', { d: 'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7' }],
    ['path', { d: 'M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z' }]
  ],
  search: [
    ['path', { d: 'm21 21-4.34-4.34' }],
    ['circle', { cx: '11', cy: '11', r: '8' }]
  ],
  folder: [['path', { d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' }]],
  chevronsUpDown: [
    ['path', { d: 'm7 15 5 5 5-5' }],
    ['path', { d: 'm7 9 5-5 5 5' }]
  ],
  chevronLeft: [['path', { d: 'm15 18-6-6 6-6' }]],
  chevronRight: [['path', { d: 'm9 18 6-6-6-6' }]],
  panelLeft: [
    ['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }],
    ['path', { d: 'M9 3v18' }]
  ],
  undo: [
    ['path', { d: 'M9 14 4 9l5-5' }],
    ['path', { d: 'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11' }]
  ],
  redo: [
    ['path', { d: 'm15 14 5-5-5-5' }],
    ['path', { d: 'M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13' }]
  ],
  ellipsis: [
    ['circle', { cx: '12', cy: '12', r: '1' }],
    ['circle', { cx: '19', cy: '12', r: '1' }],
    ['circle', { cx: '5', cy: '12', r: '1' }]
  ],
  minus: [['path', { d: 'M5 12h14' }]],
  plus: [
    ['path', { d: 'M5 12h14' }],
    ['path', { d: 'M12 5v14' }]
  ]
}

export type IconName = keyof typeof ICONS

/** A lucide icon (stroke 1.75, as the app's ICON). */
export function Icon({ name, stroke = 1.75 }: { name: IconName; stroke?: number }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name].map(([tag, attrs], i) => {
        const Tag = tag
        return <Tag key={i} {...attrs} />
      })}
    </svg>
  )
}

export interface ToolDef {
  id: ToolId
  label: string
  key: string
  digit?: string
  group: 'move' | 'shape' | 'mark'
  /** The app's icon scale: move-up-right fills 14 of its 24 units and slash 20, most icons about 18 (space tools.ts). */
  iconScale?: number
}

/** The app's TOOLS, in the pill's order. */
export const TOOLS: readonly ToolDef[] = [
  { id: 'select', label: 'Select', key: 'V', digit: '1', group: 'move' },
  { id: 'hand', label: 'Hand', key: 'H', group: 'move' },
  { id: 'rect', label: 'Rectangle', key: 'R', digit: '2', group: 'shape' },
  { id: 'ellipse', label: 'Ellipse', key: 'O', digit: '3', group: 'shape' },
  { id: 'arrow', label: 'Arrow', key: 'A', digit: '4', group: 'shape', iconScale: 1.2 },
  { id: 'line', label: 'Line', key: 'L', digit: '5', group: 'shape', iconScale: 0.9 },
  { id: 'pen', label: 'Pen', key: 'P', digit: '6', group: 'mark' },
  { id: 'text', label: 'Text', key: 'T', digit: '7', group: 'mark' },
  { id: 'eraser', label: 'Eraser', key: 'E', digit: '0', group: 'mark' }
]

/** The lock keeps a tool after one shape (Q). */
export const LOCK_KEY = 'Q'

/** The tool for a key without modifiers (a letter in any case, or a digit), or undefined. */
export function toolForKey(key: string): ToolId | undefined {
  const upper = key.toUpperCase()
  return TOOLS.find((tool) => tool.key === upper || tool.digit === key)?.id
}

/** A tool's keys for its tooltip: "V or 1". */
export const toolKeys = (tool: ToolDef): string => `${tool.key}${tool.digit ? ` or ${tool.digit}` : ''}`
