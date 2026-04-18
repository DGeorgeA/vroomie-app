import React from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { 
  User, Bell, Volume2, Shield, CreditCard, 
  ChevronRight, Languages, Activity, CheckCircle2 
} from 'lucide-react';
import GlassCard from '@/components/ui/GlassCard';

export default function Settings() {
  const { user, isPro } = useAuth();

  const SettingsSection = ({ title, children }) => (
    <div className="mb-8">
      <h3 className="text-sm font-display font-bold text-zinc-400 uppercase tracking-wider mb-4 px-1">
        {title}
      </h3>
      <div className="bg-zinc-900/50 border border-white/5 rounded-2xl overflow-hidden backdrop-blur-sm">
        {children}
      </div>
    </div>
  );

  const SettingsItem = ({ icon: Icon, title, description, extra, isLast }) => (
    <div className={`flex items-center justify-between p-4 bg-transparent hover:bg-white/5 transition-colors cursor-pointer ${!isLast ? 'border-b border-white/5' : ''}`}>
      <div className="flex items-center gap-4">
        <div className="w-10 h-10 rounded-full bg-zinc-800/80 flex items-center justify-center flex-shrink-0 text-zinc-400">
          <Icon className="w-5 h-5" />
        </div>
        <div>
           <p className="text-white font-medium">{title}</p>
           {description && <p className="text-xs text-zinc-400 mt-0.5">{description}</p>}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {extra}
        <ChevronRight className="w-4 h-4 text-zinc-500" />
      </div>
    </div>
  );

  const ToggleSwitch = ({ defaultChecked }) => (
    <div className={`w-11 h-6 rounded-full p-1 cursor-pointer transition-colors ${defaultChecked ? 'bg-yellow-500' : 'bg-zinc-700'}`}>
      <div className={`w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${defaultChecked ? 'translate-x-5' : 'translate-x-0'}`} />
    </div>
  );

  return (
    <div className="max-w-3xl mx-auto pb-12 w-full">
      <div className="mb-8 px-1">
        <h2 className="text-3xl font-display font-bold text-white tracking-tight mb-2">Account Settings</h2>
        <p className="text-zinc-400 text-sm">Manage your preferences and Vroomie application settings.</p>
      </div>

      <SettingsSection title="Account & Plan">
        <SettingsItem 
          icon={User} 
          title="Email Address" 
          description={user?.email || "Not signed in"} 
        />
        <SettingsItem 
          icon={CreditCard} 
          title="Subscription" 
          description={isPro ? "Vroomie AI Enabled (Pro)" : "Basic Guest Account"} 
          extra={
            isPro 
              ? <div className="flex items-center gap-1 bg-yellow-500/10 text-yellow-500 px-2 py-0.5 border border-yellow-500/20 rounded text-xs font-bold font-display"><CheckCircle2 className="w-3 h-3"/> ACTIVE</div>
              : <div className="text-yellow-500 text-xs font-bold hover:underline">UPGRADE</div>
          }
          isLast 
        />
      </SettingsSection>

      <SettingsSection title="Preferences">
        <SettingsItem 
          icon={Languages} 
          title="Language" 
          description="English (US) currently active"
          extra={<span className="text-zinc-400 text-sm">English</span>}
        />
        <SettingsItem 
          icon={Bell} 
          title="Voice Alerts" 
          description="Speak identified mechanical issues aloud"
          extra={<ToggleSwitch defaultChecked={true} />}
          isLast
        />
      </SettingsSection>

      <SettingsSection title="Audio Configuration">
        <SettingsItem 
          icon={Activity} 
          title="Detection Mode" 
          description="Machine Learning vs Basic Fast Fourier Transform"
          extra={<span className="text-blue-400 text-sm font-medium bg-blue-500/10 px-2 py-0.5 rounded border border-blue-500/20">ML ENGINE</span>}
        />
        <SettingsItem 
          icon={Volume2} 
          title="Microphone Sensitivity" 
          description="Threshold for continuous background recording"
          extra={<span className="text-zinc-400 text-sm">High</span>}
          isLast
        />
      </SettingsSection>

      <SettingsSection title="Privacy & Data">
        <SettingsItem 
          icon={Shield} 
          title="Data Collection" 
          description="Allow anon aggregated acoustic tracking"
          extra={<ToggleSwitch defaultChecked={true} />}
        />
        <SettingsItem 
          icon={User} 
          title="Privacy Policy" 
          description="Read how your audio data is stored"
          isLast
        />
      </SettingsSection>

      <div className="mt-8 px-1">
        <button className="w-full form-button px-4 py-3 bg-red-500/10 hover:bg-red-500/20 text-red-500 font-bold rounded-xl border border-red-500/20 transition-all">
          Sign Out All Devices
        </button>
      </div>
    </div>
  );
}
