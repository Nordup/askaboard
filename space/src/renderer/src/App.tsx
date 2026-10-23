import { useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { ToolPalette } from './components/ToolPalette'
import { WelcomeCard } from './components/WelcomeCard'
import type { ToolState } from './tools'

export function App() {
  const [tools, setTools] = useState<ToolState>({ tool: 'pen', colorId: 'white', widthId: 'medium' })
  // Step 1 opens a real learning folder. Until then the app has none.
  const folderName: string | null = null

  return (
    <div className="shell">
      <Sidebar folderName={folderName} />
      <main className="main">
        <TopBar boardTitle="Untitled board" zoom={1} />
        <div className="canvas">
          {folderName === null && <WelcomeCard />}
          <ToolPalette state={tools} onChange={setTools} />
        </div>
      </main>
    </div>
  )
}
