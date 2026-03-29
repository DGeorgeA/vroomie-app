import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import '@/index.css'
import { registerSW } from 'virtual:pwa-register'

// Register Service Worker for PWA Offline Capabilities
const updateSW = registerSW({
  onNeedRefresh() {
    // Optionally trigger a toast to the user
    console.log('New content available, waiting for refresh...');
  },
  onOfflineReady() {
    console.log('App ready to work offline!');
  },
})

ReactDOM.createRoot(document.getElementById('root')).render(
    <App />
)