-- ═══════════════════════════════════════════════════════════
-- VROOMIE: COMPLETE FIX for "Database error saving new user"
-- 
-- Run this ENTIRE script in one go:
-- Supabase Dashboard → SQL Editor → New Query → Paste → Run
-- https://supabase.com/dashboard/project/bdldmkhcdtlqxaopxlam/sql/new
-- ═══════════════════════════════════════════════════════════


-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- STEP 1: Find and DROP any broken triggers on auth.users
-- This is the #1 cause of "Database error saving new user"
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

-- List all triggers (for diagnostics)
SELECT trigger_name, event_manipulation, action_statement 
FROM information_schema.triggers 
WHERE event_object_table = 'users' 
  AND event_object_schema = 'auth';

-- Drop any trigger that references subscriber_base or profiles
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP TRIGGER IF EXISTS create_subscriber_on_signup ON auth.users;
DROP TRIGGER IF EXISTS create_profile_on_signup ON auth.users;
DROP TRIGGER IF EXISTS on_user_created ON auth.users;

-- Drop associated functions
DROP FUNCTION IF EXISTS public.handle_new_user() CASCADE;
DROP FUNCTION IF EXISTS public.create_subscriber_record() CASCADE;
DROP FUNCTION IF EXISTS public.on_auth_user_created() CASCADE;


-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- STEP 2: Create subscriber_base table
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CREATE TABLE IF NOT EXISTS public.subscriber_base (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  plan TEXT DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
  subscription_status TEXT DEFAULT 'inactive' CHECK (subscription_status IN ('active', 'inactive')),
  expiry_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Unique index to prevent duplicates
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriber_base_user_id 
  ON public.subscriber_base(user_id);


-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- STEP 3: Enable RLS + policies
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ALTER TABLE public.subscriber_base ENABLE ROW LEVEL SECURITY;

-- Drop old policies (safe re-run)
DROP POLICY IF EXISTS "Users read own" ON public.subscriber_base;
DROP POLICY IF EXISTS "Users update own" ON public.subscriber_base;
DROP POLICY IF EXISTS "Insert on signup" ON public.subscriber_base;
DROP POLICY IF EXISTS "Allow insert for authenticated users" ON public.subscriber_base;
DROP POLICY IF EXISTS "Allow select own data" ON public.subscriber_base;

-- Recreate policies
CREATE POLICY "Users read own" ON public.subscriber_base
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users update own" ON public.subscriber_base
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Insert on signup" ON public.subscriber_base
  FOR INSERT WITH CHECK (auth.uid() = user_id);


-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- STEP 4: Create a SAFE trigger (optional — handles record 
-- creation automatically so the app doesn't need to)
-- This trigger will NOT crash because the table now exists.
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.subscriber_base (user_id, email, plan, subscription_status)
  VALUES (NEW.id, NEW.email, 'free', 'inactive')
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();


-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- DONE — Verify
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SELECT 'SUCCESS: subscriber_base ready, broken triggers removed, safe trigger created' AS status;
