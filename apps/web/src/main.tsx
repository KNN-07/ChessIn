import React from 'react'
import { createRoot } from 'react-dom/client'
import { config } from '@fortawesome/fontawesome-svg-core'
import '@fortawesome/fontawesome-svg-core/styles.css'
import './styles/tokens.css'
import './styles/app.css'
import { App } from './App'
import { EngineProvider } from './engine/EngineContext'

config.autoAddCss = false

createRoot(document.getElementById('root')!).render(<React.StrictMode><EngineProvider><App /></EngineProvider></React.StrictMode>)
