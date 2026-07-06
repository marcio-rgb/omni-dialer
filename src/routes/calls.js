import crypto from 'crypto';
import prisma from '../config/db.js';
import redisClient from '../config/redis.js';
import { VitalPBXService } from '../services/VitalPBXService.js';
import { LiveKitService } from '../services/LiveKitService.js';
import { amiService } from '../services/AMIService.js';

// In-memory registry to track agent WebSocket connections
export const activeSockets = new Map();

async function getDialedPhoneWithPrefix(phone) {
    let prefix = '';
    try {
        const prefixSetting = await prisma.settings.findUnique({
            where: { key: 'dialer_dial_prefix' }
        });
        if (prefixSetting) {
            prefix = prefixSetting.value || '';
        }
    } catch (err) {
        console.error('[calls] Error fetching dialer prefix from DB:', err.message);
    }

    let dialedPhone = phone.replace(/\D/g, '');
    
    // Strip Brazilian country code (55) if present (12 or 13 digits starting with 55)
    if ((dialedPhone.length === 12 || dialedPhone.length === 13) && dialedPhone.startsWith('55')) {
        dialedPhone = dialedPhone.substring(2);
    }

    if (prefix && !dialedPhone.startsWith(prefix)) {
        dialedPhone = prefix + dialedPhone;
    }
    return dialedPhone;
}

function getHangupCauseMessage(causeCode, causeText) {
    const code = parseInt(causeCode);
    switch (code) {
        case 16:
            return 'Chamada encerrada.';
        case 17:
            return 'O número de destino está ocupado.';
        case 18:
        case 19:
            return 'O cliente não atendeu a chamada (sem resposta).';
        case 21:
            return 'A chamada foi rejeitada pelo destinatário.';
        case 1:
        case 28:
            return 'O número discado é inexistente ou inválido.';
        case 27:
            return 'O destino está fora de serviço.';
        case 34:
        case 38:
        case 41:
        case 42:
            return 'Falha na rede de telefonia ou linha congestionada.';
        default:
            return causeText || 'Chamada finalizada.';
    }
}

export default async function callRoutes(fastify, opts) {
    // Listen to OriginateResponse to handle call failures and notify agents
    amiService.on('OriginateResponse', async (event) => {
        const actionId = event.ActionID;
        if (!actionId) return;

        console.log(`[AMI] OriginateResponse received. ActionID: ${actionId}, Response: ${event.Response}, Reason: ${event.Reason}`);

        const isManual = actionId.startsWith('manual_');
        const isWebRTC = actionId.startsWith('webrtc_');

        if (isManual || isWebRTC) {
            const parts = actionId.split('_');
            const agentId = parts[1];

            if (event.Response === 'Failure') {
                // 1. Reset agent status to "disponivel" in DB so they are not stuck
                try {
                    await prisma.users.update({
                        where: { id: agentId },
                        data: {
                            agent_status: 'disponivel',
                            agent_status_reason: 'Call Failed'
                        }
                    });
                } catch (err) {
                    console.error(`[AMI] Error updating agent status on fail:`, err.message);
                }

                // 2. Notify the agent via WebSocket
                const socket = activeSockets.get(agentId);
                if (socket && socket.readyState === 1) {
                    socket.send(JSON.stringify({
                        event: 'agent.error',
                        data: {
                            message: 'A chamada falhou. Verifique o número ou tente novamente.'
                        }
                    }));
                }
            } else if (event.Response === 'Success') {
                const uniqueId = event.Uniqueid;
                if (uniqueId) {
                    console.log(`[AMI] Mapping manual call Uniqueid ${uniqueId} to Agent ${agentId}`);
                    try {
                        await redisClient.set(`dialer:manual_call_agent:${uniqueId}`, agentId, 'EX', 7200);
                        
                        // Link Uniqueid to manual call details (roomName, phone)
                        const infoStr = await redisClient.get(`dialer:manual_call_info:${agentId}`);
                        if (infoStr) {
                            const info = JSON.parse(infoStr);
                            await redisClient.hset(`dialer:manual_calls:${uniqueId}`, {
                                agentId: agentId,
                                roomName: info.roomName,
                                phone: info.phone
                            });
                            await redisClient.expire(`dialer:manual_calls:${uniqueId}`, 7200);
                        }
                    } catch (err) {
                        console.error('[AMI] Error saving manual call mapping to Redis:', err.message);
                    }
                }
            }
        }
    });

    async function handleCallRecording(uniqueId) {
        console.log(`[Recording] Notifying OmniChat backend about Hangup for uniqueId: ${uniqueId}`);
        try {
            let roomName = null;
            let phone = null;

            // Check if it is a manual WebRTC call
            const manualCallInfo = await redisClient.hgetall(`dialer:manual_calls:${uniqueId}`);
            if (manualCallInfo && manualCallInfo.roomName) {
                roomName = manualCallInfo.roomName;
                phone = manualCallInfo.phone;
                // Clean up Redis mapping
                await redisClient.del(`dialer:manual_calls:${uniqueId}`);
            }

            const chatServerUrl = process.env.DIALER_OMNICHAT_SERVER_URL || 'http://server:3000';
            console.log(`[Recording] Posting to: ${chatServerUrl}/api/v1/calls/process-recording`);
            
            await axios.post(`${chatServerUrl}/api/v1/calls/process-recording`, {
                uniqueId,
                roomName,
                phone
            });
        } catch (err) {
            console.error(`[Recording] Failed to notify OmniChat about recording for uniqueId ${uniqueId}:`, err.message);
        }
    }

    // Listen to Hangup events to detect when a manual call ends
    amiService.on('Hangup', async (event) => {
        const uniqueId = event.Uniqueid;
        if (!uniqueId) return;

        try {
            // Check if this Uniqueid is mapped to a manual call agent
            const agentId = await redisClient.get(`dialer:manual_call_agent:${uniqueId}`);
            if (agentId) {
                console.log(`[AMI] Hangup received for manual call channel ${event.Channel} (Uniqueid: ${uniqueId}) associated with Agent ${agentId}. Cause: ${event.Cause} (${event['Cause-txt']})`);
                
                // Remove the mapping
                await redisClient.del(`dialer:manual_call_agent:${uniqueId}`);

                // 1. Reset agent status to "disponivel" in DB
                await prisma.users.update({
                    where: { id: agentId },
                    data: {
                        agent_status: 'disponivel',
                        agent_status_reason: 'Call Ended'
                    }
                });

                // 2. Translate cause code to user-friendly message
                const causeCode = event.Cause || '16';
                const causeText = event['Cause-txt'] || '';
                const message = getHangupCauseMessage(causeCode, causeText);

                // 3. Notify the agent via WebSocket
                const socket = activeSockets.get(agentId);
                if (socket && socket.readyState === 1) {
                    socket.send(JSON.stringify({
                        event: 'agent.call_ended',
                        data: {
                            message: message,
                            causeCode: String(causeCode),
                            causeText: causeText
                        }
                    }));
                }
            }

            // Immediately notify OmniChat backend to process recording (delegated to Bull queue)
            handleCallRecording(uniqueId).catch(recErr => {
                console.error(`[Recording] Error triggering call recording processing for uniqueId ${uniqueId}:`, recErr.message);
            });

        } catch (err) {
            console.error(`[AMI] Error processing Hangup event for Uniqueid ${uniqueId}:`, err.message);
        }
    });

    // WebSocket route for agents presence and status updates
    fastify.get('/ws', { websocket: true }, (connection, req) => {
        const agentId = req.query?.agentId;
        if (!agentId) {
            console.error('[WebSocket] Connection rejected: agentId missing from query parameters.');
            connection.socket.close(4001, 'agentId is required');
            return;
        }

        const socket = connection.socket;
        console.log(`[WebSocket] Agent connected: ${agentId} (Socket active)`);

        // Register the active connection
        activeSockets.set(agentId, socket);

        // Update database and Redis status (non-blocking)
        prisma.users.update({
            where: { id: agentId },
            data: {
                agent_status: 'pausa',
                agent_status_reason: 'Connected (WebSocket)'
            }
        }).then(() => {
            return redisClient.zrem('dialer:idle_agents', agentId);
        }).catch(err => {
            console.error(`[WebSocket] Error initializing agent status in DB:`, err.message);
        });

        // Handle incoming messages from the agent client
        socket.on('message', async (messageStr) => {
            console.log(`[WebSocket] Raw message received from Agent ${agentId}:`, messageStr.toString());
            try {
                const message = JSON.parse(messageStr.toString());
                const { event, data } = message;

                if (event === 'agent.update_status') {
                    const { status } = data;
                    if (!status) return;

                    console.log(`[WebSocket] Agent ${agentId} status change request: ${status}`);

                    // 1. Update in Postgres
                    const agent = await prisma.users.update({
                        where: { id: agentId },
                        data: {
                            agent_status: status,
                            agent_status_reason: 'User manual state'
                        }
                    });

                    let token = null;
                    const roomName = `sala_agente_${agentId}`;

                    // 2. Manage in Redis ZSET (FIFO: Score is current timestamp)
                    if (status === 'disponivel') {
                        try {
                            // Create or ensure the room is active on LiveKit
                            await LiveKitService.createRoom(roomName);
                            // Generate token for agent to join
                            const agentName = agent?.name || `Agente ${agentId}`;
                            token = await LiveKitService.generateToken(roomName, agentName, true);
                            
                            await redisClient.zadd('dialer:idle_agents', Date.now(), agentId);
                            console.log(`[WebSocket] Agent ${agentId} added to idle queue ZSET. Room: ${roomName}`);
                        } catch (lkErr) {
                            console.error(`[WebSocket] LiveKit error for agent ${agentId}:`, lkErr.message);
                            // Fallback status to pause if LiveKit fails
                            await prisma.users.update({
                                where: { id: agentId },
                                data: {
                                    agent_status: 'pausa',
                                    agent_status_reason: 'LiveKit Room creation failed'
                                }
                            });
                            socket.send(JSON.stringify({
                                event: 'agent.error',
                                data: { message: 'Erro ao conectar ao servidor de áudio (LiveKit)' }
                            }));
                            return;
                        }
                    } else {
                        await redisClient.zrem('dialer:idle_agents', agentId);
                        console.log(`[WebSocket] Agent ${agentId} removed from idle queue ZSET.`);
                    }

                    // Acknowledge change
                    socket.send(JSON.stringify({
                        event: 'agent.status_updated',
                        data: { 
                            status,
                            token,
                            room_name: status === 'disponivel' ? roomName : null
                        }
                    }));
                }
            } catch (err) {
                console.error(`[WebSocket] Error processing agent message:`, err.message);
                socket.send(JSON.stringify({
                    event: 'agent.error',
                    data: { message: 'Invalid payload or action' }
                }));
            }
        });

        // Handle client disconnection
        // Handle client disconnection
        socket.on('close', async () => {
            console.log(`[WebSocket] Agent disconnected: ${agentId}`);
            activeSockets.delete(agentId);

            try {
                // Update agent to pause in Postgres to remove from predictive calculations
                await prisma.users.update({
                    where: { id: agentId },
                    data: {
                        agent_status: 'pausa',
                        agent_status_reason: 'Disconnected (WebSocket)'
                    }
                });
                
                // Remove from Redis idle queue ZSET
                await redisClient.zrem('dialer:idle_agents', agentId);
                console.log(`[WebSocket] Cleaned up agent ${agentId} from ZSET queue.`);
            } catch (err) {
                console.error(`[WebSocket] Error on agent disconnect cleanup for ${agentId}:`, err.message);
            }
        });
    });

    /**
     * POST /manual
     * Initiates an individual manual call bridging agent's ramal to customer number.
     */
    fastify.post('/manual', async (request, reply) => {
        const { phone, agentId } = request.body || {};

        if (!phone || !agentId) {
            reply.code(400);
            return { error: 'Phone and agentId are required' };
        }

        try {
            // 1. Fetch agent and check ramal configuration
            const agent = await prisma.users.findUnique({
                where: { id: agentId }
            });

            if (!agent) {
                reply.code(404);
                return { error: 'Agent not found' };
            }

            if (!agent.ramal) {
                reply.code(400);
                return { error: 'Agent SIP ramal (extension) is not configured' };
            }

            // 2. Temporarily update agent status to pausa/chamada_manual to exclude from predictive calculation
            await prisma.users.update({
                where: { id: agentId },
                data: {
                    agent_status: 'chamada_manual',
                    agent_status_reason: 'Manual Outbound Call'
                }
            });

            // 3. Remove agent from Redis idle queue ZSET
            await redisClient.zrem('dialer:idle_agents', agentId);

            const dialedPhone = await getDialedPhoneWithPrefix(phone);
            console.log(`[ManualCall] Removed agent ${agentId} from idle queue. Triggering AMI manual call to ${dialedPhone} from ramal ${agent.ramal}`);

            // 4. Trigger manual originate command via AMI
            // Dials the agent's ramal first, and upon answering, dials the customer via cos-all
            amiService.originateCall(
                `Local/${agent.ramal}@cos-all`,
                'cos-all',
                dialedPhone,
                1,
                {
                    AGENT_ID: String(agentId),
                    PHONE: dialedPhone
                },
                `manual_${agentId}_${Date.now()}`
            );

            return {
                message: 'Manual call triggered successfully',
                data: { status: 'success' }
            };
        } catch (error) {
            console.error('[ManualCall] Error initiating manual call:', error);
            reply.code(500);
            return { error: 'Failed to initiate manual call', details: error.message };
        }
    });

    /**
     * POST /manual-webrtc
     * Triggers Asterisk via AMI to call a customer and bridge them to the agent's WebRTC LiveKit room.
     */
    fastify.post('/manual-webrtc', async (request, reply) => {
        const { phone, roomName, agentId } = request.body || {};

        if (!phone || !roomName || !agentId) {
            reply.code(400);
            return { error: 'phone, roomName, and agentId are required' };
        }

        try {
            const dialedPhone = await getDialedPhoneWithPrefix(phone);
            console.log(`[ManualWebRTC] Triggering manual WebRTC call via AMI to ${dialedPhone} for Room ${roomName} (Agent: ${agentId})`);

            // Save roomName and phone to Redis keyed by agentId for mapping in OriginateResponse
            await redisClient.set(`dialer:manual_call_info:${agentId}`, JSON.stringify({
                roomName,
                phone: dialedPhone
            }), 'EX', 600); // 10 minutes TTL

            // Check if we are in local development
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
                        console.log(`[ManualWebRTC] Local development detected. Dialing via public IP: ${destData}`);
                    }
                } catch (ipErr) {
                    console.error('[ManualWebRTC] Failed to fetch public IP for local development:', ipErr.message);
                }
            }
            
            amiService.originateCallApp(
                `Local/${dialedPhone}@cos-all`,
                'Dial',
                destData,
                {
                    AGENT_ID: String(agentId),
                    PHONE: dialedPhone
                },
                `webrtc_${agentId}_${Date.now()}`
            );

            return { success: true };
        } catch (error) {
            console.error('[ManualWebRTC] Error initiating manual WebRTC call:', error);
            reply.code(500);
            return { error: 'Failed to initiate manual WebRTC call', details: error.message };
        }
    });

    /**
     * POST /webhooks/livekit
     * Webhook triggered by VitalPBX when a customer answers the phone.
     */
    fastify.post('/webhooks/livekit', async (request, reply) => {
        const { event, channelId, phone, leadId, campaignId } = request.body || {};

        // Filter events - only interested in answered calls
        if (event !== 'call.answered') {
            return { message: 'Event ignored' };
        }

        if (!channelId || !phone) {
            reply.code(400);
            return { error: 'channelId and phone are required for answered calls' };
        }

        console.log(`[Webhook] Call answered - Channel: ${channelId}, Phone: ${phone}, Lead: ${leadId}`);

        try {
            // Check if this channelId belongs to a manual WebRTC call
            const manualRoom = await redisClient.get(`dialer:manual_room:${channelId}`);
            if (manualRoom) {
                console.log(`[Webhook] Manual WebRTC call answered on channel ${channelId}. Room: ${manualRoom}`);
                // Immediately transfer to LiveKit room
                await VitalPBXService.transferCall(channelId, manualRoom);

                // Clean up tracking in Redis
                await redisClient.srem('dialer:active_dialing_channels', channelId);
                await redisClient.del(`dialer:dialing_calls:${channelId}`);
                await redisClient.del(`dialer:manual_room:${channelId}`);

                return { status: 'success', message: 'Manual WebRTC call bridged successfully' };
            }

            // 1. Pop the agent that has been idle (ocioso) the longest atomically from Redis ZSET
            const popped = await redisClient.zpopmin('dialer:idle_agents', 1);
            
            let agentId = null;
            if (popped && popped.length > 0) {
                agentId = popped[0]; // Popped member is the first item in the array returned by ioredis zpopmin
            }

            // --- RULE: CONTROLE DE ABANDONO (Abandon Prevention) ---
            if (!agentId) {
                console.warn(`[Webhook] ZERO available agents for answered call on channel ${channelId}. Executing abandonment protocol.`);

                // 1. Command VitalPBX to hangup the call immediately (< 2 seconds)
                await VitalPBXService.hangupCall(channelId);

                // 2. Fetch or create contact in DB
                const contact = await getOrCreateContact(phone, leadId);

                // 3. Find or create a system user to record the abandonment history
                const systemUser = await getOrCreateSystemUser();

                // 4. Save call in call_history as "Abandono"
                await prisma.call_history.create({
                    data: {
                        cliente_id: contact.id,
                        agente_id: systemUser.id,
                        status: 'Abandono',
                        duracao: 0,
                        data_inicio: new Date()
                    }
                });

                // 5. Clean up dialing tracking in Redis
                await redisClient.srem('dialer:active_dialing_channels', channelId);
                await redisClient.del(`dialer:dialing_calls:${channelId}`);

                // 6. Inflate success rate in Redis temporarily to freeze dialer (positional parameters for ioredis)
                await redisClient.set('dialer:inflated_success_rate', '1.0', 'EX', 30); // 30 seconds TTL

                return { status: 'abandoned', message: 'Call hung up due to lack of available agents' };
            }

            // --- CONNECTING CALL TO AGENT ---
            // 3. Update agent status in Postgres to ocupado
            const agent = await prisma.users.update({
                where: { id: agentId },
                data: {
                    agent_status: 'ocupado',
                    agent_status_reason: 'In Call'
                }
            });

            // 4. Get or create Contact
            const contact = await getOrCreateContact(phone, leadId);

            // 5. Find or create Open Conversation
            const conversation = await getOrCreateConversation(contact, agentId, phone);

            // 6. Create LiveKit Room
            const roomName = `room_${channelId}`;
            await LiveKitService.createRoom(roomName);

            // 7. Generate LiveKit token for the agent
            const agentName = agent.name || `Agent ${agent.id}`;
            const agentToken = await LiveKitService.generateToken(roomName, agentName, true);

            // 8. Write active call record to DB calls table
            const callId = crypto.randomUUID();
            await prisma.calls.create({
                data: {
                    id: callId,
                    conversation_id: conversation.id,
                    room_name: roomName,
                    status: 'active',
                    agent_id: agentId
                }
            });

            // 9. Emit agent.incoming_call event via active WebSocket
            const agentSocket = activeSockets.get(agentId);
            if (agentSocket && agentSocket.readyState === 1 /* OPEN */) {
                console.log(`[Webhook] Emitting incoming call event to Agent ${agentId} for room ${roomName} via WebSocket`);
                agentSocket.send(JSON.stringify({
                    event: 'agent.incoming_call',
                    data: {
                        token: agentToken,
                        room_name: roomName,
                        cpf: contact.cpf || null,
                        name: contact.name,
                        phone: phone
                    }
                }));
            } else {
                console.warn(`[Webhook] Active WebSocket connection not found for Agent ${agentId}. Alerting bypassed.`);
            }

            // 10. Command VitalPBX to transfer call to LiveKit SIP trunk
            await VitalPBXService.transferCall(channelId, roomName);

            // 11. Publish real-time answered call event to Redis PubSub
            let operatorName = '';
            if (agentId) {
                try {
                    const agentUser = await prisma.users.findUnique({
                        where: { id: agentId },
                        select: { name: true }
                    });
                    operatorName = agentUser?.name || '';
                } catch (dbErr) {
                    console.error('[Webhook] Failed to fetch agent name:', dbErr.message);
                }
            }

            await redisClient.publish('dialer:events', JSON.stringify({
                phone: phone,
                status: 'atendida',
                label: 'Atendida',
                operator: operatorName,
                time: '00:00'
            })).catch(pubErr => {
                console.error('[Webhook] Failed to publish answered event:', pubErr.message);
            });

            // 12. Remove from Redis active dialing sets
            await redisClient.srem('dialer:active_dialing_channels', channelId);
            await redisClient.del(`dialer:dialing_calls:${channelId}`);

            return {
                status: 'connected',
                agentId,
                roomName
            };

        } catch (error) {
            console.error('[Webhook] Error processing answered call webhook:', error);
            reply.code(500);
            return { error: 'Failed to process answered call webhook', details: error.message };
        }
    });
}

// --- DATABASE HELPERS ---

export async function getOrCreateContact(phone, leadId) {
    let contact = null;
    let lead = null;

    // 1. Retrieve lead details first if leadId is provided to find CPF
    if (leadId) {
        lead = await prisma.lead.findUnique({
            where: { id: parseInt(leadId) }
        }).catch(() => null);
    }

    const cpf = lead ? (lead.extraData?.cpf || null) : null;

    // 2. Search first by CPF
    if (cpf) {
        contact = await prisma.contacts.findFirst({
            where: { cpf: cpf }
        });
    }

    // 3. Search second by Phone
    if (!contact) {
        const phoneRecord = await prisma.contact_phones.findFirst({
            where: { phone: phone },
            include: { contacts: true }
        });
        if (phoneRecord) {
            contact = phoneRecord.contacts;
        }
    }

    if (contact) {
        // Upsert/enrich name or CPF if they were missing
        const updatedData = {};
        if (lead && lead.name && (!contact.name || contact.name.startsWith('Customer') || contact.name === 'Sem Nome')) {
            updatedData.name = lead.name;
        }
        if (cpf && !contact.cpf) {
            updatedData.cpf = cpf;
        }

        if (Object.keys(updatedData).length > 0) {
            contact = await prisma.contacts.update({
                where: { id: contact.id },
                data: updatedData
            });
        }

        // Ensure the phone record mapping exists for this contact
        const existingPhone = await prisma.contact_phones.findFirst({
            where: { contact_id: contact.id, phone: phone }
        });
        if (!existingPhone) {
            await prisma.contact_phones.create({
                data: {
                    id: crypto.randomUUID(),
                    contact_id: contact.id,
                    phone: phone
                }
            });
        }
    } else {
        // 4. Create new contact
        const contactId = crypto.randomUUID();
        contact = await prisma.contacts.create({
            data: {
                id: contactId,
                name: lead ? lead.name : `Customer ${phone}`,
                cpf: cpf,
                updated_at: new Date()
            }
        });

        // Save phone number mapping
        await prisma.contact_phones.create({
            data: {
                id: crypto.randomUUID(),
                contact_id: contactId,
                phone: phone
            }
        });
    }

    return contact;
}

export async function getOrCreateSystemUser() {
    let systemUser = await prisma.users.findUnique({
        where: { email: 'dialer@omnichat.internal' }
    });

    if (!systemUser) {
        systemUser = await prisma.users.create({
            data: {
                id: 'system_dialer',
                name: 'System Dialer',
                email: 'dialer@omnichat.internal',
                password: 'system_dialer_encrypted_pwd_placeholder',
                role: 'admin',
                agent_status: 'ocupado'
            }
        });
    }

    return systemUser;
}

export async function getOrCreateConversation(contact, agentId, phone) {
    // Find open conversation for the contact
    let conversation = await prisma.conversations.findFirst({
        where: {
            contact_id: contact.id,
            status: 'open'
        }
    });

    if (!conversation) {
        // Find first available inbox
        let inbox = await prisma.inboxes.findFirst();
        if (!inbox) {
            inbox = await prisma.inboxes.create({
                data: {
                    id: 'default_dialer_inbox',
                    name: 'Dialer Inbox',
                    channel_type: 'webchat',
                    config: {}
                }
            });
        }

        const convId = crypto.randomUUID();
        conversation = await prisma.conversations.create({
            data: {
                id: convId,
                inbox_id: inbox.id,
                contact_id: contact.id,
                status: 'open',
                assigned_to: agentId,
                phone_number: phone,
                updated_at: new Date()
            }
        });
    }

    return conversation;
}
