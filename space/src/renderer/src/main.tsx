import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/app.css'
import { App } from './App'
import { SnapshotView } from './snapshot/SnapshotView'

/** `?snapshot=1`: the hidden window that renders agent screenshots. */
const snapshotMode = new URLSearchParams(window.location.search).get('snapshot') === '1'

createRoot(document.getElementById('root')!).render(<StrictMode>{snapshotMode ? <SnapshotView /> : <App />}</StrictMode>)
