import axios from 'axios';
import vitalpbxConfig from '../config/vitalpbx.js';
import prisma from '../config/db.js';

export class VitalPBXService {
    /**
     * Helper to load VitalPBX configuration from database settings, falling back to process.env.
     */
    static async getPBXConfig() {
        let apiUrl = vitalpbxConfig.apiUrl;
        let apiKey = vitalpbxConfig.apiKey;
        let trunk = vitalpbxConfig.trunk;
        let context = vitalpbxConfig.context;

        try {
            const dbSettings = await prisma.settings.findMany({
                where: {
                    key: {
                        in: ['vitalpbx_api_url', 'vitalpbx_api_key', 'vitalpbx_trunk', 'vitalpbx_context', 'vitalpbx_ip', 'vitalpbx_port']
                    }
                }
            });
            
            const settings = {};
            dbSettings.forEach(s => {
                settings[s.key] = s.value;
            });

            if (settings.vitalpbx_api_url) {
                apiUrl = settings.vitalpbx_api_url;
            } else if (settings.vitalpbx_ip) {
                const ip = settings.vitalpbx_ip;
                const port = settings.vitalpbx_port;
                const protocol = port === '443' ? 'https' : (port === '80' ? 'http' : (port ? 'http' : 'https'));
                const portStr = (port && port !== '443' && port !== '80') ? `:${port}` : '';
                apiUrl = `${protocol}://${ip}${portStr}/api/v2`;
            }

            if (settings.vitalpbx_api_key) {
                apiKey = settings.vitalpbx_api_key;
            }
            if (settings.vitalpbx_trunk) {
                trunk = settings.vitalpbx_trunk;
            }
            if (settings.vitalpbx_context) {
                context = settings.vitalpbx_context;
            }
        } catch (err) {
            console.error('[VitalPBXService] Error fetching vitalpbx settings from DB:', err.message);
        }

        return { apiUrl, apiKey, trunk, context };
    }

    /**
     * Originates a call to a customer's phone number.
     * @param {string} phone Customer's phone number
     * @param {string} leadId ID of the lead in Postgres
     * @param {number} campaignId ID of the campaign
     * @returns {Promise<object>} Response from VitalPBX containing channel/call ID
     */
    static async originateCall(phone, leadId, campaignId) {
        const channelId = `chan_${leadId || Date.now()}_${Math.floor(Math.random() * 1000)}`;

        // 1. Load prefix from setting
        let prefix = '';
        try {
            const prefixSetting = await prisma.settings.findUnique({
                where: { key: 'dialer_dial_prefix' }
            });
            if (prefixSetting) {
                prefix = prefixSetting.value || '';
            }
        } catch (err) {
            console.error('[VitalPBXService] Error fetching dialer prefix from DB:', err.message);
        }

        let dialedPhone = phone.replace(/\D/g, '');
        if (prefix && !dialedPhone.startsWith(prefix)) {
            dialedPhone = prefix + dialedPhone;
        }

        console.log(`[VitalPBXService] Originating call to ${dialedPhone} (Original: ${phone}, Lead: ${leadId}, Campaign: ${campaignId}, Channel: ${channelId})`);

        const isMock = (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') && process.env.VITALPBX_MOCK !== 'false';
        if (isMock) {
            // Simulator: Trigger a mock webhook answer after a random duration (e.g. 1000ms)
            // to simulate the customer picking up the phone.
            this.simulateIncomingAnswer(dialedPhone, leadId, campaignId, channelId);
            return { status: 'success', channelId, message: 'Mock call originated' };
        }

        const config = await this.getPBXConfig();

        try {
            const response = await axios.post(`${config.apiUrl}/calls/originate`, {
                channel: `${config.trunk}/${dialedPhone}`,
                context: config.context,
                extension: 's',
                priority: 1,
                callerId: 'DynamicCID',
                variables: {
                    CHANNEL_ID: channelId,
                    LEAD_ID: String(leadId),
                    CAMPAIGN_ID: String(campaignId),
                    PHONE: dialedPhone
                }
            }, {
                headers: {
                    'app-key': config.apiKey,
                    'Content-Type': 'application/json'
                }
            });

            return { status: 'success', channelId: response.data.channelId || channelId, data: response.data };
        } catch (error) {
            console.error(`[VitalPBXService] Error originating call to ${dialedPhone}:`, error.message);
            throw error;
        }
    }
    
    /**
     * Originates a manual call bridging an agent's ramal to a customer's phone.
     * @param {string} phone Customer's phone number
     * @param {string} ramal Agent's extension number
     * @returns {Promise<object>} Response from VitalPBX
     */
    static async originateManualCall(phone, ramal) {
        // 1. Load prefix from setting
        let prefix = '';
        try {
            const prefixSetting = await prisma.settings.findUnique({
                where: { key: 'dialer_dial_prefix' }
            });
            if (prefixSetting) {
                prefix = prefixSetting.value || '';
            }
        } catch (err) {
            console.error('[VitalPBXService] Error fetching dialer prefix from DB:', err.message);
        }

        let dialedPhone = phone.replace(/\D/g, '');
        if (prefix && !dialedPhone.startsWith(prefix)) {
            dialedPhone = prefix + dialedPhone;
        }

        console.log(`[VitalPBXService] Originating manual call bridging SIP/${ramal} to ${dialedPhone} (Original: ${phone})`);

        const isMock = (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') && process.env.VITALPBX_MOCK !== 'false';
        if (isMock) {
            return { status: 'success', message: 'Mock manual call originated successfully' };
        }

        const config = await this.getPBXConfig();

        try {
            const response = await axios.post(`${config.apiUrl}/calls/originate`, {
                channel: `SIP/${ramal}`,
                context: config.context,
                extension: dialedPhone,
                priority: 1,
                callerId: `Agent_${ramal}`
            }, {
                headers: {
                    'app-key': config.apiKey,
                    'Content-Type': 'application/json'
                }
            });
            return { status: 'success', data: response.data };
        } catch (error) {
            console.error(`[VitalPBXService] Error originating manual call bridging SIP/${ramal} to ${dialedPhone}:`, error.message);
            throw error;
        }
    }

    /**
     * Transfers an active call to the LiveKit SIP trunk.
     * @param {string} channelId Active call channel ID
     * @param {string} roomName Name of the LiveKit room
     */
    static async transferCall(channelId, roomName) {
        const sipHost = process.env.LIVEKIT_SIP_HOST || 'livekit-sip:5060';
        const destination = `sip:${roomName}@${sipHost}`;
        console.log(`[VitalPBXService] Transferring channel ${channelId} to ${destination}`);

        if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') {
            console.log(`[VitalPBXService] [MOCK] Channel ${channelId} successfully transferred to LiveKit SIP room ${roomName}`);
            return { status: 'success', message: 'Mock transfer success' };
        }

        const config = await this.getPBXConfig();

        try {
            const response = await axios.post(`${config.apiUrl}/channels/${channelId}/transfer`, {
                destination: destination,
                context: config.context
            }, {
                headers: {
                    'app-key': config.apiKey,
                    'Content-Type': 'application/json'
                }
            });
            return response.data;
        } catch (error) {
            console.error(`[VitalPBXService] Error transferring channel ${channelId}:`, error.message);
            throw error;
        }
    }

    /**
     * Transfers an active call to a specific Asterisk extension on VitalPBX.
     * @param {string} channelId PBX channel ID
     * @param {string} extension Destination extension (e.g. queue number or extension number)
     * @param {string} context Destination context (optional)
     */
    static async transferCallToExtension(channelId, extension, context = null) {
        console.log(`[VitalPBXService] Transferring channel ${channelId} to extension ${extension}`);

        if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') {
            console.log(`[VitalPBXService] [MOCK] Channel ${channelId} successfully transferred to extension ${extension}`);
            return { status: 'success', message: 'Mock transfer to extension success' };
        }

        const config = await this.getPBXConfig();
        const destContext = context || config.context;

        try {
            const response = await axios.post(`${config.apiUrl}/channels/${channelId}/transfer`, {
                destination: extension,
                context: destContext
            }, {
                headers: {
                    'app-key': config.apiKey,
                    'Content-Type': 'application/json'
                }
            });
            return response.data;
        } catch (error) {
            console.error(`[VitalPBXService] Error transferring channel ${channelId} to extension ${extension}:`, error.message);
            throw error;
        }
    }

    /**
     * Hangs up/terminates a call.
     * @param {string} channelId Active call channel ID
     */
    static async hangupCall(channelId) {
        console.log(`[VitalPBXService] Hanging up channel ${channelId}`);

        if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') {
            console.log(`[VitalPBXService] [MOCK] Channel ${channelId} terminated (hung up)`);
            return { status: 'success', message: 'Mock hangup success' };
        }

        const config = await this.getPBXConfig();

        try {
            const response = await axios.post(`${config.apiUrl}/channels/${channelId}/hangup`, {}, {
                headers: {
                    'app-key': config.apiKey,
                    'Content-Type': 'application/json'
                }
            });
            return response.data;
        } catch (error) {
            console.error(`[VitalPBXService] Error hanging up channel ${channelId}:`, error.message);
            throw error;
        }
    }

    /**
     * Simulator helper to trigger an answer event webhook asynchronously.
     */
    static simulateIncomingAnswer(phone, leadId, campaignId, channelId) {
        setTimeout(async () => {
            try {
                const port = process.env.PORT || 5001;
                // Post back to our own webhook
                await axios.post(`http://localhost:${port}/api/v1/calls/webhooks/livekit`, {
                    event: 'call.answered',
                    channelId,
                    phone,
                    leadId,
                    campaignId
                });
                console.log(`[VitalPBXService] [MOCK] Fired webhook: call.answered for channel ${channelId}`);
            } catch (err) {
                console.warn(`[VitalPBXService] [MOCK] Webhook simulation failed (Server probably not running yet): ${err.message}`);
            }
        }, 1000);
    }
}
