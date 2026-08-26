-- ============================================================================
-- VROOMIE — "AI ENABLED" DETECTION MODE (Path B) ACCESS CONTROL
-- Backend setup: paid/free flags, admin flag, global unlock, free-tier quota
-- ============================================================================
-- Run ONCE in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
-- Safe to re-run: every statement is idempotent.
--
-- Depends on ethanol_feature_setup.sql having been run first (it creates
-- public.user_roles, public.is_admin() and public.app_features).
--
-- ACCESS MODEL — evaluated in this order by src/services/aiAccessService.js:
--   1. Admin (subscriber_base.is_admin OR user_roles.role='admin')  -> unlimited
--   2. Global unlock flag 'ai_enabled_detection' is ON              -> unlimited
--   3. Paid subscriber (subscriber_base.plan_flag = 'P')            -> unlimited
--   4. Everyone else (plan_flag = 'F')                              -> 10 uses
--
-- SECURITY
--   * plan_flag, is_admin and ai_enabled_uses are PRIVILEGED columns. The
--     pre-existing "Users update own" policy lets a signed-in user UPDATE their
--     own subscriber_base row, which would otherwise let anyone set
--     plan_flag='P' or is_admin=true straight from the browser console. The
--     guard trigger in section 4 reverts any client attempt to change them.
--   * The quota counter is incremented through a SECURITY DEFINER function so
--     the counter can go UP without the column being client-writable.
--   * Email is used ONCE, server-side, to resolve the admin account to its
--     immutable Auth UUID. Authorization thereafter is by UUID + RLS.
-- ============================================================================


-- ── 1. PRIVILEGED COLUMNS ON subscriber_base ────────────────────────────────
ALTER TABLE public.subscriber_base
  ADD COLUMN IF NOT EXISTS plan_flag        CHAR(1)  NOT NULL DEFAULT 'F',
  ADD COLUMN IF NOT EXISTS is_admin         BOOLEAN  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_enabled_uses  INTEGER  NOT NULL DEFAULT 0;

-- 'P' = paid subscription, 'F' = free. Constrained so nothing else can land.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'subscriber_base_plan_flag_chk'
  ) THEN
    ALTER TABLE public.subscriber_base
      ADD CONSTRAINT subscriber_base_plan_flag_chk CHECK (plan_flag IN ('P', 'F'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'subscriber_base_ai_uses_chk'
  ) THEN
    ALTER TABLE public.subscriber_base
      ADD CONSTRAINT subscriber_base_ai_uses_chk CHECK (ai_enabled_uses >= 0);
  END IF;
END $$;

COMMENT ON COLUMN public.subscriber_base.plan_flag IS
  'P = paid subscriber (unlimited AI Enabled), F = free (capped at 10 uses). Server-maintained; never client-writable.';
COMMENT ON COLUMN public.subscriber_base.is_admin IS
  'Mirrors user_roles.role = admin. Grants unlimited AI Enabled and the global unlock control. Never client-writable.';
COMMENT ON COLUMN public.subscriber_base.ai_enabled_uses IS
  'Lifetime count of AI Enabled scans started by this user. Only increments, and only via public.consume_ai_use().';


-- ── 2. KEEP plan_flag DERIVED FROM THE EXISTING PLAN COLUMNS ────────────────
-- plan_flag is a projection of the subscription state the payment flow already
-- writes (plan='pro' + subscription_status='active' + unexpired). Deriving it
-- in the database means a Razorpay/UPI activation cannot forget to set it, and
-- an expiry cannot leave a stale 'P' behind.
CREATE OR REPLACE FUNCTION public.sync_plan_flag()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.plan_flag := CASE
    WHEN NEW.plan = 'pro'
     AND NEW.subscription_status = 'active'
     AND (NEW.expiry_date IS NULL OR NEW.expiry_date > now())
    THEN 'P' ELSE 'F'
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS subscriber_base_sync_plan_flag ON public.subscriber_base;
CREATE TRIGGER subscriber_base_sync_plan_flag
  BEFORE INSERT OR UPDATE OF plan, subscription_status, expiry_date
  ON public.subscriber_base
  FOR EACH ROW EXECUTE FUNCTION public.sync_plan_flag();

-- Backfill every existing row so the flag is correct immediately.
UPDATE public.subscriber_base
SET plan_flag = CASE
  WHEN plan = 'pro'
   AND subscription_status = 'active'
   AND (expiry_date IS NULL OR expiry_date > now())
  THEN 'P' ELSE 'F'
END;


-- ── 3. MIRROR THE ADMIN ROLE ONTO subscriber_base ───────────────────────────
-- user_roles stays the single source of truth for authorization. is_admin here
-- is a convenience projection so one read of subscriber_base answers the whole
-- access question. Both are kept in step by this function.
CREATE OR REPLACE FUNCTION public.sync_admin_flag()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.subscriber_base
  SET is_admin = (NEW.role = 'admin')
  WHERE user_id = NEW.user_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_roles_sync_admin_flag ON public.user_roles;
CREATE TRIGGER user_roles_sync_admin_flag
  AFTER INSERT OR UPDATE OF role ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.sync_admin_flag();

-- Backfill from the existing role table.
UPDATE public.subscriber_base s
SET is_admin = (r.role = 'admin')
FROM public.user_roles r
WHERE r.user_id = s.user_id;


-- ── 4. GUARD: PRIVILEGED COLUMNS ARE NOT CLIENT-WRITABLE ────────────────────
-- The pre-existing "Users update own" policy permits a signed-in user to UPDATE
-- their own row. Without this guard they could set is_admin=true, hand
-- themselves plan_flag='P', or reset ai_enabled_uses to 0 from the browser
-- console. This trigger neutralises all three:
--
--   is_admin        -> always reverted to the stored value
--   ai_enabled_uses -> always reverted, EXCEPT inside consume_ai_use()
--   plan_flag       -> always RE-DERIVED from the subscription columns, so
--                      writing it directly has no effect
--
-- Deliberately NOT guarded: plan, subscription_status, expiry_date. Those are
-- written client-side today by activateSubscription() / startFreeTrial() in
-- src/services/subscriptionService.js, and guarding them would break the
-- payment flow. Because plan_flag is re-derived from them, they carry exactly
-- the exposure they already had before this migration — no more, no less.
--
-- NOTE (pre-existing, unchanged by this migration): a signed-in user can set
-- plan='pro' on their own row and self-grant Pro. Closing that properly means
-- routing activation through a SECURITY DEFINER function that verifies the
-- payment, or restricting these columns to the service role. Out of scope here.
CREATE OR REPLACE FUNCTION public.guard_subscriber_privileged_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only police statements made by an end-user session; service-role and
  -- backend jobs (auth.uid() IS NULL) and admins pass through untouched.
  IF auth.uid() IS NOT NULL AND NOT public.is_admin() THEN
    NEW.is_admin := OLD.is_admin;

    -- consume_ai_use() sets this transaction-local flag before incrementing.
    -- Nothing a client can send sets it: SET LOCAL is not reachable through
    -- PostgREST, and the setting dies with the transaction.
    IF coalesce(current_setting('vroomie.quota_write', true), 'off') <> 'on' THEN
      NEW.ai_enabled_uses := OLD.ai_enabled_uses;
    END IF;

    -- plan_flag is a pure projection: recompute rather than trust the input.
    NEW.plan_flag := CASE
      WHEN NEW.plan = 'pro'
       AND NEW.subscription_status = 'active'
       AND (NEW.expiry_date IS NULL OR NEW.expiry_date > now())
      THEN 'P' ELSE 'F'
    END;
  END IF;
  RETURN NEW;
END;
$$;

-- Named 'zz' so it fires AFTER subscriber_base_sync_plan_flag: PostgreSQL runs
-- same-timing triggers in name order, and this one must have the last word.
DROP TRIGGER IF EXISTS subscriber_base_zz_guard ON public.subscriber_base;
CREATE TRIGGER subscriber_base_zz_guard
  BEFORE UPDATE ON public.subscriber_base
  FOR EACH ROW EXECUTE FUNCTION public.guard_subscriber_privileged_columns();


-- ── 5. QUOTA CONSUMPTION (the only way the counter moves) ───────────────────
-- Returns the row's state AFTER the increment so the client needs one round
-- trip. SECURITY DEFINER lets it write a column the caller cannot write
-- directly; it can only ever increment, and only for the calling user.
CREATE OR REPLACE FUNCTION public.consume_ai_use()
RETURNS TABLE (uses INTEGER, plan_flag CHAR(1), is_admin BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid       UUID := auth.uid();
  v_uses    INTEGER;
  v_flag    CHAR(1);
  v_admin   BOOLEAN;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Transaction-local permission for the guard trigger to let the counter move.
  -- Reverts automatically at commit/rollback; unreachable from a client.
  PERFORM set_config('vroomie.quota_write', 'on', true);

  UPDATE public.subscriber_base s
  SET ai_enabled_uses = s.ai_enabled_uses + 1
  WHERE s.user_id = uid
  RETURNING s.ai_enabled_uses, s.plan_flag, s.is_admin
  INTO v_uses, v_flag, v_admin;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No subscriber record for this account';
  END IF;

  uses := v_uses; plan_flag := v_flag; is_admin := v_admin;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_ai_use() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_ai_use() TO authenticated;

-- Admin-only reset, for support ("give this user their trial back").
CREATE OR REPLACE FUNCTION public.reset_ai_uses(target_user UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  UPDATE public.subscriber_base SET ai_enabled_uses = 0 WHERE user_id = target_user;
END;
$$;

REVOKE ALL ON FUNCTION public.reset_ai_uses(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reset_ai_uses(UUID) TO authenticated;


-- ── 6. GLOBAL UNLOCK FLAG ───────────────────────────────────────────────────
-- When the admin switches this ON, AI Enabled becomes unlimited for EVERY user
-- regardless of plan. Ships OFF. Read policy and admin-only write policy are
-- already defined on app_features by ethanol_feature_setup.sql.
INSERT INTO public.app_features (feature_key, enabled)
VALUES ('ai_enabled_detection', false)
ON CONFLICT (feature_key) DO NOTHING;


-- ── 7. ENSURE THE ADMIN ACCOUNT HAS A SUBSCRIBER ROW + FULL ACCESS ──────────
DO $$
DECLARE
  admin_uuid  UUID;
  admin_email TEXT := 'dg8010@gmail.com';
BEGIN
  SELECT id INTO admin_uuid FROM auth.users WHERE lower(email) = lower(admin_email) LIMIT 1;

  IF admin_uuid IS NULL THEN
    RAISE NOTICE 'No auth account for % yet — sign in once, then re-run this script.', admin_email;
  ELSE
    -- Role table is the source of truth (also fires sync_admin_flag).
    INSERT INTO public.user_roles (user_id, role)
    VALUES (admin_uuid, 'admin')
    ON CONFLICT (user_id) DO UPDATE SET role = 'admin', updated_at = now();

    -- Guarantee a subscriber_base row exists, then grant full access.
    INSERT INTO public.subscriber_base (user_id, email, plan, subscription_status)
    VALUES (admin_uuid, admin_email, 'free', 'inactive')
    ON CONFLICT (user_id) DO NOTHING;

    UPDATE public.subscriber_base
    SET is_admin = true
    WHERE user_id = admin_uuid;

    RAISE NOTICE 'Admin access provisioned for % (%)', admin_email, admin_uuid;
  END IF;
END $$;


-- ── 8. VERIFY ───────────────────────────────────────────────────────────────
-- SELECT email, plan, subscription_status, plan_flag, is_admin, ai_enabled_uses
--   FROM public.subscriber_base ORDER BY is_admin DESC, plan_flag;
-- SELECT * FROM public.app_features WHERE feature_key = 'ai_enabled_detection';

SELECT 'SUCCESS: AI Enabled access control ready (plan_flag, is_admin, quota, global flag)' AS status;
