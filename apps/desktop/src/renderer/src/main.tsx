import './frame-pace'
import './lib/scrollbars'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/app.css'
import { App } from './App'
import { followTheme } from './lib/theme'

const root = createRoot(document.getElementById('root')!)

// The hand is on screen before anything draws, so text never flashes or measures in another font. Without the file, the fallback font shows.
// Both cuts load: the screen's pixel density picks one (board/content.css), and a window can move to another screen.
const fontsReady = Promise.all(['20px "Learning Hand"', '20px "Learning Hand Heavy"'].map((font) => document.fonts.load(font).catch(() => undefined)))

// `?snapshot=1`: the hidden window that renders agent screenshots. Its view loads only there.
const isSnapshot = new URLSearchParams(window.location.search).get('snapshot') === '1'

// The theme is on <html> before the first paint. The snapshot window keeps the dark tokens (:root) always.
if (!isSnapshot) followTheme()

void fontsReady.then(async () => {
  if (isSnapshot) {
    const { SnapshotView } = await import('./snapshot/SnapshotView')
    root.render(
      <StrictMode>
        <SnapshotView />
      </StrictMode>
    )
  } else {
    root.render(
      <StrictMode>
        <App />
      </StrictMode>
    )
  }
})
