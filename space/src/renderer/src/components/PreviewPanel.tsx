import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { FilePreview } from '@shared/space-api'
import { Markdown } from '../lib/markdown'
import { errorMessage } from '../lib/errors'

interface PreviewPanelProps {
  path: string
  /** Changes when the folder changes on disk, so the preview reloads. */
  version: number
  onClose(): void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Read-only preview of a file from the learning folder. */
export function PreviewPanel({ path, version, onClose }: PreviewPanelProps) {
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    window.space.readFile(path).then(
      (result) => {
        if (!current) return
        setPreview(result)
        setError(null)
      },
      (reason: unknown) => {
        if (!current) return
        setPreview(null)
        setError(errorMessage(reason))
      }
    )
    return () => {
      current = false
    }
  }, [path, version])

  const name = path.slice(path.lastIndexOf('/') + 1)
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  const isMarkdown = /\.(md|markdown)$/i.test(name)

  let body
  if (error) body = <div className="preview__message">{error}</div>
  else if (!preview) body = <div className="preview__message">Loading…</div>
  else if (preview.kind === 'image')
    body = (
      <div className="preview__image">
        <img src={preview.dataUrl} alt={name} />
      </div>
    )
  else if (preview.kind === 'binary') body = <div className="preview__message">No preview for this file type.</div>
  else if (preview.kind === 'too-large') body = <div className="preview__message">This file is too large to preview ({formatSize(preview.size)}).</div>
  else
    body = (
      <>
        {isMarkdown ? <Markdown source={preview.text} /> : <pre className="preview__text">{preview.text}</pre>}
        {preview.truncated && <div className="preview__message">Only the first 1 MB is shown.</div>}
      </>
    )

  return (
    <aside className="preview" aria-label={`Preview of ${name}`}>
      <header className="preview__header">
        <div className="preview__title">
          <span className="preview__name">{name}</span>
          {dir && <span className="preview__dir">{dir}</span>}
        </div>
        {preview && <span className="preview__size">{formatSize(preview.size)}</span>}
        <button className="icon-button" title="Close preview" aria-label="Close preview" onClick={onClose}>
          <X size={14} strokeWidth={2} />
        </button>
      </header>
      <div className="preview__body">{body}</div>
    </aside>
  )
}
