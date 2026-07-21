import dotenv from 'dotenv';
import { RoomServiceClient } from 'livekit-server-sdk';

dotenv.config();

const livekitUrl = process.env.LIVEKIT_URL || 'http://localhost:7880';
const apiKey = process.env.LIVEKIT_API_KEY || 'omnichat_livekit_key';
const apiSecret = process.env.LIVEKIT_API_SECRET || 'OmniChat_LiveKit_Secret_Key_2026_SecurePass!987';

const roomServiceClient = new RoomServiceClient(livekitUrl, apiKey, apiSecret);

export { roomServiceClient, livekitUrl, apiKey, apiSecret };
