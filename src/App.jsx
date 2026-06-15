import './App.css'
import Pages from "@/pages/index.jsx"
import { Toaster } from "@/components/ui/toaster"
import { AuthProvider } from "@/contexts/AuthContext"
import { ErrorBoundary } from '@/components/ErrorBoundary';

function App() {

  return (
    <ErrorBoundary>
      <AuthProvider>
        <div className="w-full min-h-[100dvh] bg-black flex justify-center selection:bg-cyan-500/30">
          <div className="w-full bg-[#0a0a0a] min-h-[100dvh] relative shadow-2xl overflow-x-hidden">
            <Pages />
            <Toaster />
          </div>
        </div>
      </AuthProvider>
    </ErrorBoundary>
  );
}

export default App;
