/**
 * qa_ai_enabled.mjs — acceptance tests for the AI Enabled (Path B) entitlement
 * AND for the integrity of the Basic path it must not disturb.
 *
 * Two halves, both mandatory:
 *
 *   PART 1  ENTITLEMENT   the precedence matrix, quota boundaries and fail-safe
 *                         behaviour, executed against the real policy module.
 *   PART 2  BASIC PATH    proof that the detection pipeline Basic runs is
 *                         byte-identical to the last measured build.
 *
 * Part 2 is the one that matters most: every constant asserted here was
 * calibrated on held-out data, and a silent change to any of them invalidates
 * the measured false-positive and recall figures.
 *
 * Usage: node scripts/qa_ai_enabled.mjs   (exit 0 = all pass)
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  resolveAiAccess,
  applyConsumedUse,
  lockedOut,
  describeAiAccess,
  FREE_AI_USE_LIMIT,
  FEATURE_AI_DETECTION,
  GRANT_ADMIN,
  GRANT_GLOBAL,
  GRANT_PAID,
  GRANT_FREE,
  GRANT_NONE,
} from '../src/services/aiAccessPolicy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Row builders — mirror exactly what subscriber_base returns.
const admin  = (uses = 0) => ({ plan_flag: 'F', is_admin: true,  ai_enabled_uses: uses });
const paid   = (uses = 0) => ({ plan_flag: 'P', is_admin: false, ai_enabled_uses: uses });
const free   = (uses = 0) => ({ plan_flag: 'F', is_admin: false, ai_enabled_uses: uses });

// ════════════════════════════════════════════════════════════════════════════
// PART 1 — ENTITLEMENT
// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ PART 1 — AI ENABLED ENTITLEMENT ══\n');
console.log('── Precedence matrix ──');

{
  const a = resolveAiAccess(admin(), false);
  check('admin gets unlimited', a.allowed && a.unlimited && a.grant === GRANT_ADMIN);
}
{
  // Admin outranks everything, including a spent free quota.
  const a = resolveAiAccess(admin(999), false);
  check('admin outranks an exhausted quota',
    a.allowed && a.unlimited && a.grant === GRANT_ADMIN, `used=${a.used}`);
}
{
  const a = resolveAiAccess(free(), true);
  check('global unlock gives a free user unlimited',
    a.allowed && a.unlimited && a.grant === GRANT_GLOBAL);
}
{
  const a = resolveAiAccess(free(FREE_AI_USE_LIMIT + 5), true);
  check('global unlock overrides an exhausted quota',
    a.allowed && a.unlimited && a.grant === GRANT_GLOBAL);
}
{
  const a = resolveAiAccess(paid(), false);
  check('paid subscriber gets unlimited',
    a.allowed && a.unlimited && a.grant === GRANT_PAID && a.isPaid);
}
{
  const a = resolveAiAccess(paid(500), false);
  check('paid subscriber ignores the counter entirely',
    a.allowed && a.unlimited && a.remaining === Infinity);
}
{
  const a = resolveAiAccess(free(), false);
  check('fresh free user gets the full allowance',
    a.allowed && !a.unlimited && a.grant === GRANT_FREE
      && a.remaining === FREE_AI_USE_LIMIT && a.limit === FREE_AI_USE_LIMIT);
}
{
  // Ordering proof: admin must beat paid, and global must beat paid.
  const adminAndPaid = resolveAiAccess({ plan_flag: 'P', is_admin: true, ai_enabled_uses: 0 }, true);
  check('admin wins when every grant applies at once',
    adminAndPaid.grant === GRANT_ADMIN);
  const globalAndPaid = resolveAiAccess(paid(), true);
  check('global wins over paid when both apply', globalAndPaid.grant === GRANT_GLOBAL);
}

console.log('\n── Free-tier quota boundaries ──');

for (const [used, wantRemaining, wantAllowed] of [
  [0, 10, true], [1, 9, true], [5, 5, true], [9, 1, true],
  [10, 0, false], [11, 0, false], [99, 0, false],
]) {
  const a = resolveAiAccess(free(used), false);
  check(`used=${String(used).padStart(2)} -> remaining=${wantRemaining}, allowed=${wantAllowed}`,
    a.remaining === wantRemaining && a.allowed === wantAllowed,
    `got remaining=${a.remaining} allowed=${a.allowed}`);
}
{
  const a = resolveAiAccess(free(FREE_AI_USE_LIMIT), false);
  check('exhausted free user reports GRANT_NONE', a.grant === GRANT_NONE);
  check('remaining never goes negative', a.remaining >= 0);
}
{
  // The 10th scan must be allowed; the 11th must not.
  const tenth = resolveAiAccess(free(FREE_AI_USE_LIMIT - 1), false);
  const after = applyConsumedUse(tenth, FREE_AI_USE_LIMIT);
  check('the 10th scan is permitted', tenth.allowed && tenth.remaining === 1);
  check('after the 10th, access closes', !after.allowed && after.remaining === 0);
  check('after the 10th, grant flips to none', after.grant === GRANT_NONE);
}

console.log('\n── Fail-safe behaviour ──');

{
  const a = resolveAiAccess(null, false);
  check('null row (missing/unreadable) locks out', !a.allowed && !a.unlimited);
  check('null row reports the quota as spent', a.remaining === 0 && a.used === FREE_AI_USE_LIMIT);
  check('null row is never admin or paid', !a.isAdmin && !a.isPaid);
}
{
  // A lookup failure must not be rescued by the global flag either.
  const a = resolveAiAccess(null, true);
  check('null row stays locked even when the global flag is ON', !a.allowed);
}
{
  const l = lockedOut();
  check('lockedOut() is never unlimited', !l.unlimited && !l.allowed);
}
{
  // Malformed counters must degrade toward LESS access, never more.
  const cases = [undefined, null, NaN, -5, 'many', Infinity];
  let safe = true;
  for (const v of cases) {
    const a = resolveAiAccess({ plan_flag: 'F', is_admin: false, ai_enabled_uses: v }, false);
    if (a.unlimited || a.remaining > FREE_AI_USE_LIMIT) safe = false;
  }
  check('malformed counters never yield unlimited or an inflated balance', safe);
}
{
  // Only the literal 'P' is paid. Anything else is free.
  let safe = true;
  for (const v of ['p', 'PAID', 'pro', '', null, undefined, 1, true]) {
    const a = resolveAiAccess({ plan_flag: v, is_admin: false, ai_enabled_uses: 0 }, false);
    if (a.isPaid || a.grant === GRANT_PAID) safe = false;
  }
  check("only the exact flag 'P' grants paid access", safe);
}
{
  // Only boolean true is admin — no truthy coercion.
  let safe = true;
  for (const v of ['true', 1, 'yes', {}, []]) {
    const a = resolveAiAccess({ plan_flag: 'F', is_admin: v, ai_enabled_uses: 0 }, false);
    if (a.isAdmin || a.grant === GRANT_ADMIN) safe = false;
  }
  check('only boolean true grants admin (no truthy coercion)', safe);
  // Same for the global flag.
  const g = resolveAiAccess(free(), 'true');
  check('only boolean true activates the global unlock', g.grant !== GRANT_GLOBAL);
}

console.log('\n── User-facing wording ──');

check('admin wording', describeAiAccess(resolveAiAccess(admin(), false)).includes('Administrator'));
check('global wording', describeAiAccess(resolveAiAccess(free(), true)).includes('everyone'));
check('paid wording', describeAiAccess(resolveAiAccess(paid(), false)).includes('Pro subscription'));
check('free wording states the balance',
  describeAiAccess(resolveAiAccess(free(3), false)) === `Free plan — 7 of 10 AI Enabled scans left`);
check('exhausted wording states the trial is spent',
  describeAiAccess(resolveAiAccess(free(10), false)).includes('used up'));
check('no entitlement object yields a sign-in prompt',
  describeAiAccess(null).includes('Sign in'));

// ════════════════════════════════════════════════════════════════════════════
// PART 2 — BASIC PATH INTEGRITY
// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ PART 2 — BASIC PATH MUST BE UNCHANGED ══\n');
console.log('── Engine files carry no diff from the last measured build ──');

// 5624472 is the v9.8 commit whose figures (155/162 sim-acoustic, 9/140 healthy
// FP, bit-identical held-out matrix) the product currently claims.
const MEASURED_BASELINE = '5624472';
const ENGINE_FILES = [
  'src/lib/mlEmbeddingEngine.js',
  'src/lib/audioMatchingEngine.js',
  'src/lib/detectionMode.js',
  'src/store/settingsStore.js',
  'public/fingerprints_v9.json',
];

let gitAvailable = true;
try {
  execSync(`git -C ${ROOT} rev-parse ${MEASURED_BASELINE}`, { stdio: 'pipe' });
} catch {
  gitAvailable = false;
}

if (gitAvailable) {
  for (const f of ENGINE_FILES) {
    let diff = '';
    try {
      diff = execSync(`git -C ${ROOT} diff ${MEASURED_BASELINE} -- ${f}`, { encoding: 'utf8' });
    } catch { diff = 'ERROR'; }
    check(`${f} unchanged since ${MEASURED_BASELINE}`, diff === '',
      diff === '' ? '' : `${diff.split('\n').length} diff lines`);
  }
} else {
  check(`baseline commit ${MEASURED_BASELINE} reachable for diff proof`, false,
    'shallow clone — run with full history');
}

console.log('\n── Calibrated constants still hold their measured values ──');

const engine = read('src/lib/mlEmbeddingEngine.js');
check('ANOMALY_THRESHOLD is 0.45', /const ANOMALY_THRESHOLD = 0\.45;/.test(engine));
check('ANCHOR_MARGIN is 0.04', /const ANCHOR_MARGIN = 0\.04;/.test(engine));
check('VEHICLE_SCORE_FLOOR is 0.03', /const VEHICLE_SCORE_FLOOR = 0\.03;/.test(engine));
check('GENERIC_INTERFERER_CEILING is 0.15', /const GENERIC_INTERFERER_CEILING = 0\.15;/.test(engine));
check('marginToConfidence maps 0.70..0.97',
  /Math\.max\(0\.70,\s*Math\.min\(0\.97,\s*0\.70 \+ 1\.08 \* \(margin - ANCHOR_MARGIN\)\)\)/.test(engine));

const recorder = read('src/components/predictive/AudioRecorder.jsx');
check('SESSION_FRACTION is 0.45', /const SESSION_FRACTION = 0\.45;/.test(recorder));
check('SESSION_MIN_ACCEPTED is 3', /const SESSION_MIN_ACCEPTED = 3;/.test(recorder));
check('RECOVERY_TOTAL_FRACTION is 0.60', /const RECOVERY_TOTAL_FRACTION = 0\.60;/.test(recorder));
check('RECOVERY_DOMINANCE is 1.10', /const RECOVERY_DOMINANCE = 1\.10;/.test(recorder));

const extractor = read('src/lib/audioFeatureExtractor.js');
check('capture stays at 16 kHz target', /const TARGET_SR = 16000;/.test(extractor));
check('ScriptProcessor block size still 4096', /const SCRIPT_BUFFER_SIZE = 4096;/.test(extractor));
check('silence RMS gate still 0.005', /if \(rms < 0\.005\)/.test(extractor));
check('rmsNormalize target still 0.05', /rmsNormalize\(pcm16k, 0\.05\)/.test(extractor));
check('classification cadence still ~900 ms', /timeSinceLastClassify >= 900/.test(extractor));
check('capture constraints still disable AEC/NS/AGC',
  /echoCancellation: false, noiseSuppression: false, autoGainControl: false/.test(extractor));

console.log('\n── Basic is never gated, and never consumes quota ──');

check('startExtraction defaults to basic',
  /export async function startExtraction\(callback, mode = 'basic'\)/.test(extractor));
check('mode is normalised — anything not "ml" becomes basic',
  /activeDetectionMode = mode === 'ml' \? 'ml' : 'basic'/.test(extractor));
check('the quota gate fires only for ml',
  /getDetectionMode\(\) === 'ml' && !aiAccess\.allowed/.test(recorder));
check('the counter is consumed only for ml',
  /activeMode === 'ml' && !aiAccess\.unlimited/.test(recorder));
{
  // No gate may key off 'basic' anywhere in the recorder.
  const basicGated = /aiAccess[^\n]*'basic'|'basic'[^\n]*aiAccess/.test(recorder);
  check('no entitlement check is keyed to basic mode', !basicGated);
}
check('mode switching still refuses mid-recording',
  /Cannot switch while recording/.test(recorder));

console.log('\n── Quota is spent on scan start, not on mode selection ──');

{
  // handleModeSwitch must gate but NOT consume; startRecording must consume.
  const switchBody = recorder.slice(
    recorder.indexOf('const handleModeSwitch'),
    recorder.indexOf('const computeSessionOutcome')
  );
  check('selecting a mode never calls consume()', !/aiAccess\.consume\(/.test(switchBody));
  check('selecting AI Enabled still checks entitlement',
    /mode === 'ml' && !aiAccess\.allowed/.test(switchBody));

  const startIdx = recorder.indexOf('const startRecording');
  const startBody = recorder.slice(startIdx, recorder.indexOf('const _startExtractionAsync'));
  check('starting a scan consumes exactly once',
    (startBody.match(/aiAccess\.consume\(/g) || []).length === 1);
  check('a blocked user is stopped before the mic opens',
    startBody.indexOf('!aiAccess.allowed') < startBody.indexOf('startMotionCapture'));
}

console.log('\n── Session decision logic is untouched ──');

check('primary fraction rule intact',
  /if \(e\.hits \/ accepted >= SESSION_FRACTION\)/.test(recorder));
check('recovery fires only when the primary rule confirmed nothing',
  /if \(confirmed\.length === 0 && sessionCandidatesRef\.current\.size > 0\)/.test(recorder));
check('recovery tie-break still ranks by raw similarity sum',
  /b\[1\]\.hits - a\[1\]\.hits \|\| \(b\[1\]\.simSum \|\| 0\) - \(a\[1\]\.simSum \|\| 0\)/.test(recorder));
check('recovery still requires the total-candidate supermajority',
  /totalCandidates \/ accepted >= RECOVERY_TOTAL_FRACTION/.test(recorder));
check('detection mode is recorded on every window',
  /detectionMode: activeDetectionMode/.test(extractor));

// ════════════════════════════════════════════════════════════════════════════
// PART 3 — SERVER-SIDE INVARIANTS (statically verifiable)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ PART 3 — DATABASE INVARIANTS ══\n');

const sql = read('ai_detection_setup.sql');

check('SQL: plan_flag is constrained to P or F',
  /CHECK \(plan_flag IN \('P', 'F'\)\)/.test(sql));
check('SQL: the counter cannot go negative',
  /CHECK \(ai_enabled_uses >= 0\)/.test(sql));
check('SQL: plan_flag is derived from the subscription columns, not supplied',
  /CREATE OR REPLACE FUNCTION public\.sync_plan_flag/.test(sql)
  && /NEW\.plan_flag := CASE/.test(sql));
check('SQL: is_admin mirrors user_roles by trigger',
  /CREATE TRIGGER user_roles_sync_admin_flag/.test(sql));
check('SQL: a client cannot set is_admin',
  /NEW\.is_admin := OLD\.is_admin;/.test(sql));
check('SQL: a client cannot rewind the counter',
  /NEW\.ai_enabled_uses := OLD\.ai_enabled_uses;/.test(sql));
check('SQL: plan_flag is re-derived in the guard rather than trusted',
  /plan_flag is a pure projection: recompute rather than trust the input/.test(sql));
check('SQL: the guard exempts service-role callers only via auth.uid() IS NULL',
  /IF auth\.uid\(\) IS NOT NULL AND NOT public\.is_admin\(\) THEN/.test(sql));
check('SQL: the guard trigger fires after the derive trigger (name ordering)',
  sql.indexOf('CREATE TRIGGER subscriber_base_sync_plan_flag')
    < sql.indexOf('CREATE TRIGGER subscriber_base_zz_guard'));
check('SQL: the counter moves only inside a SECURITY DEFINER function',
  /CREATE OR REPLACE FUNCTION public\.consume_ai_use[\s\S]*?SECURITY DEFINER/.test(sql));
check('SQL: consume_ai_use only ever increments',
  /SET ai_enabled_uses = s\.ai_enabled_uses \+ 1/.test(sql));
check('SQL: consume_ai_use scopes the update to the caller',
  /WHERE s\.user_id = uid/.test(sql));
check('SQL: consume_ai_use rejects anonymous callers',
  /IF uid IS NULL THEN[\s\S]{0,80}RAISE EXCEPTION 'Not authenticated'/.test(sql));
check('SQL: the quota-write escape hatch is transaction-local',
  /set_config\('vroomie\.quota_write', 'on', true\)/.test(sql));
check('SQL: EXECUTE on the counter is revoked from PUBLIC',
  /REVOKE ALL ON FUNCTION public\.consume_ai_use\(\) FROM PUBLIC/.test(sql));
check('SQL: reset is admin-only',
  /CREATE OR REPLACE FUNCTION public\.reset_ai_uses[\s\S]*?IF NOT public\.is_admin\(\) THEN[\s\S]{0,60}RAISE EXCEPTION 'Not authorized'/.test(sql));
check('SQL: the global flag ships OFF',
  /VALUES \('ai_enabled_detection', false\)/.test(sql));
check('SQL: the admin account is resolved by email once, then keyed by UUID',
  /SELECT id INTO admin_uuid FROM auth\.users WHERE lower\(email\) = lower\(admin_email\)/.test(sql));
check('SQL: the migration is documented as idempotent',
  /Safe to re-run: every statement is idempotent/.test(sql));
check('policy module and SQL agree on the feature key',
  sql.includes(`'${FEATURE_AI_DETECTION}'`),
  FEATURE_AI_DETECTION);

console.log('\n── Admin control is gated server-side, not by hiding UI ──');

const adminUi = read('src/components/predictive/AiDetectionAdminSetting.jsx');
check('admin card returns null for non-admins', /if \(!isAdmin\) return null;/.test(adminUi));
check('admin card documents that RLS is the real boundary',
  /RLS/.test(adminUi) && /not the security boundary|NOT the security boundary/i.test(adminUi));
check('global toggle requires explicit confirmation', /window\.confirm\(/.test(adminUi));
check('admin write goes through the RLS-protected flag service',
  /setFeatureEnabled\(FEATURE_AI_DETECTION/.test(adminUi));

const settings = read('src/pages/Settings.jsx');
check('Settings gates on the entitlement, not on isPro',
  /mode === 'ml' && !aiAccess\.allowed/.test(settings));
check('Settings never disables the control for Basic',
  /disabled=\{!aiAccess\.allowed && detectionMode !== 'ml'\}/.test(settings));
check('Settings surfaces the entitlement wording',
  /describeAiAccess\(aiAccess\)/.test(settings));

// ── Result ──────────────────────────────────────────────────────────────────
console.log(
  failures === 0
    ? '\nALL AI ENABLED / BASIC QA CHECKS PASSED'
    : `\n${failures} QA CHECK(S) FAILED`
);
process.exit(failures === 0 ? 0 : 1);
