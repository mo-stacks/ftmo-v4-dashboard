import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://lsnlthpzwpovzqnektjp.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxzbmx0aHB6d3BvdnpxbmVrdGpwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxMjM4NTcsImV4cCI6MjA5MTY5OTg1N30.gd_HFI9hmYrDcWABcndZ56uCwWoF32DYdNGLmwVD-KM';

// Disable all auth machinery. This dashboard reads public anon-keyed data —
// there's no user login, no session to persist, no token to refresh.
//
// Default createClient() enables auth.autoRefreshToken which uses the
// browser's `navigator.locks` API to coordinate token refresh across tabs.
// When multiple tabs of the dashboard are open, the locks compete and one
// gets aborted with "AbortError: Lock was stolen by another request",
// surfacing as the dashboard's red "Failed to load data" banner.
//
// Disabling these three flags eliminates the lock contention entirely.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});
