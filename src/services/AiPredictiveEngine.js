import crypto from 'crypto';
import prisma from '../config/db.js';
import redisClient from '../config/redis.js';
import { getOrCreateContact, getOrCreateSystemUser, getOrCreateConversation, cleanPhonePrefix } from '../routes/calls.js';
import { amiService } from './AMIService.js';
import { channelManager } from './ChannelManager.js';

export class AiPredictiveEngine {
    constructor() {
        this.running = false;
        this.intervalId = null;
        this.cleanupIntervalId = null;
        this.intervalMs = parseInt(process.env.DIALER_INTERVAL_MS || '500');

        // Listen to AMI events
        this.setupAmiListeners();

        this.lastSummaryLog = 0;
        this.lastMetricsPublish = 0;
    }

    /**
     * Starts the AI predictive dialing loop.
     */
    start() {
        if (this.running) return;
        this.running = true;
        console.log(`[AiPredictiveEngine] Starting AI predictive loop (Interval: ${this.intervalMs}ms)...`);

        // Main loop
        this.intervalId = setInterval(() => this.tick(), this.intervalMs);

        // Cleanup loop (every 5 seconds)
        this.cleanupIntervalId = setInterval(() => this.cleanupExpiredDialingCalls(), 5000);
    }

    /**
     * Stops the AI predictive loop.
     */
    stop() {
        if (!this.running) return;
        this.running = false;
        clearInterval(this.intervalId);
        clearInterval(this.cleanupIntervalId);
        console.log('[AiPredictiveEngine] AI predictive loop stopped.');
    }

    /**
     * Single iteration of the AI predictive dialer.
     */
    async isWithinOperatingHours() {
        let startTime = '08:00';
        let endTime = '20:00';
        let activeDays = ['1', '2', '3', '4', '5', '6']; // 0=Sun, 1=Mon...6=Sat

        try {
            const dbSettings = await prisma.settings.findMany({
                where: {
                    key: { in: ['dialer_ai_start_time', 'dialer_ai_end_time', 'dialer_ai_active_days'] }
                }
            });
            for (const s of dbSettings) {
                if (s.key === 'dialer_ai_start_time' && s.value) startTime = s.value.trim();
                else if (s.key === 'dialer_ai_end_time' && s.value) endTime = s.value.trim();
                else if (s.key === 'dialer_ai_active_days' && s.value) {
                    try {
                        const parsed = JSON.parse(s.value);
                        if (Array.isArray(parsed)) activeDays = parsed.map(String);
                    } catch (e) {
                        activeDays = s.value.split(',').map(d => d.trim());
                    }
                }
            }
        } catch (err) {}

        const now = new Date();
        const currentDay = String(now.getDay());
        if (!activeDays.includes(currentDay)) {
            return { allowed: false, reason: `Hoje (dia ${currentDay}) não está nos dias ativos de discagem da IA` };
        }

        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        const [startH, startM] = startTime.split(':').map(Number);
        const [endH, endM] = endTime.split(':').map(Number);

        const startMinutes = (isNaN(startH) ? 8 : startH) * 60 + (isNaN(startM) ? 0 : startM);
        const endMinutes = (isNaN(endH) ? 20 : endH) * 60 + (isNaN(endM) ? 0 : endM);

        if (currentMinutes < startMinutes || currentMinutes >= endMinutes) {
            return { allowed: false, reason: `Horário atual (${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}) fora da janela (${startTime} às ${endTime})` };
        }

        return { allowed: true };
    }

    async tick() {
        try {
            if (!this.running) return;
            const now = Date.now();

            // 0. Check Master Engine Pause switch
            const isMasterPaused = (await redisClient.get('dialer:engine_paused')) === '1';
            if (isMasterPaused) {
                await redisClient.del('dialer:ai_lead_queue');
                if (now - (this.lastSummaryLog || 0) > 15000) {
                    console.log('[AiPredictiveEngine] Discagem IA pausada via chave de controle master.');
                    this.lastSummaryLog = now;
                }
                return;
            }

            // 0. Check AI Operating Schedule (Business Hours & Active Days)
            const scheduleCheck = await this.isWithinOperatingHours();
            if (!scheduleCheck.allowed) {
                // Flush AI lead queue outside operating hours
                await redisClient.del('dialer:ai_lead_queue');
                await redisClient.del('dialer:ai_active_dialing_channels');
                if (now - this.lastSummaryLog > 30000) {
                    console.log(`[AiPredictiveEngine] Discagem IA pausada: ${scheduleCheck.reason}`);
                    this.lastSummaryLog = now;
                }
                return;
            }

            const oneMinuteAgo = now - 60000;

            // Load settings from DB with fallbacks
            let cpm = 10;
            let maxChannels = 30;
            let pbxContext = 'cos-all';
            let dialerContext = 'triagem-amd';
            let pbxTrunk = null;
            let predictiveTrunk = null;
            let useVoskAmd = true;

            try {
                const dbSettings = await prisma.settings.findMany({
                    where: {
                        key: {
                            in: [
                                'dialer_ai_cpm',
                                'dialer_ai_max_channels',
                                'vitalpbx_context',
                                'dialer_ai_context',
                                'dialer_context',
                                'vitalpbx_trunk',
                                'dialer_predictive_trunk',
                                'dialer_ai_use_vosk_amd'
                            ]
                        }
                    }
                });
                for (const s of dbSettings) {
                    if (s.key === 'dialer_ai_cpm' && s.value) {
                        cpm = parseFloat(s.value) || 10;
                    } else if (s.key === 'dialer_ai_max_channels' && s.value) {
                        maxChannels = parseInt(s.value) || 30;
                    } else if (s.key === 'vitalpbx_context' && s.value) {
                        pbxContext = s.value;
                    } else if (s.key === 'dialer_ai_context' && s.value && s.value.trim() !== '' && s.value !== 'triagem-amd-ia') {
                        dialerContext = s.value;
                    } else if (s.key === 'dialer_context' && s.value && s.value.trim() !== '') {
                        if (dialerContext === 'triagem-amd') dialerContext = s.value;
                    } else if (s.key === 'vitalpbx_trunk' && s.value) {
                        pbxTrunk = s.value;
                    } else if (s.key === 'dialer_predictive_trunk' && s.value) {
                        predictiveTrunk = s.value;
                    } else if (s.key === 'dialer_ai_use_vosk_amd') {
                        useVoskAmd = s.value !== 'false';
                    }
                }
            } catch (err) {
                console.error('[AiPredictiveEngine] Error fetching dialer settings from DB:', err.message);
            }

            // 1. Clean up expired recent dials (older than 60 seconds) in Redis ZSET
            await redisClient.zremrangebyscore('dialer:ai_recent_dials', '-inf', String(oneMinuteAgo));

            // 2. Get Calls placed in the last 60 seconds
            const recentDialsCount = await redisClient.zcount('dialer:ai_recent_dials', String(oneMinuteAgo), String(now)) || 0;

            // 3. Calculate Dials needed in this tick to meet the CPM
            const targetCalls = Math.ceil(cpm);
            const dialsNeeded = Math.max(0, targetCalls - recentDialsCount);

            // 4. Calculate Pacing (Max Disparos per tick to space calls smoothly)
            const ticksInWindow = 60000 / this.intervalMs;
            const maxDialsPerTick = Math.max(1, Math.ceil(targetCalls / ticksInWindow));

            // 5. Query ChannelManager for available slots respecting global trunk capacity & human reservation
            const activeLines = await redisClient.scard('dialer:ai_active_dialing_channels') || 0;
            const disparos = await channelManager.getAvailableSlots('ai_agent', Math.min(dialsNeeded, maxDialsPerTick));

            if (now - this.lastSummaryLog > 10000) {
                console.log(`[AiPredictiveEngine] Pacing Loop - CPM Target: ${cpm}, Active Lines: ${activeLines}/${maxChannels}, Dials Last Min: ${recentDialsCount}/${targetCalls}, Needed: ${dialsNeeded}, Max/Tick: ${maxDialsPerTick}, Disparos: ${disparos}`);
                this.lastSummaryLog = now;
            }

            // 6. Publish real-time metrics consolidations (throttled to 1s)
            if (!this.lastMetricsPublish || now - this.lastMetricsPublish >= 1000) {
                this.lastMetricsPublish = now;
                await this.publishRealtimeMetrics();
            }

            if (disparos > 0) {
                await this.triggerDialing(disparos, pbxContext, predictiveTrunk || pbxTrunk, useVoskAmd, dialerContext);
            }
        } catch (error) {
            console.error('[AiPredictiveEngine] Error in tick:', error);
        }
    }

    /**
     * Publishes current daily consolidated metrics to Redis Pub/Sub.
     */
    async publishRealtimeMetrics() {
        try {
            const todayStr = new Date().toISOString().split('T')[0];
            const humanActive = await redisClient.scard('dialer:active_dialing_channels') || 0;
            const aiActive = await redisClient.scard('dialer:ai_active_dialing_channels') || 0;
            const activeLines = humanActive + aiActive;

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
            console.error('[AiPredictiveEngine] Error publishing real-time metrics:', err.message);
        }
    }

    /**
     * Core dialer execution. Pops leads and originates calls.
     */
    async triggerDialing(disparos, pbxContext, pbxTrunk, useVoskAmd = true, dialerContext = 'triagem-amd') {
        const resolvedPbxContext = pbxContext || 'cos-all';
        const resolvedDialerContext = (dialerContext && dialerContext !== 'triagem-amd-ia') ? dialerContext : 'triagem-amd';
        const resolvedPbxTrunk = pbxTrunk && pbxTrunk.trim() !== '' ? pbxTrunk : '';

        // Check queue length
        let queueLength = await redisClient.llen('dialer:ai_lead_queue');

        // If queue is low, refill it from Postgres (throttled to once every 10 seconds to avoid database and log flooding)
        const now = Date.now();
        if (queueLength < disparos) {
            if (!this.lastRefillTime || now - this.lastRefillTime >= 10000) {
                this.lastRefillTime = now;
                await this.refillLeadQueue();
            }
        }
        // Double check that there are active AI campaigns running before originating
        const activeAiCampaigns = await prisma.campaign.findMany({
            where: {
                dialingMode: 'predictive',
                status: { notIn: ['paused', 'deleted', 'completed'] }
            },
            select: { id: true, teamId: true }
        });
        const iaTeams = await prisma.teams.findMany({
            where: { team_type: { in: ['ia', 'ai_agent'] } },
            select: { id: true }
        });
        const iaTeamIds = iaTeams.map(t => t.id);
        const hasActiveAiCampaign = activeAiCampaigns.some(c => {
            if (!c.teamId) return false;
            const cTeams = c.teamId.split(',').map(t => t.trim()).filter(t => t);
            return cTeams.some(t => iaTeamIds.includes(t));
        });

        if (!hasActiveAiCampaign) {
            await redisClient.del('dialer:ai_lead_queue');
            return;
        }

        const countToPop = Math.min(disparos, queueLength);
        if (countToPop <= 0) return;

        console.log(`[AiPredictiveEngine] Originating ${countToPop} AI predictive calls (Queue size: ${queueLength})...`);

        for (let i = 0; i < countToPop; i++) {
            const leadStr = await redisClient.lpop('dialer:ai_lead_queue');
            if (!leadStr) break;

            const lead = JSON.parse(leadStr);

            try {
                // Determine prefix and clean phone
                let prefix = '';
                try {
                    const prefixSetting = await prisma.settings.findUnique({
                        where: { key: 'dialer_ai_dial_prefix' }
                    });
                    if (prefixSetting && prefixSetting.value) {
                        prefix = prefixSetting.value;
                    } else {
                        const defaultPrefix = await prisma.settings.findUnique({
                            where: { key: 'dialer_dial_prefix' }
                        });
                        prefix = defaultPrefix?.value || '';
                    }
                } catch (err) {
                    console.error('[AiPredictiveEngine] Error fetching AI prefix:', err.message);
                }

                let dialedPhone = lead.phone.replace(/\D/g, '');
                if (prefix && prefix.trim() !== '') {
                    const trimmedPrefix = prefix.trim();
                    if ((dialedPhone.length === 12 || dialedPhone.length === 13) && dialedPhone.startsWith('55')) {
                        if (trimmedPrefix.endsWith('55')) {
                            dialedPhone = dialedPhone.substring(2);
                        }
                    }
                    const numericPrefix = trimmedPrefix.replace(/\D/g, '');
                    if (!dialedPhone.startsWith(numericPrefix)) {
                        dialedPhone = trimmedPrefix + dialedPhone;
                    }
                }

                // Dials customer via AMI and routes to triagem-amd-ia context
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
                    PHONE: dialedPhone,
                    IS_AI_CALL: '1',
                    O_RING_TIME: '30'
                };

                // Add flag to bypass Vosk AMD in Asterisk dialplan if configured
                if (!useVoskAmd) {
                    variables.BYPASS_VOSK = '1';
                }

                amiService.originateCall(
                    destChannel,
                    resolvedDialerContext,
                    's',
                    1,
                    variables
                );

                // Cache call details in Redis with a TTL of 60 seconds
                await redisClient.hset(
                    `dialer:ai_dialing_calls:${lead.id}`,
                    'leadId', String(lead.id),
                    'campaignId', String(lead.campaignId),
                    'phone', lead.phone,
                    'name', lead.name || '',
                    'timestamp', String(Date.now())
                );
                await redisClient.expire(`dialer:ai_dialing_calls:${lead.id}`, 60);

                // Track active dialing channels
                await redisClient.sadd('dialer:ai_active_dialing_channels', String(lead.id));

                // Increment daily total calls counter in Redis
                const todayStr = new Date().toISOString().split('T')[0];
                const totalKey = `dialer:stats:${todayStr}:total`;
                await redisClient.incr(totalKey);
                await redisClient.expire(totalKey, 86400);

                // Track recent dials in sliding window (ZSET)
                const dialId = `${lead.id}_${Date.now()}_${Math.random()}`;
                await redisClient.zadd('dialer:ai_recent_dials', String(Date.now()), dialId);

                // Publish real-time dialing event to Redis PubSub
                await redisClient.publish('dialer:events', JSON.stringify({
                    phone: lead.phone,
                    status: 'chamando',
                    label: 'Chamando (IA)',
                    operator: '',
                    time: '00:00'
                }));
            } catch (err) {
                console.error(`[AiPredictiveEngine] Failed to originate call for Lead ${lead.id}:`, err.message);
                // Return lead to front of the queue
                await redisClient.lpush('dialer:ai_lead_queue', JSON.stringify(lead));
            }
        }
    }

    /**
     * Refills the Redis AI lead queue with undialed leads from active campaigns in Postgres.
     */
    async refillLeadQueue() {
        console.log('[AiPredictiveEngine] Refilling AI lead queue from Postgres...');
        try {
            // 1. Fetch active AI teams
            const iaTeams = await prisma.teams.findMany({
                where: { team_type: { in: ['ia', 'ai_agent'] } },
                select: { id: true }
            });
            const iaTeamIds = iaTeams.map(t => t.id);
            if (iaTeamIds.length === 0) {
                console.log('[AiPredictiveEngine] No active AI teams found. Skipping refill.');
                return;
            }

            // 2. Find active predictive campaigns
            const activeCampaigns = await prisma.campaign.findMany({
                where: { 
                    dialingMode: 'predictive',
                    status: { notIn: ['paused', 'deleted', 'completed'] }
                }
            });

            // 3. Filter campaigns to only those belonging to AI teams
            const activeCampaignIds = activeCampaigns
                .filter(c => {
                    if (!c.teamId) return false;
                    const cTeams = c.teamId.split(',').map(t => t.trim()).filter(t => t);
                    return cTeams.some(t => iaTeamIds.includes(t));
                })
                .map(c => c.id);

            if (activeCampaignIds.length === 0) {
                console.log('[AiPredictiveEngine] No active predictive AI campaigns found. Flushing AI lead queue.');
                await redisClient.del('dialer:ai_lead_queue');
                return;
            }

            // Fetch already dialed AI leads from Redis
            const dialedLeads = await redisClient.smembers('dialer:ai_dialed_leads');
            const dialedLeadIds = dialedLeads.map(id => parseInt(id)).filter(id => !isNaN(id));

            console.log(`[AiPredictiveEngine] Refill Info - Active Campaigns: ${JSON.stringify(activeCampaignIds)}, Dialed Leads: ${dialedLeadIds.length}`);

            // Fetch undialed leads from Postgres
            const leads = await prisma.lead.findMany({
                where: {
                    campaignId: { in: activeCampaignIds },
                    id: dialedLeadIds.length > 0 ? { notIn: dialedLeadIds } : undefined
                },
                take: 100,
                orderBy: { id: 'asc' }
            });

            if (leads.length === 0) {
                console.log(`[AiPredictiveEngine] No new undialed leads found for campaigns ${JSON.stringify(activeCampaignIds)}.`);
                return;
            }

            console.log(`[AiPredictiveEngine] Found ${leads.length} undialed AI leads. Pushing to Redis queue.`);

            for (const lead of leads) {
                const phone = lead.phone1 || lead.phone2 || lead.phone3;
                if (!phone) continue;

                // Check blacklist in Redis
                const cleanedPhone = phone.replace(/\D/g, '');
                const isBlacklisted = await redisClient.sismember('dialer:blacklisted_phones', cleanedPhone);
                if (isBlacklisted) continue;

                // Check cooldown in Redis
                const onCooldown = await redisClient.exists(`dialer:lead_cooldown:${lead.id}`);
                if (onCooldown) continue;

                const leadPayload = {
                    id: lead.id,
                    name: lead.name,
                    phone: phone,
                    campaignId: lead.campaignId
                };

                await redisClient.rpush('dialer:ai_lead_queue', JSON.stringify(leadPayload));
                await redisClient.sadd('dialer:ai_dialed_leads', String(lead.id));
            }
        } catch (error) {
            console.error('[AiPredictiveEngine] Error refilling lead queue:', error.message);
        }
    }

    /**
     * Cleans up expired AI dialing channels.
     */
    async cleanupExpiredDialingCalls() {
        try {
            const leads = await redisClient.smembers('dialer:ai_active_dialing_channels');
            const now = Date.now();
            for (const leadId of leads) {
                const callData = await redisClient.hgetall(`dialer:ai_dialing_calls:${leadId}`);
                if (!callData || !callData.timestamp || !callData.phone) {
                    await redisClient.srem('dialer:ai_active_dialing_channels', leadId);
                    continue;
                }
                const elapsed = now - parseInt(callData.timestamp);
                if (elapsed > 45000) {
                    console.log(`[AiPredictiveEngine] Lead ${leadId} timed out (${elapsed}ms). Cleaning up.`);

                    await redisClient.publish('dialer:events', JSON.stringify({
                        phone: callData.phone,
                        status: 'falha',
                        label: 'Falha',
                        operator: '',
                        time: '00:00'
                    })).catch(() => { });

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
                        console.error('[AiPredictiveEngine] Error saving NaoAtendida call to history:', dbErr.message);
                    }

                    await redisClient.srem('dialer:ai_active_dialing_channels', leadId);
                    await redisClient.del(`dialer:ai_dialing_calls:${leadId}`);
                }
            }
        } catch (error) {
            console.error('[AiPredictiveEngine] Error in cleanup expired dialing calls:', error.message);
        }
    }

    /**
     * Set up listeners for Asterisk AMI events.
     */
    setupAmiListeners() {
        amiService.on('UserEvent', async (event) => {
            if (event.UserEvent === 'LiveKitBridgeConnected') {
                const { Phone, AgentRoom } = event;
                const logMsg = `[AiPredictiveEngine] LiveKit SIP atendeu e ponteou a chamada de IA! Sala: ${AgentRoom}, Phone: ${Phone}`;
                console.log(logMsg);
                
                try {
                    await redisClient.publish('dialer:events', JSON.stringify({
                        phone: Phone || 'N/A',
                        status: 'livekit_connected',
                        label: 'LiveKit Conectado (IA) 🟢',
                        operator: AgentRoom,
                        time: new Date().toLocaleTimeString('pt-BR')
                    }));

                    await redisClient.lpush('dialer:recent_debug_logs', JSON.stringify({
                        timestamp: new Date().toISOString(),
                        level: 'SUCCESS',
                        message: logMsg
                    }));
                    await redisClient.ltrim('dialer:recent_debug_logs', 0, 199);
                } catch (e) {
                    console.error('[AiPredictiveEngine] Error handling LiveKitBridgeConnected event:', e.message);
                }
                return;
            }

            if (event.UserEvent === 'PredictiveAi') {
                const { Channel, ChannelId, Phone, LeadId, CampaignId } = event;
                const channelName = Channel || ChannelId || event.Channelid;
                const cleanPhone = await cleanPhonePrefix(Phone);
                console.log(`[AiPredictiveEngine] AMI UserEvent PredictiveAi received. Channel: ${channelName}, Phone: ${cleanPhone}, Lead: ${LeadId}, Campaign: ${CampaignId}`);

                try {
                    // Clean up dialing tracking in Redis immediately
                    await redisClient.srem('dialer:ai_active_dialing_channels', LeadId);
                    await redisClient.del(`dialer:ai_dialing_calls:${LeadId}`);

                    // Resolve campaign team users
                    let agentId = null;
                    let agentObj = null;

                    if (CampaignId) {
                        try {
                            const campaign = await prisma.campaign.findUnique({
                                where: { id: parseInt(CampaignId) },
                                select: { teamId: true }
                            });
                            if (campaign && campaign.teamId) {
                                const teamIds = campaign.teamId.split(',').map(id => id.trim()).filter(id => id);
                                if (teamIds.length > 0) {
                                    // Get active AI agents in this campaign's teams
                                    const aiUsers = await prisma.users.findMany({
                                        where: {
                                            team_users: { some: { team_id: { in: teamIds } } },
                                            role: { in: ['ai_agent', 'ia'] },
                                            is_active: true
                                        }
                                    });
                                    if (aiUsers.length > 0) {
                                        agentObj = aiUsers[0];
                                        agentId = agentObj.id;
                                    }
                                }
                            }
                        } catch (dbErr) {
                            console.error(`[AiPredictiveEngine] Error resolving campaign team users for Campaign ${CampaignId}:`, dbErr.message);
                        }
                    }

                    // Fallback to default active AI Agent if campaign has no specific team user
                    if (!agentId || !agentObj) {
                        try {
                            const fallbackAiAgent = await prisma.users.findFirst({
                                where: {
                                    role: { in: ['ai_agent', 'ia'] },
                                    is_active: true
                                }
                            });
                            if (fallbackAiAgent) {
                                agentObj = fallbackAiAgent;
                                agentId = fallbackAiAgent.id;
                                console.log(`[AiPredictiveEngine] Fallback: Assigning call to default active AI Agent '${fallbackAiAgent.name}' (${fallbackAiAgent.id})`);
                            }
                        } catch (fallbackErr) {
                            console.error('[AiPredictiveEngine] Error resolving fallback AI agent:', fallbackErr.message);
                        }
                    }

                    if (!agentId || !agentObj) {
                        // Check if return extension is configured for AI
                        let returnExt = null;
                        let pbxContext = 'cos-all';
                        try {
                            const dbSettings = await prisma.settings.findMany({
                                where: {
                                    key: { in: ['dialer_ai_return_extension', 'vitalpbx_context'] }
                                }
                            });
                            for (const s of dbSettings) {
                                if (s.key === 'dialer_ai_return_extension') {
                                    returnExt = s.value;
                                } else if (s.key === 'vitalpbx_context' && s.value) {
                                    pbxContext = s.value;
                                }
                            }
                        } catch (dbErr) {
                            console.error('[AiPredictiveEngine] Error fetching return extension settings:', dbErr.message);
                        }

                        if (returnExt && returnExt.trim() !== '') {
                            console.log(`[AiPredictiveEngine] No AI agents available for answered call on channel ${channelName}. Redirecting to return extension: ${returnExt}`);
                            amiService.redirectCall(channelName, pbxContext, returnExt, 1);

                            // Save call in call_history as "Retorno"
                            const contact = await getOrCreateContact(cleanPhone, LeadId);
                            const systemUser = await getOrCreateSystemUser();
                            await prisma.call_history.create({
                                data: {
                                    cliente_id: contact.id,
                                    operador_id: systemUser.id,
                                    data_inicio: new Date(),
                                    data_fim: new Date(),
                                    duracao: 0,
                                    status: 'abandon',
                                    label: 'Retorno (Sem Agente IA)',
                                    operator: 'Sistema (IA)',
                                    time: '00:00'
                                }
                            }).catch(() => {});
                        } else {
                            console.warn(`[AiPredictiveEngine] No active AI agent configured/available for answered AI call on channel ${channelName} and no fallback return extension set. Hanging up.`);
                            amiService.hangupCall(channelName);
                        }
                        return;
                    }

                    // --- CONNECTING CALL TO AI AGENT VIA CONFBRIDGE ---
                    console.log(`[AiPredictiveEngine] Assigning AI call on channel ${channelName} to AI Agent ${agentId} (${agentObj.name})`);

                    // Get or create Contact
                    const contact = await getOrCreateContact(cleanPhone, LeadId);

                    // Find or create Open Conversation
                    const conversation = await getOrCreateConversation(contact, agentId, cleanPhone);

                    // Create active call record in DB calls table
                    const callId = crypto.randomUUID();
                    const roomName = `sala_agente_${agentId}_${cleanPhone}`;

                    // Clean up any old call with the same room_name to prevent unique constraint violation
                    try {
                        await prisma.calls.deleteMany({
                            where: { room_name: roomName }
                        });
                    } catch (delErr) {
                        console.error(`[AiPredictiveEngine] Error deleting old call for room ${roomName}:`, delErr.message);
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

                    // Store the predictive call mapping to agentId
                    const uniqueId = event.Uniqueid;
                    if (uniqueId) {
                        await redisClient.set(`dialer:predictive_call_agent:${uniqueId}`, agentId, 'EX', 7200);
                    }

                    // Publish incoming call details to Redis PubSub for the AI agent worker
                    console.log(`[AiPredictiveEngine] Publishing incoming call for AI Agent ${agentId} to Redis PubSub.`);
                    await redisClient.publish('omniagent:incoming_call', JSON.stringify({
                        agent_id: agentId,
                        room_name: roomName,
                        phone: cleanPhone,
                        conversation_id: conversation.id,
                        contact_id: contact.id
                    }));

                    // Determine destination trunk details for LiveKit SIP
                    const sipHost = process.env.LIVEKIT_SIP_HOST || 'livekit-sip:5060';
                    const sipTrunk = process.env.LIVEKIT_SIP_TRUNK || 'anonymous';
                    let destData = `PJSIP/${sipTrunk}/sip:${roomName}@${sipHost}`;
                    const lkUrl = process.env.LIVEKIT_URL || '';
                    if (lkUrl.includes('localhost') || lkUrl.includes('127.0.0.1') || lkUrl.includes('omnichat_livekit')) {
                        try {
                            const ipRes = await fetch('https://api.ipify.org');
                            if (ipRes.ok) {
                                const publicIp = (await ipRes.text()).trim();
                                destData = `PJSIP/${sipTrunk}/sip:${roomName}@${publicIp}:5065`;
                                console.log(`[AiPredictiveEngine] Local development detected. Dialing LiveKit via public IP: ${destData}`);
                            }
                        } catch (ipErr) {
                            console.error('[AiPredictiveEngine] Failed to fetch public IP for local development:', ipErr.message);
                        }
                    }

                    console.log(`[AiPredictiveEngine] Routing call directly to LiveKit SIP trunk (Extension 9999) for Agent ${agentId} to Room ${roomName}`);

                    // 1. Store mappings in Redis for handoff and fallback lookups
                    await redisClient.set(`dialer:active_call_channel:${agentId}`, channelName, 'EX', 7200);
                    await redisClient.set(`dialer:room_channel:${roomName}`, channelName, 'EX', 7200);
                    await redisClient.set(`dialer:room_agent:${roomName}`, agentId, 'EX', 7200);

                    // 2. Set AGENT_ROOM variable on customer channel
                    amiService.setVariable(channelName, 'AGENT_ROOM', roomName);

                    // 3. Redirect customer channel directly to extension 9999 (SIP LiveKit) in cos-all context
                    amiService.redirectCall(channelName, 'cos-all', '9999', 1);

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

                    // Publish real-time answered call event to Redis PubSub
                    await redisClient.publish('dialer:events', JSON.stringify({
                        phone: cleanPhone,
                        status: 'atendida',
                        label: 'Atendida',
                        operator: agentObj.name,
                        time: '00:00'
                    }));

                } catch (error) {
                    console.error('[AiPredictiveEngine] Error routing AI answered call:', error);
                    amiService.hangupCall(channelName);
                }
            }
        });
    }
}
