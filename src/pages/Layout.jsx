
import React, { useState, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Activity } from "lucide-react";
import VroomieLogo from '@/components/ui/VroomieLogo';

export default function Layout({ children, currentPageName }) {
  const location = useLocation();
  const [scrolled, setScrolled] = useState(false);
  const [showLogoAnimation, setShowLogoAnimation] = useState(true);

  // Trigger logo animation on route change
  useEffect(() => {
    setShowLogoAnimation(true);
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-zinc-950 via-zinc-900 to-black text-white">
      <style>{`
        /* Glassmorphism CSS Variables */
        :root {
          --vroomie-yellow: #FCD34D;
          --vroomie-yellow-dark: #F59E0B;
          --vroomie-black: #18181B;
          --vroomie-black-light: #27272A;
        }

        /* Custom Scrollbar */
        ::-webkit-scrollbar {
          width: 8px;
        }
        ::-webkit-scrollbar-track {
          background: #18181B;
        }
        ::-webkit-scrollbar-thumb {
          background: #FCD34D;
          border-radius: 4px;
        }
        ::-webkit-scrollbar-thumb:hover {
          background: #F59E0B;
        }

        /* Glass glow animation */
        @keyframes glow {
          0%, 100% { box-shadow: 0 0 20px rgba(252, 211, 77, 0.3); }
          50% { box-shadow: 0 0 40px rgba(252, 211, 77, 0.5); }
        }
        .glow-animation {
          animation: glow 3s ease-in-out infinite;
        }
      `}</style>

      {/* Frosted Glass Navigation */}
      <nav
        className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${scrolled
          ? "backdrop-blur-xl bg-zinc-900/80 border-b border-yellow-300/20 shadow-lg shadow-yellow-300/10"
          : "backdrop-blur-md bg-zinc-900/40"
          }`}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16 md:h-20">
            {/* Logo */}
            <div className="flex items-center gap-3 group">
              <div className="relative">
                <div className="absolute inset-0 bg-gradient-to-br from-yellow-300 to-yellow-500 rounded-xl blur-md opacity-50 group-hover:opacity-75 transition-opacity" />
                <div className="relative bg-gradient-to-br from-yellow-300/20 to-yellow-500/20 p-2 rounded-xl border border-yellow-300/30">
                  <VroomieLogo size="md" showAnimation={showLogoAnimation} />
                </div>
              </div>
              <span className="text-2xl font-bold bg-gradient-to-r from-yellow-300 to-yellow-500 bg-clip-text text-transparent">
                Vroomie
              </span>
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="pt-16 md:pt-20">{children}</main>

      {/* Footer */}
      <footer className="relative mt-20 backdrop-blur-xl bg-zinc-900/80 border-t border-yellow-300/20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {/* Brand */}
            <div>
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-gradient-to-br from-yellow-300/20 to-yellow-500/20 p-2 rounded-xl border border-yellow-300/30">
                  <VroomieLogo size="sm" showAnimation={false} />
                </div>
                <span className="text-xl font-bold text-yellow-300">Vroomie</span>
              </div>
              <p className="text-gray-400 text-sm">
                Next-gen car care powered by AI. Predict, control, and beautify your ride.
              </p>
            </div>

            {/* Contact */}
            <div>
              <h3 className="text-yellow-300 font-semibold mb-4">Connect</h3>
              <p className="text-gray-400 text-sm mb-2">sales@gofriday.shop</p>
              <p className="text-gray-400 text-sm">© 2025 Vroomie. All rights reserved.</p>
            </div>
          </div>
        </div>

        {/* Glow effect */}
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-1/2 h-px bg-gradient-to-r from-transparent via-yellow-300/50 to-transparent" />
      </footer>
    </div>
  );
}
