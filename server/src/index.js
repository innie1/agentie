import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { requireAuth } from './lib/authMiddleware.js';
import pluginsRouter, { oauthCallbackHandler } from './routes/plugins.js';
import agentsRouter from './routes/agents.js';
import tasksRouter from './routes/tasks.js';
import skillsRouter from './routes/skills.js';
import routinesRouter from './routes/routines.js';
import tokensRouter from './routes/tokens.js';
import systemRouter from './routes/system.js';           // NEW
import { cronScheduler } from './services/cronScheduler.js';
import { refreshModelsCatalog } from './services/modelCatalogService.js'; // NEW

const app = express();
const PORT = process.env.PORT || process.env.SERVER_PORT || 4000;

app.use(cors());
app.use(express.json());

// OAuth callback must NOT require auth — provider redirects browser directly here
app.get("/api/plugins/callback", oauthCallbackHandler);

// Mounted API Routes
app.use("/api/plugins", requireAuth, pluginsRouter);
app.use("/api/agents", requireAuth, agentsRouter);
app.use("/api/tasks", requireAuth, tasksRouter);
app.use("/api/skills", requireAuth, skillsRouter);
app.use("/api/routines", requireAuth, routinesRouter);
app.use("/api/tokens", requireAuth, tokensRouter);
app.use("/api/system", requireAuth, systemRouter);        // NEW

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

    // Start background cron scheduler worker
    cronScheduler.start();

    // Pull a fresh model catalog on boot, then every 12 hours — keeps
    // fast/reasoning model IDs current instead of stuck on a hardcoded value.
    await refreshModelsCatalog();
    setInterval(() => {
        refreshModelsCatalog().catch((err) => console.error('[modelCatalog] periodic refresh failed:', err.message));
    }, 12 * 60 * 60 * 1000);
});
