import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useUIStore } from '@/store/uiStore';
import { useSettingsStore } from '@/store/settingsStore';
import VroomieLogo from '@/components/ui/VroomieLogo';
import { signOut } from '@/services/authService';
import { toast } from 'sonner';
import {
  LayoutDashboard,
  Sparkles,
  Map,
  Settings,
  ChevronLeft,
  CalendarCheck,
  Bookmark,
  CreditCard,
  ShieldCheck,
  FlaskConical,
  LogOut,
  MessageSquare,
} from 'lucide-react';

// ─── Active routes (fully implemented) ──────────────────────────────────────
const ACTIVE_ITEMS = [
  { name: 'Dashboard',         path: '/',           icon: LayoutDashboard },
  { name: 'Latest AI Updates', path: '/ai-updates', icon: Sparkles },
  { name: 'My Trips',          path: '/trips',      icon: Map },
  { name: 'Settings',          path: '/settings',   icon: Settings },
];

// ─── Coming Soon items ────────────────────────────────────────────────────────
const SOON_ITEMS = [
  { name: 'Bookings',  path: '/bookings', icon: CalendarCheck },
  { name: 'Saved',     path: '/saved',    icon: Bookmark },
  { name: 'Payments',  path: '/payments', icon: CreditCard },
];

const Sidebar = React.memo(function Sidebar({ onFeedbackOpen }) {
  const { user, isPro } = useAuth();
  const { isSidebarCollapsed, toggleSidebar } = useUIStore();
  const showValidationMenu = useSettingsStore(state => state.showValidationMenu);
  const navigate = useNavigate();

  const activeLinks = [...ACTIVE_ITEMS];
  if (showValidationMenu) {
    activeLinks.push({ name: 'Validate Audio', path: '/validate-audio', icon: ShieldCheck });
    activeLinks.push({ name: 'Test Detection', path: '/test-detection', icon: FlaskConical });
  }

  const handleLogout = async () => {
    try {
      toggleSidebar();
      await signOut();
      // Clear any local caches that shouldn't persist across sessions
      try { localStorage.removeItem('vroomie_settings_v1'); } catch { /* ignore */ }
      toast.success('Signed out successfully.');
      navigate('/login');
    } catch (err) {
      toast.error('Sign-out failed. Please try again.');
    }
  };

  // v1.2.7 — Increased z-index to 1000 for perfect mobile overlap
  return (
    <aside
      className={`fixed left-0 top-0 h-screen bg-zinc-950 border-r border-white/5 transition-transform duration-300 ease-in-out z-[1000] flex flex-col w-64 shadow-[10px_0_30px_rgba(0,0,0,0.5)] ${
        isSidebarCollapsed ? '-translate-x-full' : 'translate-x-0'
      }`}
      style={{ willChange: 'transform' }}
    >

      {/* Header */}
      <div className="h-16 flex justify-between items-center px-4 border-b border-white/5 flex-shrink-0">
        <div className="flex items-center gap-2 overflow-hidden">
          <VroomieLogo size="sm" />
          <span className="font-display font-bold text-yellow-500 tracking-wider text-sm">VROOMIE</span>
        </div>
        <button
          onClick={toggleSidebar}
          className="p-2 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-white transition-colors flex-shrink-0"
          aria-label="Close menu"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
      </div>

      {/* Feedback CTA — between logo and nav, inside document flow */}
      {onFeedbackOpen && (
        <div className="px-3 pt-1 pb-2 flex-shrink-0">
          <button
            id="sidebar-feedback-btn"
            onClick={() => { onFeedbackOpen(); toggleSidebar(); }}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border border-yellow-500/20 bg-yellow-500/5 text-yellow-400/80 hover:bg-yellow-500/10 hover:text-yellow-400 hover:border-yellow-500/40 transition-all duration-200 text-xs font-semibold"
            style={{ touchAction: 'manipulation' }}
          >
            <MessageSquare className="w-3.5 h-3.5 flex-shrink-0" />
            <span>Give Feedback</span>
          </button>
        </div>
      )}

      {/* Navigation */}
      <nav className="flex-1 py-4 px-3 flex flex-col gap-1 overflow-y-auto">

        {/* Active items */}
        {activeLinks.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            onClick={toggleSidebar}
            end={item.path === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 ${
                isActive
                  ? 'bg-yellow-500/10 text-yellow-500'
                  : 'text-zinc-400 hover:bg-white/5 hover:text-white'
              }`
            }
          >
            <item.icon className="w-5 h-5 flex-shrink-0" />
            <span className="font-medium whitespace-nowrap text-sm">{item.name}</span>
          </NavLink>
        ))}

        {/* Divider */}
        <div className="mx-3 my-2 border-t border-white/5" />

        {/* Coming Soon items */}
        {SOON_ITEMS.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            onClick={toggleSidebar}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-zinc-600 hover:bg-white/3 transition-all duration-200 group"
          >
            <item.icon className="w-5 h-5 flex-shrink-0 opacity-40" />
            <span className="font-medium whitespace-nowrap text-sm opacity-40">{item.name}</span>
            <span className="ml-auto text-[9px] font-bold px-1.5 py-0.5 rounded-full border border-zinc-700 text-zinc-600 bg-zinc-900 tracking-wider">
              SOON
            </span>
          </NavLink>
        ))}
      </nav>

      {/* User Footer with Logout */}
      <div className="p-4 border-t border-white/5 flex-shrink-0">
        {user ? (
          <>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-9 h-9 rounded-full bg-zinc-900 border border-white/10 flex items-center justify-center flex-shrink-0 overflow-hidden">
                <img
                  src={`https://api.dicebear.com/7.x/notionists/svg?seed=${user.email}`}
                  alt="Avatar"
                  className="w-8 h-8 rounded-full opacity-80"
                  loading="lazy"
                />
              </div>
              <div className="overflow-hidden flex-1 min-w-0">
                <p className="text-sm font-medium text-white truncate">{user.email}</p>
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${isPro ? 'bg-yellow-500/20 text-yellow-500' : 'bg-white/10 text-zinc-400'}`}>
                  {isPro ? 'PRO' : 'GUEST'}
                </span>
              </div>
            </div>

            <button
              onClick={handleLogout}
              id="sidebar-logout-btn"
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/20 transition-all duration-200 text-sm font-medium"
              style={{ touchAction: 'manipulation' }}
            >
              <LogOut className="w-4 h-4 flex-shrink-0" />
              <span>Sign Out</span>
            </button>
          </>
        ) : (
          <div className="text-center py-2">
             <p className="text-xs text-zinc-500 italic">Please sign in to access all features.</p>
          </div>
        )}

        <div className="mt-4 text-center">
          <span className="text-[10px] text-zinc-700 font-mono tracking-tighter">v1.2.7-CALIBRATED</span>
        </div>
      </div>

    </aside>
  );
});

export default Sidebar;
