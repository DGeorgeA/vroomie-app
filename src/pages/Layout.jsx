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

      <div 
        className={`transition-all duration-300 min-h-screen flex flex-col`}
        style={{
          marginLeft: !loading && user ? (isSidebarCollapsed ? '5rem' : '16rem') : (!loading && !user ? '400px' : '0'),
        }}
      >
        <header
          className={`sticky top-0 z-40 transition-all duration-300 ${
            scrolled ? "backdrop-blur-xl bg-black/80 border-b border-white/5 shadow-2xl" : "bg-transparent"
          }`}
        >
          <div className="flex justify-between items-center h-16 px-6 lg:px-10">
            <h1 className="text-xl font-bold tracking-tight text-white/90">
              {currentPageName === 'PredictiveMaintenance' ? 'Dashboard' : currentPageName}
            </h1>
            
            {/* Mobile Logo Fallback when sidebar is hidden */}
            <div className="lg:hidden flex items-center gap-2">
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
              <span className="font-bold text-zinc-400">Vroomie</span>
            </div>
            <p>┬⌐ 2026 Vroomie AI Car Diagnostics. All rights reserved.</p>
          </div>
        </footer>
      </div>
    </div>
  );
}
