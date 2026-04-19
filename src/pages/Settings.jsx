import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { signOut } from '@/services/authService';
import { useSettingsStore, LANGUAGE_OPTIONS, SENSITIVITY_CONFIG } from '@/store/settingsStore';
import { setDetectionMode } from '@/lib/detectionMode';
import { canAccess } from '@/lib/featureGate';
import { toast } from 'sonner';
import {
  User, Bell, Volume2, Shield, CreditCard,
  Languages, Activity, LogOut, Mic, Database,
  History, ChevronRight, CheckCircle2, Zap, Lock, Wrench
} from 'lucide-react';

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ title }) {
  return (
    <h3 className="text-xs font-display font-bold text-zinc-500 uppercase tracking-widest mb-3 px-1">
      {title}
    </h3>
  );
}

function SettingsCard({ children }) {
  return (
    <div className="bg-zinc-900/60 border border-white/5 rounded-2xl overflow-hidden backdrop-blur-sm mb-6">
      {children}
    </div>
  );
}

function SettingsRow({ icon: Icon, iconColor = 'text-zinc-400', title, description, right, border = true, onClick }) {
  return (
    <div
      className={`flex items-center justify-between px-4 py-3.5 transition-colors ${onClick ? 'cursor-pointer hover:bg-white/5 active:bg-white/10' : ''} ${border ? 'border-b border-white/5' : ''}`}
      onClick={onClick}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className={`w-9 h-9 rounded-xl bg-zinc-800/80 flex items-center justify-center flex-shrink-0 ${iconColor}`}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-white">{title}</p>
          {description && <p className="text-xs text-zinc-500 mt-0.5 leading-snug">{description}</p>}
        </div>
      </div>
      <div className="flex items-center gap-2 ml-3 flex-shrink-0">{right}</div>
    </div>
  );
}

function Toggle({ enabled, onChange }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onChange(!enabled); }}
      className={`relative w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none ${enabled ? 'bg-yellow-500' : 'bg-zinc-700'}`}
      role="switch"
      aria-checked={enabled}
    >
      <span
        className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow-sm transform transition-transform duration-200 ${enabled ? 'translate-x-5' : 'translate-x-0'}`}
      />
    </button>
  );
}

function SegmentedControl({ options, value, onChange, disabled = false }) {
  return (
    <div className="flex bg-zinc-800/80 rounded-lg p-0.5 gap-0.5">
      {options.map(opt => (
        <button
          key={opt.value}
          disabled={disabled && opt.value !== value}
          onClick={() => !disabled && onChange(opt.value)}
          className={`px-3 py-1 rounded-md text-xs font-semibold transition-all duration-150 ${
            value === opt.value
              ? 'bg-yellow-500 text-black shadow-sm'
              : disabled
                ? 'text-zinc-600 cursor-not-allowed'
                : 'text-zinc-400 hover:text-white'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ─── Main Settings Page ───────────────────────────────────────────────────────

export default function Settings() {
  const { user, isPro } = useAuth();
  const navigate = useNavigate();

  const {
    language, setLanguage,
    voiceAlertsEnabled, setVoiceAlerts,
    sensitivity, setSensitivity,
    detectionMode, setDetectionMode: setMode,
    saveHistory, setSaveHistory,
    dataCollectionEnabled, setDataCollection,
    showValidationMenu, setShowValidationMenu,
    hydrate,
  } = useSettingsStore();

  const [micStatus, setMicStatus] = useState('checking');
  const [langOpen, setLangOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  // Hydrate settings from Supabase on mount
  useEffect(() => {
    if (user?.id) hydrate(user.id);
  }, [user?.id]);

  // Check microphone permission status
  useEffect(() => {
    if (!navigator.permissions) { setMicStatus('unknown'); return; }
    navigator.permissions.query({ name: 'microphone' }).then(result => {
      setMicStatus(result.state);
      result.onchange = () => setMicStatus(result.state);
    }).catch(() => setMicStatus('unknown'));
  }, []);

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut();
      toast.success('Signed out successfully.');
      navigate('/login');
    } catch {
      toast.error('Sign-out failed. Please try again.');
    } finally {
      setSigningOut(false);
    }
  };

  const handleSensitivity = (level) => {
    setSensitivity(level);
    const cfg = SENSITIVITY_CONFIG[level];
    toast.success(`Sensitivity set to ${level.charAt(0).toUpperCase() + level.slice(1)}`, {
      description: `Anomaly threshold: ${(cfg.anomalyThreshold * 100).toFixed(0)}%`,
    });
  };

  const handleMode = (mode) => {
    if (mode === 'ml' && !isPro) {
      toast.error('AI Enabled mode requires a Pro subscription.', {
        description: 'Upgrade to unlock ML-based detection.',
        action: { label: 'Upgrade', onClick: () => navigate('/subscribe') },
      });
      return;
    }
    setMode(mode);
    toast.success(`Detection mode: ${mode === 'ml' ? 'AI Enabled' : 'Basic'}`);
  };

  const handleUpgrade = () => {
    // Open GPay/UPI deep link with fallback to subscription page
    const upiId = 'vroomie@upi';
    const amount = 700;
    const note = 'Vroomie AI Enabled - Annual';
    const gpayLink = `tez://upi/pay?pa=${upiId}&pn=VroomieAI&am=${amount}&cu=INR&tn=${encodeURIComponent(note)}`;
    try {
      window.location.href = gpayLink;
    } catch {
      navigate('/subscribe');
    }
    // Navigate to subscribe regardless after 1s (UPI app handles intent)
    setTimeout(() => navigate('/subscribe'), 1000);
  };

  const micBadge = {
    granted:  { label: 'Granted', cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
    denied:   { label: 'Denied',  cls: 'bg-red-500/10 text-red-400 border-red-500/20' },
    prompt:   { label: 'Not set', cls: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' },
    unknown:  { label: 'Unknown', cls: 'bg-zinc-700 text-zinc-400 border-zinc-600' },
    checking: { label: '…',       cls: 'bg-zinc-800 text-zinc-500 border-zinc-700' },
  }[micStatus] ?? { label: micStatus, cls: 'bg-zinc-700 text-zinc-400 border-zinc-600' };

  const currentLang = LANGUAGE_OPTIONS.find(l => l.code === language) || LANGUAGE_OPTIONS[0];

  return (
    <div className="max-w-2xl mx-auto pb-16 w-full">

      {/* ── Page Header ──────────────────────────────────────────────────── */}
      <div className="mb-8 px-1">
        <h2 className="text-3xl font-display font-bold text-white tracking-tight mb-1">Settings</h2>
        <p className="text-zinc-500 text-sm">Personalise Vroomie and manage your account.</p>
      </div>

      {/* ══ ACCOUNT ════════════════════════════════════════════════════════ */}
      <SectionHeader title="Account" />
      <SettingsCard>
        <SettingsRow
          icon={User}
          iconColor="text-blue-400"
          title="Signed in as"
          description={user?.email || 'Not signed in'}
          right={null}
        />
        <SettingsRow
          icon={CreditCard}
          iconColor={isPro ? 'text-yellow-400' : 'text-zinc-400'}
          title="Subscription"
          description={isPro ? 'AI Enabled (Pro) — Full access' : 'Free plan — Basic detection only'}
          border={false}
          right={
            isPro ? (
              <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border bg-yellow-500/10 text-yellow-400 border-yellow-500/30">
                <CheckCircle2 className="w-3 h-3" /> ACTIVE
              </span>
            ) : (
              <button
                onClick={handleUpgrade}
                className="flex items-center gap-1 text-xs font-bold px-3 py-1.5 rounded-full bg-yellow-500 text-black hover:bg-yellow-400 transition-colors shadow-lg shadow-yellow-500/20"
              >
                <Zap className="w-3 h-3" /> Upgrade
              </button>
            )
          }
        />
      </SettingsCard>

      {/* ══ SUBSCRIPTION PLANS (Free users) ════════════════════════════════ */}
      {!isPro && (
        <>
          <SectionHeader title="Plans" />
          <SettingsCard>
            <div className="p-5">
              <p className="text-sm text-zinc-400 mb-4">
                Unlock AI-powered engine diagnostics with Vroomie Pro.
              </p>
              <div className="grid grid-cols-2 gap-3 mb-5">
                <div className="border border-yellow-500/30 bg-yellow-500/5 rounded-xl p-3 text-center">
                  <p className="text-xl font-display font-bold text-yellow-400">₹700</p>
                  <p className="text-xs text-zinc-400 mt-0.5">/ year</p>
                  <p className="text-[10px] text-yellow-500/80 mt-1 font-medium">Save 42%</p>
                </div>
                <div className="border border-white/10 bg-white/3 rounded-xl p-3 text-center">
                  <p className="text-xl font-display font-bold text-white">₹100</p>
                  <p className="text-xs text-zinc-400 mt-0.5">/ month</p>
                  <p className="text-[10px] text-zinc-500 mt-1">Billed monthly</p>
                </div>
              </div>
              <button
                onClick={handleUpgrade}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-gradient-to-r from-yellow-500 to-yellow-400 text-black font-bold text-sm hover:from-yellow-400 hover:to-yellow-300 transition-all shadow-lg shadow-yellow-500/20 active:scale-[0.98]"
              >
                <Zap className="w-4 h-4" />
                Upgrade to AI Enabled via GPay / UPI
              </button>
              <p className="text-center text-[10px] text-zinc-600 mt-2">UPI ID: vroomie@upi</p>
            </div>
          </SettingsCard>
        </>
      )}

      {/* ══ PREFERENCES ════════════════════════════════════════════════════ */}
      <SectionHeader title="Preferences" />
      <SettingsCard>
        {/* Language */}
        <div className="relative">
          <SettingsRow
            icon={Languages}
            iconColor="text-purple-400"
            title="Language"
            description={currentLang.name}
            onClick={() => setLangOpen(v => !v)}
            right={<ChevronRight className={`w-4 h-4 text-zinc-500 transition-transform ${langOpen ? 'rotate-90' : ''}`} />}
          />
          {langOpen && (
            <div className="border-t border-white/5 bg-zinc-900/80">
              {LANGUAGE_OPTIONS.map(lang => (
                <button
                  key={lang.code}
                  className={`w-full text-left px-5 py-2.5 text-sm transition-colors flex items-center justify-between ${
                    language === lang.code ? 'text-yellow-400 bg-yellow-500/5' : 'text-zinc-400 hover:text-white hover:bg-white/5'
                  }`}
                  onClick={() => { setLanguage(lang.code); setLangOpen(false); toast.success(`Language set to ${lang.name}`); }}
                >
                  {lang.name}
                  {language === lang.code && <CheckCircle2 className="w-4 h-4" />}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Voice Alerts */}
        <SettingsRow
          icon={Bell}
          iconColor="text-orange-400"
          title="Voice Alerts"
          description="Speak detected issues aloud after each scan"
          border={false}
          right={
            <Toggle
              enabled={voiceAlertsEnabled}
              onChange={(v) => {
                setVoiceAlerts(v);
                toast.success(v ? 'Voice alerts enabled' : 'Voice alerts disabled');
              }}
            />
          }
        />
      </SettingsCard>

      {/* ══ AUDIO & DETECTION ══════════════════════════════════════════════ */}
      <SectionHeader title="Audio & Detection" />
      <SettingsCard>
        {/* Sensitivity */}
        <div className="px-4 py-3.5 border-b border-white/5">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-9 h-9 rounded-xl bg-zinc-800/80 flex items-center justify-center text-emerald-400">
              <Volume2 className="w-4 h-4" />
            </div>
            <div>
              <p className="text-sm font-medium text-white">Detection Sensitivity</p>
              <p className="text-xs text-zinc-500 mt-0.5">Controls anomaly threshold strictness</p>
            </div>
          </div>
          <SegmentedControl
            options={[
              { value: 'low',    label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high',   label: 'High' },
            ]}
            value={sensitivity}
            onChange={handleSensitivity}
          />
          <p className="text-[10px] text-zinc-600 mt-2 ml-0.5">
            {sensitivity === 'low'    && 'Only strong, clear matches trigger alerts. Fewer false positives.'}
            {sensitivity === 'medium' && 'Balanced — recommended for most users.'}
            {sensitivity === 'high'   && 'Catches subtle anomalies earlier. May produce more alerts.'}
          </p>
        </div>

        {/* Detection Mode */}
        <div className="px-4 py-3.5">
          <div className="flex items-center gap-3 mb-3">
            <div className={`w-9 h-9 rounded-xl bg-zinc-800/80 flex items-center justify-center ${isPro ? 'text-cyan-400' : 'text-zinc-500'}`}>
              <Activity className="w-4 h-4" />
            </div>
            <div>
              <p className="text-sm font-medium text-white">Detection Mode</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                {isPro ? 'Switch between basic pattern matching and AI engine' : 'AI mode requires Pro subscription'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <SegmentedControl
              options={[
                { value: 'basic', label: 'Basic' },
                { value: 'ml',    label: '✦ AI Enabled' },
              ]}
              value={detectionMode}
              onChange={handleMode}
              disabled={!isPro && detectionMode !== 'ml'}
            />
            {!isPro && (
              <span className="flex items-center gap-1 text-[10px] text-zinc-600">
                <Lock className="w-3 h-3" /> Pro only
              </span>
            )}
          </div>
        </div>
      </SettingsCard>

      {/* ══ PRIVACY & DATA ═════════════════════════════════════════════════ */}
      <SectionHeader title="Privacy & Data" />
      <SettingsCard>
        {/* Mic status */}
        <SettingsRow
          icon={Mic}
          iconColor="text-red-400"
          title="Microphone Access"
          description="Required for real-time engine audio analysis"
          right={
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${micBadge.cls}`}>
              {micBadge.label}
            </span>
          }
        />

        {/* Save History */}
        <SettingsRow
          icon={History}
          iconColor="text-zinc-400"
          title="Save Scan History"
          description="Store analysis results in your account"
          right={
            <Toggle
              enabled={saveHistory}
              onChange={(v) => {
                setSaveHistory(v);
                toast.success(v ? 'Scan history will be saved' : 'Scan history disabled');
              }}
            />
          }
        />

        {/* Data Collection */}
        <SettingsRow
          icon={Database}
          iconColor="text-zinc-400"
          title="Anonymised Data Sharing"
          description="Help improve Vroomie's AI with anonymised patterns"
          border={false}
          right={
            <Toggle
              enabled={dataCollectionEnabled}
              onChange={(v) => {
                setDataCollection(v);
                toast.success(v ? 'Anonymous sharing enabled' : 'Anonymous sharing disabled');
              }}
            />
          }
        />
      </SettingsCard>

      {/* ══ DEVELOPER OPTIONS ══════════════════════════════════════════════ */}
      <SectionHeader title="Developer Options" />
      <SettingsCard>
        {/* Validation Menu Toggle */}
        <SettingsRow
          icon={Wrench}
          iconColor="text-zinc-400"
          title="Show Validation Bench"
          description="Display 'Validate Audio' QA tool in the sidebar menu"
          border={false}
          right={
            <Toggle
              enabled={showValidationMenu}
              onChange={(v) => {
                setShowValidationMenu(v);
                toast.success(v ? 'Validation bench enabled in menu' : 'Validation bench hidden');
              }}
            />
          }
        />
      </SettingsCard>

      {/* ── Privacy Policy link ───────────────────────────────────────────── */}
      <div className="mb-6 px-1">
        <button
          className="text-xs text-zinc-500 hover:text-zinc-300 underline underline-offset-2 transition-colors"
          onClick={() => window.open('https://vroomie.in/privacy', '_blank')}
        >
          View Privacy Policy →
        </button>
      </div>

      {/* ── Sign Out ─────────────────────────────────────────────────────── */}
      <button
        onClick={handleSignOut}
        disabled={signingOut}
        className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400 font-semibold text-sm border border-red-500/15 transition-all active:scale-[0.98] disabled:opacity-50"
      >
        <LogOut className="w-4 h-4" />
        {signingOut ? 'Signing out…' : 'Sign Out'}
      </button>

      <p className="text-center text-[10px] text-zinc-700 mt-8">Vroomie v1.0 · All settings saved automatically</p>
    </div>
  );
}
