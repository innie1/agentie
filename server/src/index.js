import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { requireAuth } from './lib/authMiddleware.js';
import pluginsRouter, { oauthCallbackHandler } from './routes/plugins.js';
import agentsRouter from './routes/agents.js';
import tasksRouter from './routes/tasks.js';
import skillsRouter from './routes/skills.js';
import routinesRouter from './routes/routines.js';   // NEW
import tokensRouter from './routes/tokens.js';        // NEW
import { cronScheduler } from './services/cronScheduler.js';

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
app.use("/api/routines", requireAuth, routinesRouter);   // NEW
app.use("/api/tokens", requireAuth, tokensRouter);        // NEW

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
});
