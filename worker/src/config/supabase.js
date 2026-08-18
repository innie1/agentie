// ============================================================================
// AGENTIE WORKER — SUPABASE CLIENT CONFIGURATION
// Connects with Service Role Key for background queue task execution
// ============================================================================

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || 'https://cugaysbdpfzunwwlbfsn.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'mock_service_key';

export const isSupabaseConfigured = Boolean(
    process.env.SUPABASE_SERVICE_ROLE_KEY && 
    process.env.SUPABASE_SERVICE_ROLE_KEY !== 'your_supabase_service_role_key_here'
);

export const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
        autoRefreshToken: false,
        persistSession: false
    }
});

console.log(`📡 [Worker] Supabase client initialized for ${supabaseUrl} (Configured: ${isSupabaseConfigured})`);
