import { ChevronRight, File, FileBraces, FileCode, FileImage, FileText, Folder, FolderOpen, LayoutDashboard } from 'lucide-react'
import type { CSSProperties } from 'react'
import { isBoardPath } from '@shared/board-format'
import type { FileNode } from '@shared/space-api'

const ICON_PROPS = { size: 14, strokeWidth: 1.75 }

function FileIcon({ name }: { name: string }) {
  const lower = name.toLowerCase()
  if (isBoardPath(lower)) return <LayoutDashboard {...ICON_PROPS} />
  const ext = lower.slice(lower.lastIndexOf('.') + 1)
  if (['md', 'markdown', 'txt', 'rtf', 'pdf'].includes(ext)) return <FileText {...ICON_PROPS} />
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico'].includes(ext)) return <FileImage {...ICON_PROPS} />
  if (['json', 'yaml', 'yml', 'toml'].includes(ext)) return <FileBraces {...ICON_PROPS} />
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'html', 'css', 'sh', 'swift', 'rs', 'go', 'c', 'cpp', 'java'].includes(ext))
    return <FileCode {...ICON_PROPS} />
  return <File {...ICON_PROPS} />
}

const INDENT = 14
/** Chevron 12 + gap 6 + icon 14 + gap 6: the empty note lines up with the names of sibling rows. */
const EMPTY_TEXT_OFFSET = 38

/** Left padding of a row; the depth is the number of folders in the row's path. */
function rowIndent(depth: number): number {
  return 8 + depth * INDENT
}

/** A nested list draws a guide line under its parent's chevron, so the depth of a row is visible. */
function guideStyle(depth: number): CSSProperties {
  return { '--tree-guide-x': `${rowIndent(depth - 1) + 6}px` } as CSSProperties
}

interface FileTreeProps {
  nodes: FileNode[]
  expanded: ReadonlySet<string>
  /** The highlighted file: the open board or the previewed file. */
  activePaths: ReadonlySet<string>
  onToggle(path: string): void
  onOpen(node: FileNode): void
  depth?: number
}

export function FileTree({ nodes, expanded, activePaths, onToggle, onOpen, depth = 0 }: FileTreeProps) {
  return (
    <ul className="tree" role={depth === 0 ? 'tree' : 'group'} style={depth > 0 ? guideStyle(depth) : undefined}>
      {nodes.map((node) => {
        const isOpen = node.kind === 'dir' && expanded.has(node.path)
        return (
          <li key={node.path} role="treeitem" aria-expanded={node.kind === 'dir' ? isOpen : undefined}>
            <button
              className={activePaths.has(node.path) ? 'tree__row tree__row--active' : 'tree__row'}
              style={{ paddingLeft: rowIndent(depth) }}
              title={node.path}
              onClick={() => (node.kind === 'dir' ? onToggle(node.path) : onOpen(node))}
            >
              <span className={isOpen ? 'tree__chevron tree__chevron--open' : 'tree__chevron'}>
                {node.kind === 'dir' && <ChevronRight size={12} strokeWidth={2} />}
              </span>
              <span className="tree__icon">
                {node.kind === 'dir' ? isOpen ? <FolderOpen {...ICON_PROPS} /> : <Folder {...ICON_PROPS} /> : <FileIcon name={node.name} />}
              </span>
              <span className="tree__name">{node.name}</span>
            </button>
            {isOpen &&
              (node.children && node.children.length > 0 ? (
                <FileTree
                  nodes={node.children}
                  expanded={expanded}
                  activePaths={activePaths}
                  onToggle={onToggle}
                  onOpen={onOpen}
                  depth={depth + 1}
                />
              ) : (
                // An open folder always shows a row under it. Without this row, an open
                // empty folder looks like the parent of the rows that follow it.
                <ul className="tree" role="group" style={guideStyle(depth + 1)}>
                  <li role="treeitem" aria-disabled="true" className="tree__empty" style={{ paddingLeft: rowIndent(depth + 1) + EMPTY_TEXT_OFFSET }}>
                    empty
                  </li>
                </ul>
              ))}
          </li>
        )
      })}
    </ul>
  )
}
