import { Buffer } from "buffer";
import './i18n'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './app'
import ErrorBoundary from './components/ErrorBoundary'

(globalThis as any).Buffer = (globalThis as any).Buffer || Buffer;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
