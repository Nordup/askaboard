import './frame-pace'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/app.css'
import { App } from './App'

const root = createRoot(document.getElementById('root')!)

// `?snapshot=1`: the hidden window that renders agent screenshots. Its view loads only there.
if (new URLSearchParams(window.location.search).get('snapshot') === '1') {
  void import('./snapshot/SnapshotView').then(({ SnapshotView }) =>
    root.render(
      <StrictMode>
        <SnapshotView />
      </StrictMode>
    )
  )
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}
