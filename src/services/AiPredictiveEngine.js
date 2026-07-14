import crypto from 'crypto';
import prisma from '../config/db.js';
import redisClient from '../config/redis.js';
import { getOrCreateContact, getOrCreateSystemUser, getOrCreateConversation, cleanPhonePrefix } from '../routes/calls.js';
import { amiService } from './AMIService.js';

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
    async tick() {
        try {
            if (!this.running) return;
            const now = Date.now();
            const oneMinuteAgo = now - 60000;

            // Load settings from DB with fallbacks
            let cpm = 10;
            let maxChannels = 30;
            let pbxContext = 'triagem-amd-ia';
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
                                'dialer_ai_context',
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
                    } else if (s.key === 'dialer_ai_context' && s.value) {
                        pbxContext = s.value;
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

            // 5. Get current active concurrent AI dialing lines and cap disparos by trunk capacity
            const activeLines = await redisClient.scard('dialer:ai_active_dialing_channels') || 0;
            const availableLines = Math.max(0, maxChannels - activeLines);
            const disparos = Math.min(dialsNeeded, maxDialsPerTick, availableLines);

            if (now - this.lastSummaryLog > 10000) {
                console.log(`[AiPredictiveEngine] Pacing Loop - CPM Target: ${cpm}, Active Lines: ${activeLines}/${maxChannels}, Dials Last Min: ${recentDialsCount}/${targetCalls}, Needed: ${dialsNeeded}, Max/Tick: ${maxDialsPerTick}, Disparos: ${disparos}`);
                this.lastSummaryLog = now;
            }

            if (disparos > 0) {
                console.log(`[AiPredictiveEngine] Tick - Triggering ${disparos} paced AI disparos (Target: ${targetCalls}, Recent: ${recentDialsCount}).`);
                await this.triggerDialing(disparos, pbxContext, predictiveTrunk || pbxTrunk, useVoskAmd);
            }
        } catch (error) {
            console.error('[AiPredictiveEngine] Error in tick:', error);
        }
    }

    /**
     * Core dialer execution. Pops leads and originates calls.
     */
    async triggerDialing(disparos, pbxContext, pbxTrunk, useVoskAmd = true) {
        const resolvedPbxContext = pbxContext || 'triagem-amd-ia';
        const resolvedPbxTrunk = pbxTrunk && pbxTrunk.trim() !== '' ? pbxTrunk : '';
        
        // Check queue length
        let queueLength = await redisClient.llen('dialer:ai_lead_queue');
        
        // If queue is low, refill it from Postgres
        if (queueLength < disparos) {
            await this.refillLeadQueue();
            queueLength = await redisClient.llen('dialer:ai_lead_queue');
        }

        const countToPop = Math.min(disparos, queueLength);
        if (countToPop <= 0) return;

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
                    if (prefixSetting) {
                        prefix = prefixSetting.value || '';
                    }
                } catch (err) {
                    console.error('[AiPredictiveEngine] Error fetching AI prefix:', err.message);
                }

                let dialedPhone = lead.phone.replace(/\D/g, '');
                if ((dialedPhone.length === 12 || dialedPhone.length === 13) && dialedPhone.startsWith('55')) {
                    dialedPhone = dialedPhone.substring(2);
                }
                if (prefix && !dialedPhone.startsWith(prefix)) {
                    dialedPhone = prefix + dialedPhone;
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
                    PHONE: dialedPhone
                };

                // Add flag to bypass Vosk AMD in Asterisk dialplan if configured
                if (!useVoskAmd) {
                    variables.BYPASS_VOSK = '1';
                }

                amiService.originateCall(
                    destChannel,
                    resolvedPbxContext,
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
                where: { team_type: 'ia' },
                select: { id: true }
            });
            const iaTeamIds = iaTeams.map(t => t.id);
            if (iaTeamIds.length === 0) {
                console.log('[AiPredictiveEngine] No active AI teams found. Skipping refill.');
                return;
            }

            // 2. Find active predictive campaigns
            const activeCampaigns = await prisma.campaign.findMany({
                where: { dialingMode: 'predictive' }
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
                console.log('[AiPredictiveEngine] No active predictive AI campaigns found.');
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
                    })).catch(() => {});

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
                                            role: 'ai_agent',
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

                    if (!agentId || !agentObj) {
                        console.warn(`[AiPredictiveEngine] No AI agents available for answered AI call on channel ${channelName}. Checking AI return extension...`);
                        
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
                            console.error('[AiPredictiveEngine] Error fetching AI return extension settings:', dbErr.message);
                        }

                        if (returnExt && returnExt.trim() !== '') {
                            console.log(`[AiPredictiveEngine] Redirecting call on channel ${channelName} to AI return extension: ${returnExt}`);
                            amiService.redirectCall(channelName, pbxContext, returnExt, 1);
                        } else {
                            console.warn(`[AiPredictiveEngine] No AI return extension configured. Hanging up channel ${channelName}.`);
                            amiService.hangupCall(channelName);
                        }
                        return;
                    }

                    const numeroExterno = agentObj.numero_externo;
                    if (!numeroExterno || numeroExterno.trim() === '') {
                        console.error(`[AiPredictiveEngine] AI Agent ${agentObj.name} does not have a configured extension (numero_externo). Checking AI return extension...`);
                        
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
                            console.error('[AiPredictiveEngine] Error fetching AI return extension settings:', dbErr.message);
                        }

                        if (returnExt && returnExt.trim() !== '') {
                            console.log(`[AiPredictiveEngine] Redirecting call on channel ${channelName} to AI return extension: ${returnExt}`);
                            amiService.redirectCall(channelName, pbxContext, returnExt, 1);
                        } else {
                            console.warn(`[AiPredictiveEngine] No AI return extension configured. Hanging up channel ${channelName}.`);
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

                    console.log(`[AiPredictiveEngine] Routing call via ConfBridge for iaVoiceSip agent ${agentId} (Extension: ${numeroExterno}) to ${cleanPhone} (Room: ${roomName})`);
                    
                    // 1. Redirecionar o canal do cliente para o ConfBridge no contexto ami-dinamico com a extensão cleanPhone
                    amiService.redirectCall(channelName, 'ami-dinamico', cleanPhone, 1);
                    
                    // 2. Originar chamada para a IA (recuperando de users.numero_externo) e conectar ao mesmo ConfBridge
                    amiService.originateCall(
                        `Local/${numeroExterno}@cos-all-custom`, // Canal de origem
                        'ami-dinamico',                           // Contexto de destino
                        cleanPhone,                               // Extensão de destino (ConfBridge)
                        1,                                        // Prioridade
                        {
                            PHONE: cleanPhone
                        },
                        `conf_ai_${agentId}_${Date.now()}`
                    );

                    // 3. Originar chamada para o Trunk LiveKit (9999 / destData) e conectar ao mesmo ConfBridge
                    amiService.originateCall(
                        destData,                                     // Canal de origem
                        'ami-dinamico',                               // Contexto de destino
                        cleanPhone,                                   // Extensão de destino (ConfBridge)
                        1,                                            // Prioridade
                        {
                            AGENT_ROOM: roomName
                        },
                        `conf_livekit_${agentId}_${Date.now()}`
                    );

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
