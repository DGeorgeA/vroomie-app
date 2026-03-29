import { useEffect } from "react";
import './App.css'
import Pages from "@/pages/index.jsx"
import { Toaster } from "@/components/ui/toaster"
import { initializeAudioDataset } from "@/services/audioDatasetService"
import { AuthProvider } from "@/contexts/AuthContext"
import { ErrorBoundary } from '@/components/ErrorBoundary';

function App() {

  useEffect(() => {
    // App initialization
    initializeAudioDataset().catch(console.error);
  }, []); // run once when the app loads

  return (
    <ErrorBoundary>
      <AuthProvider>
        <div className="w-full min-h-[100dvh] bg-black flex justify-center selection:bg-cyan-500/30">
          <div className="w-full max-w-md bg-[#0a0a0a] min-h-[100dvh] relative shadow-2xl overflow-x-hidden">
            <Pages />
            <Toaster />
          </div>
        </div>
      </AuthProvider>
    </ErrorBoundary>
  );
}

export default App;
