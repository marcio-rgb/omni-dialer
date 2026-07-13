import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import prisma from '../config/db.js';

export class ElevenLabsService {
    static getClient(apiKey) {
        const key = apiKey || process.env.ELEVEN_API_KEY;
        if (!key) {
            throw new Error("ELEVEN_API_KEY is not configured");
        }
        return new ElevenLabsClient({ apiKey: key });
    }

    /**
     * Initiates an outbound SIP call using ElevenLabs.
     * @param {object} params
     * @param {string} params.agentId ElevenLabs Agent ID
     * @param {string} [params.apiKey] ElevenLabs API Key
     * @param {string} [params.phoneNumberId] ElevenLabs Phone Number ID / Trunk ID
     * @param {string} params.toNumber Destination phone number
     */
    static async outboundCall({ agentId, apiKey, phoneNumberId, toNumber }) {
        console.log(`[ElevenLabsService] Initiating outbound SIP call for agent ${agentId} to ${toNumber}...`);
        const client = this.getClient(apiKey);
        
        const phoneId = phoneNumberId || process.env.ELEVENLABS_PHONE_NUMBER_ID;
        if (!phoneId) {
            throw new Error("ELEVENLABS_PHONE_NUMBER_ID is not configured");
        }

        try {
            const response = await client.conversationalAi.sipTrunk.outboundCall({
                agentId: agentId,
                agentPhoneNumberId: phoneId,
                toNumber: toNumber
            });
            console.log(`[ElevenLabsService] Outbound SIP call initiated successfully:`, response);
            return response;
        } catch (error) {
            console.error(`[ElevenLabsService] Failed to initiate outbound SIP call:`, error.message);
            throw error;
        }
    }
}
