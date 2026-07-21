import redisClient from '../config/redis.js';
import prisma from '../config/db.js';

export class ChannelManager {
    constructor() {
        this.HUMAN_ACTIVE_KEY = 'dialer:active_dialing_channels';
        this.AI_ACTIVE_KEY = 'dialer:ai_active_dialing_channels';
    }

    /**
     * Gets global dialer channel limits from Postgres settings.
     */
    async getSettings() {
        let maxChannels = 60;
        let humanReserved = 10;
        try {
            const dbSettings = await prisma.settings.findMany({
                where: {
                    key: { in: ['dialer_max_channels', 'dialer_human_reserved_channels'] }
                }
            });
            for (const s of dbSettings) {
                if (s.key === 'dialer_max_channels' && s.value) {
                    maxChannels = parseInt(s.value) || 60;
                } else if (s.key === 'dialer_human_reserved_channels' && s.value) {
                    humanReserved = parseInt(s.value) || 10;
                }
            }
        } catch (err) {
            console.error('[ChannelManager] Error fetching channel limits from DB:', err.message);
        }
        return { maxChannels, humanReserved };
    }

    /**
     * Calculates available channel slots for a specific agent type ('human' vs 'ai_agent'/'ia').
     */
    async getAvailableSlots(type = 'human', requestedCount = 1) {
        const { maxChannels, humanReserved } = await this.getSettings();
        const activeHuman = (await redisClient.scard(this.HUMAN_ACTIVE_KEY)) || 0;
        const activeAi = (await redisClient.scard(this.AI_ACTIVE_KEY)) || 0;
        const globalActive = activeHuman + activeAi;
        const totalRemaining = Math.max(0, maxChannels - globalActive);

        if (type === 'ai_agent' || type === 'ia') {
            const maxAiAllowed = Math.max(0, maxChannels - humanReserved);
            const aiRemaining = Math.max(0, maxAiAllowed - activeAi);
            return Math.min(requestedCount, totalRemaining, aiRemaining);
        } else {
            return Math.min(requestedCount, totalRemaining);
        }
    }

    /**
     * Registers a newly placed dialing call channel.
     */
    async trackChannel(type, callId) {
        const key = (type === 'ai_agent' || type === 'ia') ? this.AI_ACTIVE_KEY : this.HUMAN_ACTIVE_KEY;
        await redisClient.sadd(key, callId);
    }

    /**
     * Removes a completed or failed call channel.
     */
    async releaseChannel(callId) {
        await redisClient.srem(this.HUMAN_ACTIVE_KEY, callId);
        await redisClient.srem(this.AI_ACTIVE_KEY, callId);
    }

    /**
     * Returns consolidated active channels for real-time monitoring.
     */
    async getConsolidatedMetrics() {
        const { maxChannels, humanReserved } = await this.getSettings();
        const activeHuman = (await redisClient.scard(this.HUMAN_ACTIVE_KEY)) || 0;
        const activeAi = (await redisClient.scard(this.AI_ACTIVE_KEY)) || 0;

        return {
            maxChannels,
            humanReserved,
            activeHuman,
            activeAi,
            totalActive: activeHuman + activeAi,
            availableHuman: Math.max(0, maxChannels - (activeHuman + activeAi)),
            availableAi: Math.max(0, (maxChannels - humanReserved) - activeAi)
        };
    }
}

export const channelManager = new ChannelManager();
