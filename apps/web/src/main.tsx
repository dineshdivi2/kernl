import { useState } from 'react'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { ProductApp } from './product/ProductApp'
import './styles.css'

type Mode = 'control-plane' | 'classic-run'

function Shell() {
  const [mode, setMode] = useState<Mode>('control-plane')
  return (
    <>
      <nav className="mode-switch" aria-label="Interface mode">
        <button
          type="button"
          className={mode === 'control-plane' ? 'mode-btn mode-btn--active' : 'mode-btn'}
          onClick={() => setMode('control-plane')}
        >
          Architecture control plane
        </button>
        <button
          type="button"
          className={mode === 'classic-run' ? 'mode-btn mode-btn--active' : 'mode-btn'}
          onClick={() => setMode('classic-run')}
        >
          Classic run dashboard
        </button>
      </nav>
      {mode === 'control-plane' ? <ProductApp /> : <App />}
    </>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Shell />
  </React.StrictMode>,
)
