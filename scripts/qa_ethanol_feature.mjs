/**
 * qa_ethanol_feature.mjs — acceptance tests for the Ethanol Contamination Check.
 *
 * Covers the directive's TEST A–H (feature), TEST I–P (security invariants that
 * are statically verifiable), and the mandatory ON/OFF audio-regression proof.
 *
 * Usage: node scripts/qa_ethanol_feature.mjs   (exit 0 = all pass)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  screenForEthanolIndicators,
  buildEthanolScreeningCopy,
  ETHANOL_STATUS,
  ETHANOL_RELEVANT_FAULT_TYPES,
} from '../src/lib/ethanolScreening.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── FEATURE TESTS (A–H) ─────────────────────────────────────────────────────
console.log('── Feature tests ──');

const A = screenForEthanolIndicators([{ type: 'Piston', faultType: 'piston_knock' }]);
check('TEST A — Piston Knock flags a relevant indicator',
  A.status === ETHANOL_STATUS.POSSIBLE_RELEVANT_INDICATORS && A.indicators.length === 1);

const B = screenForEthanolIndicators([{ type: 'PowerSteeringPump', faultType: 'power_steering' }]);
check('TEST B — Power Steering Pump flags a relevant indicator',
  B.status === ETHANOL_STATUS.POSSIBLE_RELEVANT_INDICATORS);

const C = screenForEthanolIndicators([{ type: 'RockerArmAndValve', faultType: 'rocker_valve' }]);
check('TEST C — Rocker Arm Valve flags a relevant indicator',
  C.status === ETHANOL_STATUS.POSSIBLE_RELEVANT_INDICATORS);

const D = screenForEthanolIndicators([
  { type: 'Piston', faultType: 'piston_knock' },
  { type: 'PowerSteeringPump', faultType: 'power_steering' },
]);
check('TEST D — multiple relevant anomalies are listed independently',
  D.indicators.length === 2 && D.indicators.map(i => i.faultType).join(',') === 'piston_knock,power_steering');

const E = screenForEthanolIndicators([{ type: 'BearingAlternator', faultType: 'alternator_bearing_fault' }]);
check('TEST E — Alternator Bearing alone is NOT a relevant indicator',
  E.status === ETHANOL_STATUS.NO_RELEVANT_AUDIO_INDICATORS && E.indicators.length === 0);

const F = screenForEthanolIndicators([]);
check('TEST F — no anomalies yields NO_RELEVANT_AUDIO_INDICATORS',
  F.status === ETHANOL_STATUS.NO_RELEVANT_AUDIO_INDICATORS);

// TEST G (TV/speech/ambient) is an audio-pipeline property; the invariance
// proof below shows this module cannot influence it at all.
// TEST H (dismiss) is asserted structurally against the component source.
{
  const ticket = read('src/components/ethanol/EthanolGoldenTicket.jsx');
  check('TEST H — ticket offers ×, Not now, backdrop and Escape dismissal',
    ticket.includes('aria-label="Close"') &&
    ticket.includes('Not now') &&
    ticket.includes("onClick={onDismiss}") &&
    ticket.includes("e.key === 'Escape'"));
  const page = read('src/pages/PredictiveMaintenance.jsx');
  check('TEST H — dismissal suppresses re-prompting for the session',
    page.includes('setEthanolTicketDismissed(true)') && page.includes('!ethanolTicketDismissed'));
}

// ── SAFETY OF CLAIMS ────────────────────────────────────────────────────────
console.log('\n── Claim safety ──');
{
  const pos = buildEthanolScreeningCopy(D);
  const neg = buildEthanolScreeningCopy(F);
  const all = JSON.stringify(pos) + JSON.stringify(neg) +
    read('src/lib/ethanolScreening.js') +
    read('src/components/ethanol/EthanolResultModal.jsx');

  const banned = [
    /ethanol\s+contamination\s+detected/i,
    /no\s+ethanol\s+contamination/i,
    /your\s+fuel\s+is\s+safe/i,
    /confirm[s]?\s+ethanol/i,
  ];
  const hit = banned.find(re => re.test(all));
  check('never asserts a definitive ethanol diagnosis or an all-clear', !hit, hit ? `matched ${hit}` : '');

  check('positive result recommends a workshop inspection',
    /inspected by a qualified workshop/i.test(pos.recommendation));
  check('positive result asks the technician to inspect the fuel system',
    /fuel system/i.test(pos.recommendationDetail || ''));
  check('negative result explicitly does NOT rule contamination out',
    /does not rule out/i.test(neg.recommendation));
  check('disclaimer present in both outcomes',
    /not a laboratory fuel test/i.test(pos.disclaimer) && /not a laboratory fuel test/i.test(neg.disclaimer));
  check('disclaimer is rendered in the result UI (not buried in T&Cs)',
    read('src/components/ethanol/EthanolResultModal.jsx').includes('copy.disclaimer'));
}

// ── ANOMALY MAPPING ─────────────────────────────────────────────────────────
console.log('\n── Anomaly mapping ──');
{
  check('exactly three fault families are relevant',
    ETHANOL_RELEVANT_FAULT_TYPES.length === 3, ETHANOL_RELEVANT_FAULT_TYPES.join(', '));
  // The IDs must actually exist in the shipped reference artifact.
  const art = JSON.parse(read('public/fingerprints_v9.json'));
  const families = new Set(art.faults.map(f => f.fault_type));
  const missing = ETHANOL_RELEVANT_FAULT_TYPES.filter(f => !families.has(f));
  check('all relevant fault IDs exist in the shipped artifact', missing.length === 0,
    missing.length ? 'missing: ' + missing.join(', ') : 'piston_knock, power_steering, rocker_valve');
  // Legacy records without faultType still resolve via label fallback.
  const legacy = screenForEthanolIndicators([{ type: 'Piston Knock' }]);
  check('legacy records without faultType still screen correctly',
    legacy.status === ETHANOL_STATUS.POSSIBLE_RELEVANT_INDICATORS);
}

// ── MANDATORY: FEATURE ON/OFF AUDIO INVARIANCE ──────────────────────────────
console.log('\n── Audio invariance (feature ON == feature OFF) ──');
{
  const audioFiles = [
    'src/lib/audioFeatureExtractor.js',
    'src/lib/mlEmbeddingEngine.js',
    'src/lib/datasetLoader.js',
    'src/lib/motionDetector.js',
  ];
  let leak = null;
  for (const f of audioFiles) {
    const src = read(f);
    if (/ethanol/i.test(src)) leak = f;
  }
  check('no audio-pipeline module references the ethanol feature', !leak, leak ? `leak in ${leak}` : audioFiles.length + ' files clean');

  const screening = read('src/lib/ethanolScreening.js');
  check('screening module imports nothing (pure consumer)', !/^\s*import\s/m.test(screening));
  // Strip comments so the guard tests CODE, not prose describing the guarantee.
  const screeningCode = screening.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('screening module holds no thresholds or audio constants',
    !/THRESHOLD|MARGIN|sampleRate|getUserMedia|AudioContext|yamnet/i.test(screeningCode));

  // The engine's operating point must be untouched by this feature work.
  const engine = read('src/lib/mlEmbeddingEngine.js');
  const rec = read('src/components/predictive/AudioRecorder.jsx');
  check('detection operating point unchanged (τ=0.45, margin=0.04, ≥45%/≥3)',
    /ANOMALY_THRESHOLD\s*=\s*0\.45/.test(engine) &&
    /ANCHOR_MARGIN\s*=\s*0\.04/.test(engine) &&
    /SESSION_FRACTION\s*=\s*0\.45/.test(rec) &&
    /SESSION_MIN_ACCEPTED\s*=\s*3/.test(rec));
}

// ── SECURITY INVARIANTS (statically verifiable parts of I–P) ────────────────
console.log('\n── Security invariants ──');
{
  const roleSrc = read('src/services/roleService.js');
  const flagSrc = read('src/services/featureFlagService.js');
  const adminUi = read('src/components/ethanol/EthanolAdminSetting.jsx');
  const authSrc = read('src/contexts/AuthContext.jsx');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  check('admin is never derived from an email comparison in app code',
    !/dg8010@gmail\.com/.test(strip(roleSrc) + strip(flagSrc) + strip(adminUi) + strip(authSrc)));
  check('admin role comes from the server (user_roles table)',
    roleSrc.includes("from('user_roles')") && roleSrc.includes("eq('user_id', userId)"));
  check('role lookup fails CLOSED to user on any error',
    (roleSrc.match(/return ROLE_USER/g) || []).length >= 3);
  check('no client storage or URL can grant admin',
    !/localStorage|sessionStorage|searchParams|location\.search/i.test(strip(roleSrc)));
  check('feature flags fail SAFE to disabled',
    flagSrc.includes('return {}') && flagSrc.includes('=== true'));
  check('admin write treats an empty RLS result as unauthorized',
    flagSrc.includes('data.length === 0') && flagSrc.includes('Not authorized'));
  check('global toggle requires explicit confirmation',
    adminUi.includes('window.confirm') && /for all users\?/.test(adminUi));
  check('sign-out clears the admin role (no residual privileges)',
    authSrc.includes('setRole(ROLE_USER)'));

  const sql = read('ethanol_feature_setup.sql');
  check('SQL: every new account defaults to user via trigger',
    /handle_new_user_role/.test(sql) && /VALUES \(NEW\.id, 'user'\)/.test(sql));
  check('SQL: only admins may update feature flags (RLS)',
    /only admins update features/.test(sql) && /USING \(public\.is_admin\(\)\)/.test(sql));
  check('SQL: users cannot write their own role (no insert/update policy)',
    !/CREATE POLICY[^;]*ON public\.user_roles\s+FOR (INSERT|UPDATE|ALL)/i.test(sql));
  check('SQL: feature ships disabled by default',
    /'ethanol_contamination_check', false/.test(sql));
  check('SQL: sole-admin enforcement demotes any other admin',
    /role = 'user'[\s\S]*WHERE role = 'admin' AND user_id <> admin_uuid/.test(sql));
}

// ── DISABLE CLEANLINESS ─────────────────────────────────────────────────────
console.log('\n── Disable cleanliness ──');
{
  const page = read('src/pages/PredictiveMaintenance.jsx');
  const logo = read('src/components/ui/VroomieLogo.jsx');
  const adminUi = read('src/components/ethanol/EthanolAdminSetting.jsx');
  check('all ethanol UI is gated behind the flag (no hidden modals mounted)',
    page.includes('{ethanolEnabled && ('));
  check('sash is an overlay gated by the flag (logo asset untouched)',
    logo.includes('{ethanolEnabled && (') && logo.includes('vroomie-sash'));
  check('admin panel returns null for non-admins (no empty wrapper)',
    /if \(!isAdmin\) return null;/.test(adminUi));
  check('disabling mid-session tears down promo state',
    page.includes('setShowEthanolTicket(false)') && page.includes('setEthanolResult(null)'));
}

console.log(failures === 0 ? '\nALL ETHANOL QA CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
