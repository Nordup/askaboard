import { BookOpen } from 'lucide-react'
import type { FolderOverride, GuideOverrides } from '@shared/space-api'

interface Line {
  override: FolderOverride
  label: string
  tooltip: string
}

function line(override: FolderOverride | null, what: 'guide' | 'instructions'): Line | null {
  if (!override) return null
  const thing = what === 'guide' ? 'board guide' : 'agent instructions'
  const file = override.path
  if (override.mode === 'too-large') {
    return {
      override,
      label: what === 'guide' ? 'Board guide ignored (over 64 KB)' : 'Instructions ignored (over 64 KB)',
      tooltip: `${file} is larger than 64 KB, so agents do not get it. Click to open the file.`
    }
  }
  if (override.mode === 'replace') {
    return {
      override,
      label: what === 'guide' ? 'Custom guide (replaces built-in)' : 'Custom instructions (replace)',
      tooltip: `${file} has "mode: replace": agents read it instead of the built-in ${thing}. Click to open the file.`
    }
  }
  return {
    override,
    label: what === 'guide' ? 'Custom board guide' : 'Custom agent instructions',
    tooltip: `Agents read ${file} after the built-in ${thing}. Click to open the file.`
  }
}

/** The lines that say this folder changes what agents read. */
export function overrideLines(overrides: GuideOverrides | null): Line[] {
  if (!overrides) return []
  return [line(overrides.guide, 'guide'), line(overrides.instructions, 'instructions')].filter((entry): entry is Line => !!entry)
}

/** Quiet clickable lines, one per folder override. Renders nothing when there is none. */
export function GuideOverrideNote({ overrides, onOpen, className }: { overrides: GuideOverrides | null; onOpen(path: string): void; className: string }) {
  const lines = overrideLines(overrides)
  if (!lines.length) return null
  return (
    <div className={className}>
      {lines.map(({ override, label, tooltip }) => (
        <button
          key={override.path}
          className={`guide-override${override.mode === 'too-large' ? ' guide-override--warn' : ''}`}
          title={tooltip}
          onClick={() => onOpen(override.path)}
        >
          <BookOpen size={12} strokeWidth={1.75} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  )
}
