import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import dotenv from 'dotenv';

// Import configs to verify connections
import prisma from './config/db.js';
import redisClient from './config/redis.js';

// Import router plugin & services
import callsRouter from './routes/calls.js';
import { PredictiveEngine } from './services/PredictiveEngine.js';

dotenv.config();

const fastify = Fastify({ 
    logger: {
        level: 'info'
    } 
});

// Register native WebSockets plugin
await fastify.register(fastifyWebsocket);

// CORS hook to allow requests from client origin
fastify.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin) {
        reply.header('Access-Control-Allow-Origin', origin);
    } else {
        reply.header('Access-Control-Allow-Origin', '*');
    }
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (request.method === 'OPTIONS') {
        reply.code(204).send();
        return reply;
    }
});

// Register routes plugin under prefix '/api/v1/calls'
// This will map the WS endpoint to: ws://localhost:3001/api/v1/calls/ws
await fastify.register(callsRouter, { prefix: '/api/v1/calls' });

// Health check endpoint for Swarm container health monitoring
fastify.get('/health', async (request, reply) => {
    try {
        await prisma.$queryRaw`SELECT 1`;
        // ioredis status
        const redisStatus = redisClient.status === 'ready' ? 'UP' : 'DOWN';

        return {
            status: 'alive',
            database: 'UP',
            redis: redisStatus,
            timestamp: new Date()
        };
    } catch (err) {
        reply.code(500);
        return {
            status: 'DOWN',
            error: err.message,
            timestamp: new Date()
        };
    }
});

// Instantiate the Predictive Engine
const predictiveEngine = new PredictiveEngine();

// Startup sequence
const start = async () => {
    try {
        const port = parseInt(process.env.PORT || '3001');
        await fastify.listen({ port: port, host: '0.0.0.0' });
        fastify.log.info(`🚀 Motor do Dialer rodando com sucesso na porta ${port}!`);

        // Start predictive engine background loop
        predictiveEngine.start();
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

// Graceful Shutdown
const shutdown = async (signal) => {
    fastify.log.info(`[Shutdown] Received ${signal}. Teardown initiated...`);
    
    // Stop predictive loop
    predictiveEngine.stop();

    try {
        // Close Fastify server
        await fastify.close();
        fastify.log.info('[Shutdown] Fastify server closed.');
        
        // Disconnect ioredis
        await redisClient.quit();
        fastify.log.info('[Shutdown] ioredis client disconnected.');
        
        // Disconnect Prisma
        await prisma.$disconnect();
        fastify.log.info('[Shutdown] Prisma Postgres disconnected.');

        process.exit(0);
    } catch (err) {
        fastify.log.error('[Shutdown] Error during graceful teardown:', err.message);
        process.exit(1);
    }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
