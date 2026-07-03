import dotenv from 'dotenv';
import { RoomServiceClient } from 'livekit-server-sdk';

dotenv.config();

const livekitUrl = process.env.LIVEKIT_URL || 'http://localhost:7880';
const apiKey = process.env.LIVEKIT_API_KEY || 'devkey';
const apiSecret = process.env.LIVEKIT_API_SECRET || 'secret';

const roomServiceClient = new RoomServiceClient(livekitUrl, apiKey, apiSecret);

export { roomServiceClient, livekitUrl, apiKey, apiSecret };
