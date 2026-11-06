/**
 * The agent apps that connect to Learning Space, with their install steps as in the plugin repo's
 * README (github.com/Nordup/learning-space-plugins). The "bring your own AI" windows show them.
 */
export const PLUGINS_REPO = 'Nordup/learning-space-plugins'
export const MCPB_URL = `https://github.com/${PLUGINS_REPO}/raw/main/claude-extensions/learning-space/dist/learning-space.mcpb`

/** A line of a terminal window: a command (after a prompt), plain text, a comment, or a download link. */
export type TerminalLine = { kind: 'cmd' | 'text' | 'note'; text: string } | { kind: 'link'; text: string; href: string }

export interface Agent {
  id: string
  name: string
  lines: TerminalLine[]
  /** What the copy button copies; none: no copy button. */
  copy?: string
  /** The plan it runs on. */
  plan: string
}

export const AGENTS: Agent[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    lines: [
      { kind: 'cmd', text: `claude plugin marketplace add ${PLUGINS_REPO}` },
      { kind: 'cmd', text: 'claude plugin install learning-space@learning-space' }
    ],
    copy: `claude plugin marketplace add ${PLUGINS_REPO}\nclaude plugin install learning-space@learning-space`,
    plan: 'Claude Pro or Max'
  },
  {
    id: 'codex',
    name: 'ChatGPT and Codex',
    lines: [
      { kind: 'cmd', text: `codex plugin marketplace add ${PLUGINS_REPO}` },
      { kind: 'cmd', text: 'codex plugin add learning-space@learning-space' }
    ],
    copy: `codex plugin marketplace add ${PLUGINS_REPO}\ncodex plugin add learning-space@learning-space`,
    plan: 'ChatGPT Plus or Pro'
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    lines: [
      { kind: 'note', text: '# download it, then double-click it' },
      { kind: 'link', text: 'learning-space.mcpb', href: MCPB_URL }
    ],
    plan: 'Claude Pro or Max'
  },
  {
    id: 'cursor',
    name: 'Cursor',
    lines: [
      { kind: 'note', text: '# add as a plugin marketplace:' },
      { kind: 'text', text: PLUGINS_REPO },
      { kind: 'note', text: '# then install Learning Space' }
    ],
    copy: PLUGINS_REPO,
    plan: 'Cursor Pro'
  }
]
