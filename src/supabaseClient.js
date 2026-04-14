import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://lsnlthpzwpovzqnektjp.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxzbmx0aHB6d3BvdnpxbmVrdGpwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxMjM4NTcsImV4cCI6MjA5MTY5OTg1N30.gd_HFI9hmYrDcWABcndZ56uCwWoF32DYdNGLmwVD-KM';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
