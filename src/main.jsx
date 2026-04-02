import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import '@/index.css'
import { registerSW } from 'virtual:pwa-register'

// Register Service Worker — autoUpdate mode: new SW activates automatically
const updateSW = registerSW({
  onNeedRefresh() {
    // Immediately activate the new service worker (skip waiting)
    updateSW(true);
  },
  onOfflineReady() {
    console.log('[Vroomie] App ready to work offline.');
  },
})

ReactDOM.createRoot(document.getElementById('root')).render(
    <App />
)