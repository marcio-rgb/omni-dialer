import prisma from '../config/db.js';
import redisClient from '../config/redis.js';

export function initEventBus(io) {
    console.log('[EventBus] Socket.io Event Bus initialized.');

    io.use((socket, next) => {
        // Authenticate agent connection and extract agentId
        const agentId = socket.handshake.auth?.agentId || socket.handshake.query?.agentId;
        if (!agentId) {
            console.error('[EventBus] Authentication error: agentId missing from handshake');
            return next(new Error('Authentication failed: agentId required'));
        }
        
        socket.agentId = agentId;
        next();
    });

    io.on('connection', async (socket) => {
        const agentId = socket.agentId;
        console.log(`[EventBus] Agent connected: ${agentId} (Socket: ${socket.id})`);

        // Join a private room dedicated to this agent (for targeting incoming calls)
        await socket.join(agentId);

        // Update database and Redis status (defaulting agent to pausa on connection until they declare available)
        try {
            await prisma.users.update({
                where: { id: agentId },
                data: {
                    agent_status: 'pausa',
                    agent_status_reason: 'Connected'
                }
            });
            // Ensure they are not in the idle queue initially
            await redisClient.zRem('dialer:idle_agents', agentId);
        } catch (err) {
            console.error(`[EventBus] Error initializing agent status in DB:`, err.message);
        }

        // Event: Agent updates their status manually
        socket.on('agent.update_status', async (data) => {
            const { status } = data; // 'disponivel', 'pausa', etc.
            if (!status) return;

            console.log(`[EventBus] Agent ${agentId} status change request: ${status}`);

            try {
                // 1. Update in Postgres
                await prisma.users.update({
                    where: { id: agentId },
                    data: {
                        agent_status: status,
                        agent_status_reason: 'User manual state'
                    }
                });

                // 2. Manage in Redis ZSET
                if (status === 'disponivel') {
                    // Add agent to ZSET with current timestamp as score (FIFO/longest idle first)
                    await redisClient.zAdd('dialer:idle_agents', {
                        score: Date.now(),
                        value: agentId
                    });
                    console.log(`[EventBus] Agent ${agentId} added to idle queue ZSET.`);
                } else {
                    // Remove from ZSET if they pause or become busy
                    await redisClient.zRem('dialer:idle_agents', agentId);
                    console.log(`[EventBus] Agent ${agentId} removed from idle queue ZSET.`);
                }

                // Acknowledge change
                socket.emit('agent.status_updated', { status });

            } catch (err) {
                console.error(`[EventBus] Error changing status for agent ${agentId}:`, err.message);
                socket.emit('agent.error', { message: 'Failed to update status' });
            }
        });

        // Event: Client disconnecting
        socket.on('disconnect', async () => {
            console.log(`[EventBus] Agent disconnected: ${agentId} (Socket: ${socket.id})`);
            try {
                // Update agent to pause in Postgres to remove from predictive calculations
                await prisma.users.update({
                    where: { id: agentId },
                    data: {
                        agent_status: 'pausa',
                        agent_status_reason: 'Disconnected'
                    }
                });
                
                // Remove from Redis idle queue ZSET
                await redisClient.zRem('dialer:idle_agents', agentId);
                console.log(`[EventBus] Cleaned up agent ${agentId} from ZSET queue.`);
            } catch (err) {
                console.error(`[EventBus] Error on agent disconnect cleanup for ${agentId}:`, err.message);
            }
        });
    });
}
