import { AccessToken } from 'livekit-server-sdk';
import { roomServiceClient, apiKey, apiSecret } from '../config/livekit.js';

export class LiveKitService {
    /**
     * Creates a room in LiveKit if it doesn't already exist.
     * @param {string} roomName
     */
    static async createRoom(roomName) {
        console.log(`[LiveKitService] Creating room: ${roomName}`);
        try {
            await roomServiceClient.createRoom({
                name: roomName,
                emptyTimeout: 300 // 5 minutes
            });
            console.log(`[LiveKitService] Room ${roomName} created successfully.`);
        } catch (error) {
            console.warn(`[LiveKitService] Room creation warning for ${roomName}: ${error.message}`);
        }
    }

    /**
     * Generates a LiveKit JWT token for a participant.
     * @param {string} roomName
     * @param {string} identity
     * @param {boolean} isAgent
     */
    static async generateToken(roomName, identity, isAgent = false) {
        console.log(`[LiveKitService] Generating token for ${identity} in room ${roomName} (isAgent: ${isAgent})`);
        const at = new AccessToken(apiKey, apiSecret, {
            identity: identity,
            name: identity
        });

        at.addGrant({
            roomCreate: isAgent,
            roomJoin: true,
            room: roomName,
            canSubscribe: true,
            canPublish: true,
            canPublishData: true
        });

        return await at.toJwt();
    }
}
