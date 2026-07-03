import dotenv from 'dotenv';

dotenv.config();

export default {
    apiUrl: process.env.VITALPBX_API_URL || 'http://localhost:8089/api/v2',
    apiKey: process.env.VITALPBX_API_KEY || 'vitalpbx_secret_api_key',
    trunk: process.env.VITALPBX_TRUNK || 'Local/SIP_TRUNK_LIVEKIT',
    context: process.env.VITALPBX_CONTEXT || 'from-internal'
};
