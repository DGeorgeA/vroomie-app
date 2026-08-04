import './App.css'
import Pages from "@/pages/index.jsx"
import { Toaster } from "@/components/ui/toaster"
// Sonner toaster — the entire codebase fires toasts via `toast` from 'sonner',
// but only the radix Toaster was mounted, so EVERY sonner toast (recording
// status, "Unable to detect", engine errors) was silently dropped. Mounting
// sonner's viewport makes them visible; the radix Toaster stays for any
// legacy use-toast callers.
import { Toaster as SonnerToaster } from "sonner"
import { AuthProvider } from "@/contexts/AuthContext"
import { EthanolFeatureProvider } from "@/contexts/EthanolFeatureContext"
import { ErrorBoundary } from '@/components/ErrorBoundary';

function App() {

  return (
    <ErrorBoundary>
      <AuthProvider>
        <EthanolFeatureProvider>
          <div className="w-full min-h-[100dvh] bg-black flex justify-center selection:bg-cyan-500/30">
            <div className="w-full bg-[#0a0a0a] min-h-[100dvh] relative shadow-2xl overflow-x-hidden">
              <Pages />
              <Toaster />
              <SonnerToaster position="top-center" richColors closeButton
                             toastOptions={{ style: { zIndex: 2000 } }} />
            </div>
          </div>
        </EthanolFeatureProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}

export default App;
