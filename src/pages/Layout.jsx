import React, { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { LogIn, LogOut, Crown, User } from "lucide-react";
import VroomieLogo from '@/components/ui/VroomieLogo';
import { useAuth } from '@/contexts/AuthContext';
import { signOut } from '@/services/authService';

export default function Layout({ children, currentPageName }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, isPro, loading } = useAuth();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-zinc-950 via-zinc-900 to-black text-white">
      <style>{`
        :root {
          --color-bg: #0a0a0a;
          --color-surface: #18181b;
          --color-surface-2: #27272a;
          --color-border: rgba(255,255,255,0.08);
          --color-primary: #FCD34D;
          --color-primary-dark: #F59E0B;
          --color-text: #ffffff;
          --color-text-muted: #a1a1aa;
          --color-danger: #ef4444;
          --color-success: #10b981;
        }

        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #18181b; }
        ::-webkit-scrollbar-thumb { background: #3f3f46; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #52525b; }
      `}</style>

      {/* Navigation */}
      <nav
        className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
          scrolled
            ? "backdrop-blur-xl bg-zinc-900/90 border-b border-white/[0.08] shadow-lg"
            : "backdrop-blur-md bg-zinc-900/40"
        }`}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-14 md:h-16">
            {/* Logo — VroomieLogo handles click internally (glow pulse → home) */}
            <div className="flex items-center gap-3">
              <VroomieLogo size="md" />
              <span
                style={{
                  fontFamily: "'Orbitron', system-ui, sans-serif",
                  fontWeight: 700,
                  fontStyle: "italic",
                  letterSpacing: "-0.02em",
                  fontSize: "1.15rem",
                  lineHeight: 1,
                  background: "linear-gradient(135deg, #FDE68A 0%, #FCD34D 55%, #F59E0B 100%)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                  backgroundClip: "text",
                  cursor: "pointer",
                }}
                onClick={() => { window.location.href = "/"; }}
              >
                Vroomie
              </span>
            </div>

            {/* Auth / User Section */}
            <div className="flex items-center gap-3">
              {!loading && user ? (
                <>
                  {/* Plan Badge */}
                  <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border ${
                    isPro
                      ? 'bg-yellow-400/15 text-yellow-300 border-yellow-400/30'
                      : 'bg-zinc-800 text-zinc-400 border-zinc-700'
                  }`}>
                    {isPro ? <Crown className="w-3 h-3" /> : null}
                    {isPro ? 'PRO' : 'FREE'}
                  </div>

                  {/* User avatar + sign out */}
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full bg-zinc-800 border border-white/10 flex items-center justify-center">
                      <User className="w-4 h-4 text-zinc-400" />
                    </div>
                    <button
                      onClick={async () => { await signOut(); navigate('/login'); }}
                      className="text-xs text-zinc-500 hover:text-red-400 transition-colors flex items-center gap-1"
                    >
                      <LogOut className="w-3 h-3" />
                    </button>
                  </div>
                </>
              ) : !loading ? (
                <button
                  onClick={() => navigate('/login')}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-yellow-400 text-black hover:bg-yellow-300 transition-colors"
                >
                  <LogIn className="w-3.5 h-3.5" /> Sign In
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="pt-14 md:pt-16">{children}</main>

      {/* Footer */}
      <footer className="mt-20 border-t border-white/[0.08] bg-zinc-900/60 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {/* Brand */}
            <div>
              <div className="flex items-center gap-2.5 mb-3">
                <VroomieLogo size="sm" />
                <span className="text-base font-bold text-yellow-300">Vroomie</span>
              </div>
              <p className="text-zinc-500 text-sm max-w-xs">
                AI-powered car diagnostics. Predict issues before they cost you.
              </p>
            </div>

            {/* Contact */}
            <div>
              <h3 className="text-zinc-300 font-semibold mb-3 text-sm">Connect</h3>
              <p className="text-zinc-500 text-sm mb-1">sales@gofriday.shop</p>
              <p className="text-zinc-600 text-xs">© 2026 Vroomie. All rights reserved.</p>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
