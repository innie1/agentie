// ============================================================================
// AGENTIE RAILWAY WORKER — MAIN ENTRY POINT (SPEC 1, 2, 3)
// Webhook listener (/enqueue) + BullMQ Worker Consumer + Realtime Engine
// ============================================================================

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { enqueueTask, getQueueMetrics } from './queue/taskQueue.js';
import { startAgentWorker } from './worker/agentWorker.js';
import { isSupabaseConfigured } from './config/supabase.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// 1. Health check for Railway deployment checks
app.get('/health', async (req, res) => {
    try {
        const metrics = await getQueueMetrics();
        res.json({
            status: 'ok',
            service: 'Agentie Background Task Worker',
            supabase_configured: isSupabaseConfigured,
            queue_metrics: metrics,
            time: new Date().toISOString()
        });
    } catch (err) {
        res.json({
            status: 'ok',
            service: 'Agentie Background Task Worker',
            supabase_configured: isSupabaseConfigured,
            redis_status: 'connecting',
            time: new Date().toISOString()
        });
    }
});

// 2. Queue health and job inspection
app.get('/metrics', async (req, res) => {
    try {
        const metrics = await getQueueMetrics();
        res.json({ success: true, ...metrics });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3. Webhook endpoint: Supabase Database Webhook (Triggered on INSERT/UPDATE to tasks table)
app.post('/enqueue', async (req, res) => {
    try {
        const body = req.body || {};
        // Handles both direct POST and Supabase Database Webhook payload format
        const record = body.record || body;
        const taskId = record.id || record.taskId;
        const agentId = record.agent_id || record.agentId;
        const userId = record.user_id || record.userId || 'default_user';
        const isResume = Boolean(record.is_resume || body.is_resume || (record.status === 'pending' && record.result_payload?.saved_loop_state));

        if (!taskId) {
            return res.status(400).json({ success: false, error: 'taskId or record.id is required.' });
        }

        const job = await enqueueTask({ taskId, agentId, userId, isResume });
        res.status(202).json({
            success: true,
            message: 'Task successfully enqueued to agent-tasks queue',
            jobId: job.id,
            taskId,
            agentId,
            isResume
        });
    } catch (err) {
        console.error('Enqueue error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. Resume endpoint: Called when user clicks "Approve" in the UI
app.post('/resume', async (req, res) => {
    try {
        const { taskId, agentId, userId } = req.body;
        if (!taskId) {
            return res.status(400).json({ success: false, error: 'taskId is required.' });
        }

        const job = await enqueueTask({ taskId, agentId, userId, isResume: true });
        res.status(202).json({
            success: true,
            message: 'Task resume job enqueued',
            jobId: job.id,
            taskId
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 5. Start Server & BullMQ Worker Consumer
app.listen(PORT, () => {
    console.log(`⚡ [Agentie Worker Service] Listening on http://localhost:${PORT}`);
    
    // Start BullMQ Worker Consumer
    try {
        startAgentWorker();
    } catch (err) {
        console.error('Failed to start worker consumer:', err.message);
    }
});
