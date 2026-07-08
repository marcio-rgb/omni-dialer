import crypto from 'crypto';
import prisma from '../config/db.js';
import redisClient from '../config/redis.js';
import { activeSockets, getOrCreateContact, getOrCreateSystemUser, getOrCreateConversation, cleanPhonePrefix } from '../routes/calls.js';
import { amiService } from './AMIService.js';
import vitalpbxConfig from '../config/vitalpbx.js';

export class PredictiveEngine {
    constructor() {
        this.running = false;
        this.intervalId = null;
        this.cleanupIntervalId = null;
        this.intervalMs = parseInt(process.env.DIALER_INTERVAL_MS || '500');
        
        // Listen to AMI events
        this.setupAmiListeners();

        this.lastSummaryLog = 0;
    }

    /**
     * Starts the predictive dialing loop.
     */
    start() {
        if (this.running) return;
        this.running = true;
        console.log(`[PredictiveEngine] Starting predictive loop (Interval: ${this.intervalMs}ms)...`);
        
        // Connect to AMI
        amiService.connect();
        
        this.intervalId = setInterval(() => this.tick(), this.intervalMs);
        
        // Start cleanup routine every 10 seconds to prune stale dialing calls
        this.cleanupIntervalId = setInterval(() => this.cleanupExpiredDialingCalls(), 10000);
    }

    /**
     * Stops the predictive dialing loop.
     */
    stop() {
        if (!this.running) return;
        this.running = false;
        clearInterval(this.intervalId);
        clearInterval(this.cleanupIntervalId);
        console.log('[PredictiveEngine] Predictive loop stopped.');
    }

    /**
     * Single iteration of the predictive dialer.
     */
    async tick() {
        try {
            // 1. Get Available Agents count from Redis ZSET
            const availableAgents = await redisClient.zcard('dialer:idle_agents');

            // 2. Calculate Success Rate (answered vs total in last X minutes)
            let successRate = await this.calculateSuccessRate();

            // 3. Get Calls in Progress (dialing calls in Redis)
            const callsInProgress = await redisClient.scard('dialer:active_dialing_channels');

            // 4. Calculate Disparos (Overdialing Formula)
            // Disparos = (Agentes Livres / Taxa de Sucesso) - Chamadas em Curso
            const targetCalls = availableAgents / successRate;
            const disparos = Math.floor(targetCalls - callsInProgress);

            const now = Date.now();
            if (now - this.lastSummaryLog > 10000) {
                console.log(`[PredictiveEngine] Loop Status - Available Agents: ${availableAgents}, Success Rate: ${(successRate * 100).toFixed(1)}%, Active Dialing: ${callsInProgress}, Target: ${targetCalls.toFixed(2)}, Calculated Disparos: ${disparos}`);
                this.lastSummaryLog = now;
            }

            if (availableAgents === 0) {
                // If no agents are available, do not dial
                return;
            }

            if (disparos > 0) {
                console.log(`[PredictiveEngine] Tick - Agents: ${availableAgents}, Success Rate: ${(successRate * 100).toFixed(1)}%, Active Dialing: ${callsInProgress}. Triggering ${disparos} disparos.`);
                await this.triggerDialing(disparos);
            }
        } catch (error) {
            console.error('[PredictiveEngine] Error in tick:', error);
        }
    }

    /**
     * Calculates the success rate based on recent call history or Redis override.
     */
    async calculateSuccessRate() {
        // Check for active override penalty
        const overrideRate = await redisClient.get('dialer:inflated_success_rate');
        if (overrideRate) {
            return parseFloat(overrideRate);
        }

        try {
            const windowMinutes = parseInt(process.env.DIALER_SUCCESS_RATE_WINDOW_MINUTES || '5');
            const cutoffDate = new Date(Date.now() - windowMinutes * 60 * 1000);

            // Query Postgres call_history for recent calls
            const totalCalls = await prisma.call_history.count({
                where: {
                    data_inicio: { gte: cutoffDate }
                }
            });

            if (totalCalls === 0) {
                return parseFloat(process.env.DIALER_SUCCESS_RATE_DEFAULT || '0.3');
            }

            const answeredCalls = await prisma.call_history.count({
                where: {
                    data_inicio: { gte: cutoffDate },
                    status: 'Atendida'
                }
            });

            const rate = answeredCalls / totalCalls;

            // Clamp success rate between MIN and MAX
            const minRate = parseFloat(process.env.DIALER_MIN_SUCCESS_RATE || '0.05');
            const maxRate = parseFloat(process.env.DIALER_MAX_SUCCESS_RATE || '1.0');

            return Math.max(minRate, Math.min(maxRate, rate));
        } catch (error) {
            console.error('[PredictiveEngine] Error calculating success rate, using default:', error.message);
            return parseFloat(process.env.DIALER_SUCCESS_RATE_DEFAULT || '0.3');
        }
    }

    /**
     * Core dialer execution. Pops leads and originates calls.
     */
    async triggerDialing(disparos) {
        // Check queue length
        let queueLength = await redisClient.llen('dialer:lead_queue');
        
        // If queue is low, refill it from Postgres
        if (queueLength < disparos) {
            await this.refillLeadQueue();
            queueLength = await redisClient.llen('dialer:lead_queue');
        }

        const countToPop = Math.min(disparos, queueLength);
        if (countToPop <= 0) return;

        for (let i = 0; i < countToPop; i++) {
            const leadStr = await redisClient.lpop('dialer:lead_queue');
            if (!leadStr) break;

            const lead = JSON.parse(leadStr);

            try {
                // Determine prefix and clean phone
                let prefix = '';
                try {
                    const prefixSetting = await prisma.settings.findUnique({
                        where: { key: 'dialer_dial_prefix' }
                    });
                    if (prefixSetting) {
                        prefix = prefixSetting.value || '';
                    }
                } catch (err) {
                    console.error('[PredictiveEngine] Error fetching prefix:', err.message);
                }

                let dialedPhone = lead.phone.replace(/\D/g, '');
                if ((dialedPhone.length === 12 || dialedPhone.length === 13) && dialedPhone.startsWith('55')) {
                    dialedPhone = dialedPhone.substring(2);
                }
                if (prefix && !dialedPhone.startsWith(prefix)) {
                    dialedPhone = prefix + dialedPhone;
                }

                // Dials customer via AMI and routes to triagem-amd context
                const destChannel = `Local/${dialedPhone}@${vitalpbxConfig.context}/n`;
                
                amiService.originateCall(
                    destChannel,
                    'triagem-amd',
                    's',
                    1,
                    {
                        LEAD_ID: String(lead.id),
                        CAMPAIGN_ID: String(lead.campaignId),
                        PHONE: dialedPhone
                    }
                );

                // Cache call details in Redis with a TTL of 60 seconds (ringing timeout fallback)
                // Positional arguments in hset for maximum compatibility
                await redisClient.hset(
                    `dialer:dialing_calls:${lead.id}`,
                    'leadId', String(lead.id),
                    'campaignId', String(lead.campaignId),
                    'phone', lead.phone,
                    'name', lead.name || '',
                    'timestamp', String(Date.now())
                );
                await redisClient.expire(`dialer:dialing_calls:${lead.id}`, 60);

                // Track active dialing channels
                await redisClient.sadd('dialer:active_dialing_channels', String(lead.id));

                // Publish real-time dialing event to Redis PubSub (throttled when overdialing rate is very high)
                this.dialCount = (this.dialCount || 0) + 1;
                const isHighRate = disparos > 5;
                if (!isHighRate || this.dialCount % 3 === 0) {
                    await redisClient.publish('dialer:events', JSON.stringify({
                        phone: lead.phone,
                        status: 'chamando',
                        label: 'Chamando',
                        operator: '',
                        time: '00:00'
                    }));
                }
            } catch (err) {
                console.error(`[PredictiveEngine] Failed to originate call for Lead ${lead.id}:`, err.message);
                // Return lead to front of the queue to avoid loss
                await redisClient.lpush('dialer:lead_queue', JSON.stringify(lead));
            }
        }
    }

    /**
     * Refills the Redis lead queue with undialed leads from active campaigns in Postgres.
     */
    async refillLeadQueue() {
        console.log('[PredictiveEngine] Refilling lead queue from Postgres...');
        try {
            // Find active predictive campaigns
            const activeCampaigns = await prisma.campaign.findMany({
                where: { dialingMode: 'predictive' },
                select: { id: true }
            });

            if (activeCampaigns.length === 0) {
                console.log('[PredictiveEngine] No active predictive campaigns found.');
                return;
            }

            const activeCampaignIds = activeCampaigns.map(c => c.id);

            // Fetch already dialed leads from Redis
            const dialedLeads = await redisClient.smembers('dialer:dialed_leads');
            const dialedLeadIds = dialedLeads.map(id => parseInt(id)).filter(id => !isNaN(id));

            console.log(`[PredictiveEngine] Refill Info - Active Campaigns: ${JSON.stringify(activeCampaignIds)}, Dialed Leads Count in Redis: ${dialedLeadIds.length}`);

            // Fetch undialed leads from Postgres
            const leads = await prisma.lead.findMany({
                where: {
                    campaignId: { in: activeCampaignIds },
                    id: dialedLeadIds.length > 0 ? { notIn: dialedLeadIds } : undefined
                },
                take: 100, // Pull 100 leads per refill operation
                orderBy: { id: 'asc' }
            });

            if (leads.length === 0) {
                console.log(`[PredictiveEngine] No new undialed leads found in Postgres for campaigns ${JSON.stringify(activeCampaignIds)}.`);
                return;
            }

            console.log(`[PredictiveEngine] Found ${leads.length} undialed leads. Pushing to Redis queue.`);

            for (const lead of leads) {
                const phone = lead.phone1 || lead.phone2 || lead.phone3;
                if (!phone) continue;

                // 1. Check blacklist in Redis
                const cleanedPhone = phone.replace(/\D/g, '');
                const isBlacklisted = await redisClient.sismember('dialer:blacklisted_phones', cleanedPhone);
                if (isBlacklisted) {
                    console.log(`[PredictiveEngine] Skip blacklisted phone: ${phone}`);
                    continue;
                }

                // 2. Check cooldown in Redis (BreakTime/Agendamento)
                const onCooldown = await redisClient.exists(`dialer:lead_cooldown:${lead.id}`);
                if (onCooldown) {
                    console.log(`[PredictiveEngine] Skip lead on cooldown: ${lead.id}`);
                    continue;
                }

                const leadPayload = {
                    id: lead.id,
                    name: lead.name,
                    phone: phone,
                    campaignId: lead.campaignId
                };

                // Add to queue
                await redisClient.rpush('dialer:lead_queue', JSON.stringify(leadPayload));
                // Mark as dialed/queued to prevent duplicate fetches
                await redisClient.sadd('dialer:dialed_leads', String(lead.id));
            }
        } catch (error) {
            console.error('[PredictiveEngine] Error refilling lead queue:', error.message);
        }
    }

    /**
     * Cleans up expired dialing channels from the tracking set.
     */
    async cleanupExpiredDialingCalls() {
        try {
            const leads = await redisClient.smembers('dialer:active_dialing_channels');
            const now = Date.now();
            for (const leadId of leads) {
                const callData = await redisClient.hgetall(`dialer:dialing_calls:${leadId}`);
                if (!callData || !callData.timestamp || !callData.phone) {
                    await redisClient.srem('dialer:active_dialing_channels', leadId);
                    continue;
                }

                const elapsed = now - parseInt(callData.timestamp);
                if (elapsed > 45000) {
                    console.log(`[PredictiveEngine] Lead ${leadId} timed out (${elapsed}ms). Cleaning up.`);
                    
                    // Publish failed event to Redis PubSub
                    await redisClient.publish('dialer:events', JSON.stringify({
                        phone: callData.phone,
                        status: 'falha',
                        label: 'Falha',
                        operator: '',
                        time: '00:00'
                    })).catch(() => {});

                    await redisClient.srem('dialer:active_dialing_channels', leadId);
                    await redisClient.del(`dialer:dialing_calls:${leadId}`);
                }
            }
        } catch (error) {
            console.error('[PredictiveEngine] Error in cleanup expired dialing calls:', error.message);
        }
    }

    /**
     * Set up listeners for Asterisk AMI events.
     */
    setupAmiListeners() {
        amiService.on('UserEvent', async (event) => {
            if (event.UserEvent === 'PredictiveHuman') {
                const { Channel, ChannelId, Phone, LeadId, CampaignId } = event;
                const channelName = Channel || ChannelId || event.Channelid;
                const cleanPhone = await cleanPhonePrefix(Phone);
                console.log(`[PredictiveEngine] AMI UserEvent PredictiveHuman received. Channel: ${channelName}, Phone: ${cleanPhone}, Lead: ${LeadId}`);
                
                try {
                    // Try to pop an available agent
                    const popped = await redisClient.zpopmin('dialer:idle_agents', 1);
                    let agentId = null;
                    if (popped && popped.length > 0) {
                        agentId = popped[0];
                    }
 
                    if (!agentId) {
                        console.warn(`[PredictiveEngine] No agents available for answered call on channel ${channelName}. Hanging up.`);
                        // Hang up the call
                        amiService.hangupCall(channelName);
 
                        // Save call in call_history as "Abandono"
                        const contact = await getOrCreateContact(cleanPhone, LeadId);
                        const systemUser = await getOrCreateSystemUser();
                        await prisma.call_history.create({
                            data: {
                                cliente_id: contact.id,
                                agente_id: systemUser.id,
                                status: 'Abandono',
                                duracao: 0,
                                data_inicio: new Date()
                            }
                        });
 
                        // Clean up dialing tracking in Redis
                        await redisClient.srem('dialer:active_dialing_channels', LeadId);
                        await redisClient.del(`dialer:dialing_calls:${LeadId}`);
 
                        // Inflate success rate in Redis temporarily to freeze dialer
                        await redisClient.set('dialer:inflated_success_rate', '1.0', 'EX', 30);
                        return;
                    }
 
                    // --- CONNECTING CALL TO AGENT ---
                    console.log(`[PredictiveEngine] Assigning call on channel ${channelName} to Agent ${agentId}`);
                    
                    // 1. Update agent status in Postgres to ocupado
                    const agent = await prisma.users.update({
                        where: { id: agentId },
                        data: {
                            agent_status: 'ocupado',
                            agent_status_reason: 'In Call'
                        }
                    });
 
                    // 2. Get or create Contact
                    const contact = await getOrCreateContact(cleanPhone, LeadId);
 
                    // 3. Find or create Open Conversation
                    const conversation = await getOrCreateConversation(contact, agentId, cleanPhone);
 
                    // 4. Create active call record in DB calls table
                    const callId = crypto.randomUUID();
                    const roomName = `sala_agente_${agentId}`;
                    
                    // Clean up any old call with the same room_name to prevent unique constraint violation
                    try {
                        await prisma.calls.deleteMany({
                            where: { room_name: roomName }
                        });
                    } catch (delErr) {
                        console.error(`[PredictiveEngine] Error deleting old call for room ${roomName}:`, delErr.message);
                    }

                    await prisma.calls.create({
                        data: {
                            id: callId,
                            conversation_id: conversation.id,
                            room_name: roomName,
                            status: 'active',
                            agent_id: agentId
                        }
                    });
 
                    // 5. Emit agent.incoming_call event via active WebSocket to pop CRM data
                    const agentSocket = activeSockets.get(agentId);
                    if (agentSocket && agentSocket.readyState === 1 /* OPEN */) {
                        console.log(`[PredictiveEngine] Emitting incoming call CRM data to Agent ${agentId} via WebSocket`);
                        agentSocket.send(JSON.stringify({
                            event: 'agent.incoming_call',
                            data: {
                                token: null,
                                room_name: roomName,
                                cpf: contact.cpf || null,
                                name: contact.name,
                                phone: cleanPhone
                            }
                        }));
                    }
 
                    // 6. Redirect the customer's channel to the agent's room in Asterisk dialplan
                    amiService.setVariable(channelName, 'AGENT_ROOM', roomName);
                    amiService.redirectCall(channelName, 'cos-all-custom', '9999', 1);

                    // 7. Save call in call_history as "Atendida"
                    await prisma.call_history.create({
                        data: {
                            cliente_id: contact.id,
                            agente_id: agentId,
                            status: 'Atendida',
                            duracao: 0,
                            data_inicio: new Date()
                        }
                    });

                    // 8. Publish real-time answered call event to Redis PubSub
                    await redisClient.publish('dialer:events', JSON.stringify({
                        phone: Phone,
                        status: 'atendida',
                        label: 'Atendida',
                        operator: agent.name || `Agente ${agentId}`,
                        time: '00:00'
                    })).catch(() => {});

                    // 9. Remove from Redis active dialing sets
                    await redisClient.srem('dialer:active_dialing_channels', LeadId);
                    await redisClient.del(`dialer:dialing_calls:${LeadId}`);

                } catch (err) {
                    console.error('[PredictiveEngine] Error handling PredictiveHuman event:', err);
                }
            }
        });
    }
}
