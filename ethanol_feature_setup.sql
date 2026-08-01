-- ============================================================================
-- VROOMIE — ETHANOL CONTAMINATION CHECK
-- Backend setup: role-based access control + global feature flag
-- ============================================================================
-- Run ONCE in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Safe to re-run: every statement is idempotent.
--
-- SECURITY MODEL
--   * Roles live in public.user_roles, keyed by auth.users(id) — the immutable
--     Auth UUID, never an email string.
--   * Email is used ONCE below to RESOLVE which existing account receives the
--     admin role. Authorization thereafter is by UUID + server-side RLS.
--   * Every new account defaults to 'user' via trigger. Never 'admin'.
--   * Normal users can READ the feature flag (needed to render) but CANNOT
--     write it. Only admins can write. Enforced by RLS, not by the frontend.
-- ============================================================================

-- ── 1. ROLES ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- SECURITY DEFINER helper: lets policies check "am I an admin?" without the
-- policy re-querying user_roles (which would recurse infinitely).
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'admin'
  );
$$;

DROP POLICY IF EXISTS "read own role" ON public.user_roles;
CREATE POLICY "read own role" ON public.user_roles
  FOR SELECT USING (auth.uid() = user_id);

-- Deliberately NO insert/update/delete policy for normal users:
-- nobody can grant themselves a role from the client. Role changes are made
-- by an administrator through the SQL editor or a service-role backend.
DROP POLICY IF EXISTS "admins read all roles" ON public.user_roles;
CREATE POLICY "admins read all roles" ON public.user_roles
  FOR SELECT USING (public.is_admin());

-- ── 2. DEFAULT EVERY NEW ACCOUNT TO 'user' ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'user')
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_set_role ON auth.users;
CREATE TRIGGER on_auth_user_created_set_role
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_role();

-- Backfill: every EXISTING account becomes 'user' (admin assigned in step 4).
INSERT INTO public.user_roles (user_id, role)
SELECT id, 'user' FROM auth.users
ON CONFLICT (user_id) DO NOTHING;

-- ── 3. GLOBAL FEATURE FLAGS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.app_features (
  feature_key TEXT PRIMARY KEY,
  enabled     BOOLEAN NOT NULL DEFAULT false,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID REFERENCES auth.users(id)
);

ALTER TABLE public.app_features ENABLE ROW LEVEL SECURITY;

-- Ships DISABLED: enabling is an explicit admin action.
INSERT INTO public.app_features (feature_key, enabled)
VALUES ('ethanol_contamination_check', false)
ON CONFLICT (feature_key) DO NOTHING;

-- Anyone (incl. anonymous/guest sessions) may READ the flag so the UI can
-- render correctly; nobody but an admin may change it.
DROP POLICY IF EXISTS "feature flags readable" ON public.app_features;
CREATE POLICY "feature flags readable" ON public.app_features
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "only admins update features" ON public.app_features;
CREATE POLICY "only admins update features" ON public.app_features
  FOR UPDATE USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "only admins insert features" ON public.app_features;
CREATE POLICY "only admins insert features" ON public.app_features
  FOR INSERT WITH CHECK (public.is_admin());

-- Keep updated_at / updated_by honest regardless of what the client sends.
CREATE OR REPLACE FUNCTION public.touch_app_features()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS app_features_touch ON public.app_features;
CREATE TRIGGER app_features_touch
  BEFORE UPDATE ON public.app_features
  FOR EACH ROW EXECUTE FUNCTION public.touch_app_features();

-- ── 4. ASSIGN THE INITIAL, SOLE ADMINISTRATOR ───────────────────────────────
-- Resolves the email to its immutable Auth UUID. If the account does not exist
-- yet, sign in with it once and re-run this block.
DO $$
DECLARE
  admin_uuid UUID;
BEGIN
  SELECT id INTO admin_uuid FROM auth.users WHERE lower(email) = lower('dg8010@gmail.com') LIMIT 1;

  IF admin_uuid IS NULL THEN
    RAISE NOTICE 'No auth account for dg8010@gmail.com yet — sign in once, then re-run this script.';
  ELSE
    INSERT INTO public.user_roles (user_id, role)
    VALUES (admin_uuid, 'admin')
    ON CONFLICT (user_id) DO UPDATE SET role = 'admin', updated_at = now();

    -- Enforce SOLE administrator: demote anyone else holding admin.
    UPDATE public.user_roles SET role = 'user', updated_at = now()
    WHERE role = 'admin' AND user_id <> admin_uuid;

    RAISE NOTICE 'Admin role assigned to %', admin_uuid;
  END IF;
END $$;

-- ── 5. VERIFY ───────────────────────────────────────────────────────────────
-- SELECT u.email, r.role FROM public.user_roles r JOIN auth.users u ON u.id = r.user_id ORDER BY r.role;
-- SELECT * FROM public.app_features;
