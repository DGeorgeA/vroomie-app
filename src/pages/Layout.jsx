import React, { useState, useEffect, Suspense } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from '@/contexts/AuthContext';
import { useUIStore } from '@/store/uiStore';
import Sidebar from '@/components/layout/Sidebar';
import AuthPanel from '@/components/layout/AuthPanel';
import VroomieLogo from '@/components/ui/VroomieLogo';

export default function Layout({ children, currentPageName }) {
  const { user, loading } = useAuth();
  const { isSidebarCollapsed } = useUIStore();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <div className="min-h-screen bg-black text-white selection:bg-yellow-500/30 font-sans">
      <style>{`
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #000; }
        ::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #555; }
      `}</style>

      {/* SEO Schema Markup */}
      <script type="application/ld+json">
        {JSON.stringify({
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          "name": "Vroomie Diagnostics",
          "applicationCategory": "UtilitiesApplication",
          "operatingSystem": "Web",
          "offers": {
            "@type": "Offer",
            "price": "0",
            "priceCurrency": "USD"
          }
        })}
      </script>

      {!loading && user && <Sidebar />}
      {!loading && !user && <AuthPanel />}

      {/* Sidebar Backdrop Overlay */}
      {!loading && user && !isSidebarCollapsed && (
        <div 
          className="fixed inset-0 bg-black/60 z-40 backdrop-blur-sm transition-opacity" 
          onClick={useUIStore.getState().toggleSidebar} 
        />
      )}

      <div 
        className="transition-all duration-300 min-h-screen flex flex-col w-full"
      >
        <header
          className={`sticky top-0 z-40 transition-all duration-300 ${
            scrolled ? "backdrop-blur-xl bg-black/80 border-b border-white/5 shadow-2xl" : "bg-transparent"
          }`}
        >
          <div className="flex justify-between items-center h-16 px-6 lg:px-10">
            <div className="flex items-center gap-4">
              {/* Sidebar Toggle Button */}
              {!loading && user && (
                <button
                  onClick={useUIStore.getState().toggleSidebar}
                  aria-label="Open navigation menu"
                  className="p-2 -ml-2 rounded-lg hover:bg-white/10 text-white transition-colors"
                  style={{ color: '#ffffff', zIndex: 100 }}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg>
                </button>
              )}
              <h1 className="text-xl font-bold tracking-tight text-white/90">
                {currentPageName === 'PredictiveMaintenance' ? 'Dashboard' : currentPageName}
              </h1>
            </div>
            
            {/* Mobile Logo Fallback when sidebar is hidden */}
            <div className="flex items-center gap-2">
              <VroomieLogo size="sm" />
            </div>
          </div>
        </header>

        <main className="flex-1 p-6 lg:p-10 relative">
          <Suspense fallback={<div className="animate-pulse bg-white/5 rounded-xl h-64 w-full" />}>
            {children}
          </Suspense>
        </main>

        <footer className="mt-auto border-t border-white/5 bg-black/50 p-6 lg:p-10">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-zinc-500">
            <div className="flex items-center gap-2">
              <VroomieLogo size="sm" />
              <span className="font-display font-bold text-zinc-400">Vroomie</span>
            </div>
            <p>┬⌐ 2026 Vroomie AI Car Diagnostics. All rights reserved.</p>
          </div>
        </footer>
      </div>
    </div>
  );
}
