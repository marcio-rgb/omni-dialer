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
        this.lastMetricsPublish = 0;
        this.aiAgentStatusIntervalId = null;
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

        // Start AI agent status sync daemon every 5 seconds
        this.aiAgentStatusIntervalId = setInterval(() => this.syncAiAgentsStatus(), 5000);
    }

    /**
     * Stops the predictive dialing loop.
     */
    stop() {
        if (!this.running) return;
        this.running = false;
        clearInterval(this.intervalId);
        clearInterval(this.cleanupIntervalId);
        if (this.aiAgentStatusIntervalId) {
            clearInterval(this.aiAgentStatusIntervalId);
        }
        console.log('[PredictiveEngine] Predictive loop stopped.');
    }

    /**
     * Single iteration of the predictive dialer.
     */
    async tick() {
        try {
            const now = Date.now();
            const oneMinuteAgo = now - 60000;

            // 1. Fetch AI agent IDs to distinguish them from WebRTC human agents
            const users = await prisma.users.findMany({
                select: { id: true, role: true }
            });
            this.aiAgentIds = new Set(users.filter(u => u.role === 'ai_agent').map(u => String(u.id)));

            const idleAgents = await redisClient.zrange('dialer:idle_agents', 0, -1);
            let availableAgents = 0;
            for (const id of idleAgents) {
                const isAi = this.aiAgentIds.has(String(id));
                const active = isAi ? 'true' : await redisClient.get(`dialer:agent_webrtc_active:${id}`);
                if (active === 'true') {
                    availableAgents++;
                }
            }

            // 2. Calculate Success Rate (answered vs total in last X minutes)
            let successRate = await this.calculateSuccessRate();

            // Fetch dialer aggressiveness, max channels, vitalpbx_context and vitalpbx_trunk from settings DB
            let aggressiveness = 1.0;
            let maxChannels = 60;
            let pbxContext = vitalpbxConfig.context;
            let pbxTrunk = null;
            let predictiveTrunk = null;
            let useVoskAmd = true;
            let dialerContext = 'triagem-amd';
            try {
                const dbSettings = await prisma.settings.findMany({
                    where: {
                        key: {
                            in: ['dialer_aggressiveness', 'dialer_max_channels', 'vitalpbx_context', 'vitalpbx_trunk', 'dialer_predictive_trunk', 'dialer_use_vosk_amd', 'dialer_context']
                        }
                    }
                });
                for (const s of dbSettings) {
                    if (s.key === 'dialer_aggressiveness' && s.value) {
                        aggressiveness = parseFloat(s.value) || 1.0;
                    } else if (s.key === 'dialer_max_channels' && s.value) {
                        maxChannels = parseInt(s.value) || 60;
                    } else if (s.key === 'vitalpbx_context' && s.value) {
                        pbxContext = s.value;
                    } else if (s.key === 'vitalpbx_trunk' && s.value) {
                        pbxTrunk = s.value;
                    } else if (s.key === 'dialer_predictive_trunk' && s.value) {
                        predictiveTrunk = s.value;
                    } else if (s.key === 'dialer_use_vosk_amd') {
                        useVoskAmd = s.value !== 'false';
                    } else if (s.key === 'dialer_context' && s.value) {
                        dialerContext = s.value;
                    }
                }
            } catch (err) {
                console.error('[PredictiveEngine] Error fetching dialer settings from DB:', err.message);
            }

            // 3. Clean up expired recent dials (older than 60 seconds) in Redis ZSET
            await redisClient.zremrangebyscore('dialer:recent_dials', '-inf', String(oneMinuteAgo));

            // 4. Get Calls placed in the last 60 seconds
            const recentDialsCount = await redisClient.zcount('dialer:recent_dials', String(oneMinuteAgo), String(now)) || 0;

            // 5. Calculate Target Dials to achieve 1 answered call per minute per idle agent
            const targetCalls = Math.ceil((availableAgents / successRate) * aggressiveness);
            const dialsNeeded = Math.max(0, targetCalls - recentDialsCount);

            // 6. Calculate Pacing (Max Disparos per tick to smoothly space calls)
            const ticksInWindow = 60000 / this.intervalMs;
            const maxDialsPerTick = Math.max(1, Math.ceil(targetCalls / ticksInWindow));

            // 7. Get current active concurrent lines and cap disparos by available capacity
            const activeLines = await redisClient.scard('dialer:active_dialing_channels') || 0;
            const availableLines = Math.max(0, maxChannels - activeLines);
            const disparos = Math.min(dialsNeeded, maxDialsPerTick, availableLines);

            if (now - this.lastSummaryLog > 10000) {
                console.log(`[PredictiveEngine] Pacing Loop - Agents: ${availableAgents}, Success Rate: ${(successRate * 100).toFixed(1)}%, Active Lines: ${activeLines}/${maxChannels}, Dials Last Min: ${recentDialsCount}/${targetCalls}, Needed: ${dialsNeeded}, Max/Tick: ${maxDialsPerTick}, Disparos: ${disparos}`);
                this.lastSummaryLog = now;
            }

            // 8. Publish real-time metrics consolidations (throttled to 1s)
            if (now - this.lastMetricsPublish >= 1000) {
                this.lastMetricsPublish = now;
                await this.publishRealtimeMetrics();
            }

            if (availableAgents === 0) {
                return;
            }

            if (disparos > 0) {
                await this.triggerDialing(disparos, pbxContext, predictiveTrunk || pbxTrunk, useVoskAmd, dialerContext);
            }
        } catch (error) {
            console.error('[PredictiveEngine] Error in tick:', error);
        }
    }

    /**
     * Publishes current daily consolidated metrics to Redis Pub/Sub.
     */
    async publishRealtimeMetrics() {
        try {
            const todayStr = new Date().toISOString().split('T')[0];
            const activeLines = await redisClient.scard('dialer:active_dialing_channels') || 0;
            
            const total = parseInt(await redisClient.get(`dialer:stats:${todayStr}:total`) || '0', 10);
            const answered = parseInt(await redisClient.get(`dialer:stats:${todayStr}:answered`) || '0', 10);
            const abandoned = parseInt(await redisClient.get(`dialer:stats:${todayStr}:abandoned`) || '0', 10);
            const productive = parseInt(await redisClient.get(`dialer:stats:${todayStr}:productive`) || '0', 10);

            await redisClient.publish('dialer:metrics_update', JSON.stringify({
                activeLines,
                total,
                answered,
                abandoned,
                productive
            }));
        } catch (err) {
            console.error('[PredictiveEngine] Error publishing real-time metrics:', err.message);
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
            // Load settings from DB with fallback to env variables
            let windowMinutes = parseInt(process.env.DIALER_SUCCESS_RATE_WINDOW_MINUTES || '5');
            let minRate = parseFloat(process.env.DIALER_MIN_SUCCESS_RATE || '0.05');
            let maxRate = parseFloat(process.env.DIALER_MAX_SUCCESS_RATE || '0.20');

            try {
                const dbSettings = await prisma.settings.findMany({
                    where: {
                        key: {
                            in: ['dialer_success_rate_window_minutes', 'dialer_min_success_rate', 'dialer_max_success_rate']
                        }
                    }
                });

                for (const s of dbSettings) {
                    if (s.key === 'dialer_success_rate_window_minutes' && s.value) {
                        windowMinutes = parseInt(s.value);
                    } else if (s.key === 'dialer_min_success_rate' && s.value) {
                        minRate = parseFloat(s.value);
                    } else if (s.key === 'dialer_max_success_rate' && s.value) {
                        maxRate = parseFloat(s.value);
                    }
                }
            } catch (dbErr) {
                console.error('[PredictiveEngine] Error loading success rate parameters from DB:', dbErr.message);
            }

            const cutoffDate = new Date(Date.now() - windowMinutes * 60 * 1000);

            // Query Postgres call_history for recent calls
            const totalCalls = await prisma.call_history.count({
                where: {
                    data_inicio: { gte: cutoffDate }
                }
            });

            if (totalCalls === 0) {
                return parseFloat(process.env.DIALER_SUCCESS_RATE_DEFAULT || '0.10');
            }

            const answeredCalls = await prisma.call_history.count({
                where: {
                    data_inicio: { gte: cutoffDate },
                    status: 'Atendida'
                }
            });

            const rate = answeredCalls / totalCalls;

            return Math.max(minRate, Math.min(maxRate, rate));
        } catch (error) {
            console.error('[PredictiveEngine] Error calculating success rate, using default:', error.message);
            return parseFloat(process.env.DIALER_SUCCESS_RATE_DEFAULT || '0.10');
        }
    }

    /**
     * Core dialer execution. Pops leads and originates calls.
     */
    async triggerDialing(disparos, pbxContext, pbxTrunk, useVoskAmd = true, dialerContext = 'triagem-amd') {
        const resolvedPbxContext = pbxContext || vitalpbxConfig.context || 'from-internal';
        const resolvedPbxTrunk = pbxTrunk && pbxTrunk.trim() !== '' ? pbxTrunk : '';
        // Check queue length
        let queueLength = await redisClient.llen('dialer:lead_queue');
        
        // If queue is low, refill it from Postgres (throttled to once every 10 seconds to avoid database and log flooding)
        const now = Date.now();
        if (queueLength < disparos) {
            if (!this.lastRefillTime || now - this.lastRefillTime >= 10000) {
                this.lastRefillTime = now;
                await this.refillLeadQueue();
                queueLength = await redisClient.llen('dialer:lead_queue');
            }
        }

        const countToPop = Math.min(disparos, queueLength);
        if (countToPop <= 0) return;

        console.log(`[PredictiveEngine] Originating ${countToPop} predictive calls (Queue size: ${queueLength})...`);

        for (let i = 0; i < countToPop; i++) {
            const leadStr = await redisClient.lpop('dialer:lead_queue');
            if (!leadStr) break;

            const lead = JSON.parse(leadStr);

            // Check if there is at least one idle agent for this lead's campaign
            let hasIdleAgent = false;
            try {
                const campaign = await prisma.campaign.findUnique({
                    where: { id: lead.campaignId },
                    select: { teamId: true }
                });
                if (campaign && campaign.teamId) {
                    const campaignTeams = campaign.teamId.split(',').map(t => t.trim()).filter(t => t);
                    const idleAgents = await redisClient.zrange('dialer:idle_agents', 0, -1);
                    if (idleAgents.length > 0) {
                        const teamUsers = await prisma.team_users.findMany({
                            where: { 
                                user_id: { in: idleAgents },
                                team_id: { in: campaignTeams }
                            },
                            select: { user_id: true }
                        });
                        if (teamUsers.length > 0) {
                            hasIdleAgent = true;
                        }
                    }
                }
            } catch (err) {
                console.error(`[PredictiveEngine] Error checking agent availability for lead ${lead.id}:`, err.message);
                hasIdleAgent = true; // Fallback to avoid skipping if DB error
            }

            if (!hasIdleAgent) {
                console.log(`[PredictiveEngine] Skipping lead ${lead.id} because campaign ${lead.campaignId} has no idle agents.`);
                await redisClient.srem('dialer:dialed_leads', String(lead.id));
                continue;
            }

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
                let destChannel = `Local/${dialedPhone}@${resolvedPbxContext}/n`;
                if (resolvedPbxTrunk && resolvedPbxTrunk.trim() !== '') {
                    if (resolvedPbxTrunk.startsWith('Local/')) {
                        destChannel = `${resolvedPbxTrunk}/${dialedPhone}@${resolvedPbxContext}/n`;
                    } else if (resolvedPbxTrunk.includes('/')) {
                        destChannel = `${resolvedPbxTrunk}/${dialedPhone}`;
                    } else {
                        destChannel = `PJSIP/${resolvedPbxTrunk}/${dialedPhone}`;
                    }
                }
                
                const variables = {
                    LEAD_ID: String(lead.id),
                    CAMPAIGN_ID: String(lead.campaignId),
                    PHONE: dialedPhone
                };

                // Add flag to bypass Vosk AMD in Asterisk dialplan if configured
                if (!useVoskAmd) {
                    variables.BYPASS_VOSK = '1';
                }

                amiService.originateCall(
                    destChannel,
                    dialerContext,
                    's',
                    1,
                    variables
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

                // Increment daily total calls counter in Redis
                const todayStr = new Date().toISOString().split('T')[0];
                const totalKey = `dialer:stats:${todayStr}:total`;
                await redisClient.incr(totalKey);
                await redisClient.expire(totalKey, 86400);

                // Track recent dials in sliding window (ZSET)
                const dialId = `${lead.id}_${Date.now()}_${Math.random()}`;
                await redisClient.zadd('dialer:recent_dials', String(Date.now()), dialId);

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

    async refillLeadQueue() {
        try {
            // 1. Get all active AI agent IDs if not cached
            if (!this.aiAgentIds) {
                const users = await prisma.users.findMany({
                    select: { id: true, role: true }
                });
                this.aiAgentIds = new Set(users.filter(u => u.role === 'ai_agent').map(u => String(u.id)));
            }

            // Get all idle agent IDs from Redis who are active (SIP for AI, WebRTC active for human)
            const rawIdleAgents = await redisClient.zrange('dialer:idle_agents', 0, -1);
            const idleAgents = [];
            for (const id of rawIdleAgents) {
                const isAi = this.aiAgentIds.has(String(id));
                const active = isAi ? 'true' : await redisClient.get(`dialer:agent_webrtc_active:${id}`);
                if (active === 'true') {
                    idleAgents.push(id);
                }
            }

            if (idleAgents.length === 0) {
                console.log('[PredictiveEngine] No idle agents with active WebRTC/SIP connections. Skipping refill.');
                return;
            }
            console.log('[PredictiveEngine] Refilling lead queue from Postgres...');

            // 2. Fetch the teams of these idle agents
            const teamUsers = await prisma.team_users.findMany({
                where: { user_id: { in: idleAgents } },
                select: { team_id: true }
            });
            const idleTeamIds = [...new Set(teamUsers.map(tu => tu.team_id))];

            // 3. Find active predictive campaigns
            const activeCampaigns = await prisma.campaign.findMany({
                where: { dialingMode: 'predictive' }
            });

            // Fetch IA teams to exclude from human dialing
            let iaTeamIds = new Set();
            try {
                const iaTeams = await prisma.teams.findMany({
                    where: { team_type: 'ia' },
                    select: { id: true }
                });
                iaTeams.forEach(t => iaTeamIds.add(t.id));
            } catch (dbErr) {
                console.error('[PredictiveEngine] Error fetching IA teams for exclusion:', dbErr.message);
            }
 
            // 4. Filter campaigns to only those that have at least one idle agent in their team
            // and do not belong to an IA team
            const activeCampaignIds = activeCampaigns
                .filter(c => {
                    if (!c.teamId) return false;
                    const cTeams = c.teamId.split(',').map(t => t.trim()).filter(t => t);
                    const isIaCampaign = cTeams.some(t => iaTeamIds.has(t));
                    if (isIaCampaign) return false;
                    return cTeams.some(t => idleTeamIds.includes(t));
                })
                .map(c => c.id);

            if (activeCampaignIds.length === 0) {
                console.log('[PredictiveEngine] No active predictive campaigns with idle agents found.');
                return;
            }

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

                    // Save call in call_history as "NaoAtendida"
                    try {
                        const contact = await getOrCreateContact(callData.phone, leadId);
                        const systemUser = await getOrCreateSystemUser();
                        await prisma.call_history.create({
                            data: {
                                cliente_id: contact.id,
                                agente_id: systemUser.id,
                                status: 'NaoAtendida',
                                duracao: 0,
                                data_inicio: new Date(parseInt(callData.timestamp))
                            }
                        });
                    } catch (dbErr) {
                        console.error('[PredictiveEngine] Error saving NaoAtendida call to history:', dbErr.message);
                    }

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
                console.log(`[PredictiveEngine] AMI UserEvent PredictiveHuman received. Channel: ${channelName}, Phone: ${cleanPhone}, Lead: ${LeadId}, Campaign: ${CampaignId}`);
                
                try {
                    // Resolve campaign team users
                    let allowedAgentIds = null;
                    let isAiCampaign = false;
                    if (CampaignId) {
                        try {
                            const campaign = await prisma.campaign.findUnique({
                                where: { id: parseInt(CampaignId) },
                                select: { teamId: true }
                            });
                            if (campaign && campaign.teamId) {
                                const teamIds = campaign.teamId.split(',').map(id => id.trim()).filter(id => id);
                                if (teamIds.length > 0) {
                                    const teamUsers = await prisma.team_users.findMany({
                                        where: { team_id: { in: teamIds } },
                                        select: { user_id: true }
                                    });
                                    allowedAgentIds = new Set(teamUsers.map(tu => tu.user_id));
                                    
                                    // Check if this is an AI campaign
                                    const teams = await prisma.teams.findMany({
                                        where: { id: { in: teamIds } },
                                        select: { team_type: true }
                                    });
                                    isAiCampaign = teams.some(t => t.team_type === 'ai_agent');
                                    console.log(`[PredictiveEngine] Campaign ${CampaignId} (isAi: ${isAiCampaign}) requires agents from teams [${teamIds.join(', ')}] (${allowedAgentIds.size} agents).`);
                                }
                            }
                        } catch (dbErr) {
                            console.error(`[PredictiveEngine] Error resolving campaign team users for Campaign ${CampaignId}:`, dbErr.message);
                        }
                    }

                    // Try to pop an available agent from the campaign's team who is active (WebRTC for human, direct for AI)
                    const idleAgents = await redisClient.zrange('dialer:idle_agents', 0, -1);
                    let agentId = null;
                    let agentObj = null;

                    if (allowedAgentIds) {
                        for (const id of idleAgents) {
                            if (allowedAgentIds.has(id)) {
                                const isAi = this.aiAgentIds && this.aiAgentIds.has(String(id));
                                const webrtcActive = isAi ? 'true' : await redisClient.get(`dialer:agent_webrtc_active:${id}`);
                                if (webrtcActive === 'true') {
                                    const removed = await redisClient.zrem('dialer:idle_agents', id);
                                    if (removed === 1) {
                                        agentId = id;
                                        break;
                                    }
                                }
                            }
                        }
                    } else {
                        // Fallback: pop the absolute longest idle agent who is active
                        for (const id of idleAgents) {
                            const isAi = this.aiAgentIds && this.aiAgentIds.has(String(id));
                            const webrtcActive = isAi ? 'true' : await redisClient.get(`dialer:agent_webrtc_active:${id}`);
                            if (webrtcActive === 'true') {
                                const removed = await redisClient.zrem('dialer:idle_agents', id);
                                if (removed === 1) {
                                    agentId = id;
                                    break;
                                }
                            }
                        }
                    }

                    if (!agentId) {
                        // Check if return extension is configured
                        let returnExt = null;
                        let pbxContext = 'cos-all';
                        const returnKey = isAiCampaign ? 'dialer_ai_return_extension' : 'dialer_return_extension';
                        try {
                            const dbSettings = await prisma.settings.findMany({
                                where: {
                                    key: { in: [returnKey, 'vitalpbx_context'] }
                                }
                            });
                            for (const s of dbSettings) {
                                if (s.key === returnKey) {
                                    returnExt = s.value;
                                } else if (s.key === 'vitalpbx_context' && s.value) {
                                    pbxContext = s.value;
                                }
                            }
                        } catch (dbErr) {
                            console.error('[PredictiveEngine] Error fetching return extension settings:', dbErr.message);
                        }

                        if (returnExt && returnExt.trim() !== '') {
                            console.log(`[PredictiveEngine] No agents available for answered call on channel ${channelName}. Redirecting to return extension: ${returnExt}`);
                            amiService.redirectCall(channelName, pbxContext, returnExt, 1);

                            // Save call in call_history as "Retorno"
                            const contact = await getOrCreateContact(cleanPhone, LeadId);
                            const systemUser = await getOrCreateSystemUser();
                            await prisma.call_history.create({
                                data: {
                                    cliente_id: contact.id,
                                    agente_id: systemUser.id,
                                    status: 'Retorno',
                                    duracao: 0,
                                    data_inicio: new Date()
                                }
                            });

                            // Clean up dialing tracking in Redis
                            await redisClient.srem('dialer:active_dialing_channels', LeadId);
                            await redisClient.del(`dialer:dialing_calls:${LeadId}`);
                            return;
                        }

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

                        // Increment daily abandoned calls counter in Redis
                        const todayStr = new Date().toISOString().split('T')[0];
                        const abKey = `dialer:stats:${todayStr}:abandoned`;
                        await redisClient.incr(abKey);
                        await redisClient.expire(abKey, 86400);

                        // Clean up dialing tracking in Redis
                        await redisClient.srem('dialer:active_dialing_channels', LeadId);
                        await redisClient.del(`dialer:dialing_calls:${LeadId}`);

                        // Inflate success rate in Redis temporarily to freeze dialer
                        await redisClient.set('dialer:inflated_success_rate', '1.0', 'EX', 30);
                        return;
                    }

                    // --- CONNECTING CALL TO AGENT ---
                    console.log(`[PredictiveEngine] Assigning call on channel ${channelName} to Agent ${agentId}`);
                    
                    if (!agentObj) {
                        agentObj = await prisma.users.findUnique({ where: { id: agentId } });
                    }

                    // 1. Update agent status in Postgres to ocupado (only for humans)
                    if (agentObj.role !== 'ai_agent') {
                        await prisma.users.update({
                            where: { id: agentId },
                            data: {
                                agent_status: 'ocupado',
                                agent_status_reason: 'In Call'
                            }
                        });
                    }
 
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

                    // Store the predictive call mapping to agentId and active channel
                    const uniqueId = event.Uniqueid;
                    if (uniqueId) {
                        await redisClient.set(`dialer:predictive_call_agent:${uniqueId}`, agentId, 'EX', 7200);
                    }
                    await redisClient.set(`dialer:active_call_channel:${agentId}`, channelName, 'EX', 7200);
 
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

                    // Increment daily answered calls counter in Redis
                    const todayStr = new Date().toISOString().split('T')[0];
                    const ansKey = `dialer:stats:${todayStr}:answered`;
                    await redisClient.incr(ansKey);
                    await redisClient.expire(ansKey, 86400);

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
                    console.error('[PredictiveEngine] Error connecting call to Agent:', err.message);
                }
            }
        });
    }

    /**
     * Periodically syncs AI agents availability in Postgres to Redis ZSET.
     */
    async syncAiAgentsStatus() {
        try {
            // Find all active AI agents
            const aiAgents = await prisma.users.findMany({
                where: {
                    role: 'ai_agent',
                    is_active: true
                }
            });

            for (const agent of aiAgents) {
                const agentId = agent.id;
                
                // Fetch the teams of this agent
                const teamUsers = await prisma.team_users.findMany({
                    where: { user_id: agentId },
                    select: { team_id: true }
                });
                const teamIds = teamUsers.map(tu => tu.team_id);
                
                // Fetch teams details to get max_channels
                const teams = await prisma.teams.findMany({
                    where: { id: { in: teamIds } }
                });
                
                let maxCapacity = 1;
                for (const t of teams) {
                    if (t.team_type === 'ai_agent') {
                        maxCapacity = Math.max(maxCapacity, t.max_channels || 1);
                    }
                }
                
                // Count current active calls for this AI agent
                const activeCallsCount = await prisma.calls.count({
                    where: { agent_id: agentId, status: 'active' }
                });
                
                // If agent is available and below capacity
                if (agent.agent_status === 'disponivel' && activeCallsCount < maxCapacity) {
                    // Make sure they are in the idle list
                    const score = await redisClient.zscore('dialer:idle_agents', agentId);
                    if (score === null) {
                        console.log(`[PredictiveEngine] Adding AI Agent ${agent.name} (${agentId}) to idle queue. Capacity: ${activeCallsCount}/${maxCapacity}`);
                        await redisClient.zadd('dialer:idle_agents', Date.now(), agentId);
                    }
                } else {
                    // Remove from idle list if status not 'disponivel' or reached capacity
                    const score = await redisClient.zscore('dialer:idle_agents', agentId);
                    if (score !== null) {
                        console.log(`[PredictiveEngine] Removing AI Agent ${agent.name} (${agentId}) from idle queue (Status: ${agent.agent_status}, Capacity: ${activeCallsCount}/${maxCapacity}).`);
                        await redisClient.zrem('dialer:idle_agents', agentId);
                    }
                }
            }
        } catch (err) {
            console.error('[PredictiveEngine] Error syncing AI agents status:', err.message);
        }
    }
}
