import { createClient } from '@supabase/supabase-js';

export function db() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL oder SUPABASE_SERVICE_ROLE_KEY fehlt');
  return createClient(url, key, { auth: { persistSession: false } });
}
