// ============================================================================
// AGENTIE BACKEND SERVER ENTRY POINT (SPEC 1, 2, 3, 4)
// ============================================================================

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { apiRouter } from './routes/api.js';
import { cronScheduler } from './services/cronScheduler.js';
import { refreshModelsCatalog } from './services/openRouterService.js';
import { refreshExpiringTokens } from './services/pluginService.js';

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// API Routes
app.use('/api', apiRouter);

// Health Check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        service: 'Agentie Runtime Engine & AI Brain', 
        openrouter_configured: !!process.env.OPENROUTER_API_KEY,
        time: new Date().toISOString() 
    });
});

app.listen(PORT, async () => {
    console.log(`⚡ [Agentie Backend] Running on http://localhost:${PORT}`);
    
    // 1. Initial live model catalog freshness check
    await refreshModelsCatalog();

    // 2. Start background cron scheduler worker
    cronScheduler.start();

    // 3. Periodic background token refresh check (every 5 minutes)
    setInterval(() => {
        refreshExpiringTokens().catch(err => console.error('Token refresh worker error:', err));
    }, 5 * 60 * 1000);
});
