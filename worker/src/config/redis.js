// ============================================================================
// AGENTIE WORKER — REDIS CONNECTION CONFIGURATION (BULLMQ COMPATIBLE)
// ============================================================================

import { Redis } from 'ioredis';
import dotenv from 'dotenv';
dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

export const redisConnection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy(times) {
        // Exponential backoff up to 5 seconds
        const delay = Math.min(times * 200, 5000);
        return delay;
    }
});

redisConnection.on('connect', () => {
    console.log(`🟢 [Worker] Redis connection established (${redisUrl.replace(/\/\/[^@]*@/, '//***@')})`);
});

redisConnection.on('error', (err) => {
    console.warn(`⚠️ [Worker] Redis connection issue: ${err.message}`);
});
