import React from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useUIStore } from '@/store/uiStore';
import VroomieLogo from '@/components/ui/VroomieLogo';
import {
  LayoutDashboard,
  CarFront,
  CalendarCheck,
  Map,
  Bookmark,
  CreditCard,
  Settings,
  Menu,
  ChevronLeft
} from 'lucide-react';

const MENU_ITEMS = [
  { name: 'Dashboard', path: '/', icon: LayoutDashboard },
  { name: 'Explore Vehicles', path: '/carops', icon: CarFront },
  { name: 'Bookings', path: '/bookings', icon: CalendarCheck },
  { name: 'My Trips', path: '/trips', icon: Map },
  { name: 'Saved', path: '/saved', icon: Bookmark },
  { name: 'Payments', path: '/payments', icon: CreditCard },
  { name: 'Settings', path: '/settings', icon: Settings },
];

export default function Sidebar() {
  const { user, isPro } = useAuth();
  const { isSidebarCollapsed, toggleSidebar } = useUIStore();

  if (!user) return null;

  return (
    <aside
      className={`fixed left-0 top-0 h-screen bg-zinc-950 border-r border-white/5 transition-all duration-300 z-50 flex flex-col
        ${isSidebarCollapsed ? 'w-20' : 'w-64'}
      `}
    >
      {/* Header */}
      <div className="h-16 flex justify-between items-center px-4 border-b border-white/5">
        <div className={`flex items-center gap-2 overflow-hidden transition-opacity duration-300 ${isSidebarCollapsed ? 'opacity-0 w-0' : 'opacity-100'}`}>
           <VroomieLogo size="sm" />
           <span className="font-bold text-yellow-500 tracking-wider">VROOMIE</span>
        </div>
        <button
          onClick={toggleSidebar}
          className="p-2 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-white transition-colors"
        >
          {isSidebarCollapsed ? <Menu className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-6 px-3 flex flex-col gap-2 overflow-y-auto">
        {MENU_ITEMS.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) => `
              flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 group
              ${isActive ? 'bg-yellow-500/10 text-yellow-500' : 'text-zinc-400 hover:bg-white/5 hover:text-white'}
            `}
            title={isSidebarCollapsed ? item.name : undefined}
          >
            <item.icon className="w-5 h-5 flex-shrink-0" />
            {!isSidebarCollapsed && (
              <span className="font-medium whitespace-nowrap">{item.name}</span>
            )}
          </NavLink>
        ))}
      </nav>

      {/* User Footer */}
      <div className="p-4 border-t border-white/5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-zinc-900 border border-white/10 flex items-center justify-center flex-shrink-0">
             <img src={`https://api.dicebear.com/7.x/notionists/svg?seed=${user.email}`} alt="Avatar" className="w-8 h-8 rounded-full opacity-80" />
          </div>
          {!isSidebarCollapsed && (
            <div className="overflow-hidden">
              <p className="text-sm font-medium text-white truncate">{user.email}</p>
              <div className="flex items-center gap-1 mt-0.5">
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${isPro ? 'bg-yellow-500/20 text-yellow-500' : 'bg-white/10 text-zinc-400'}`}>
                  {isPro ? 'PRO' : 'GUEST'}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
