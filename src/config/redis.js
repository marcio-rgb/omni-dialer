import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

let host = process.env.REDIS_HOST || 'localhost';
let port = parseInt(process.env.REDIS_PORT || '6379');

if (host.includes(':')) {
    const parts = host.split(':');
    host = parts[0];
    port = parseInt(parts[1]);
}

const redisUrl = process.env.REDIS_PASSWORD
    ? `redis://:${process.env.REDIS_PASSWORD}@${host}:${port}`
    : `redis://${host}:${port}`;

console.log(`[Redis Config] ioredis connecting to: redis://${host}:${port}`);

const redisClient = new Redis(redisUrl);

redisClient.on('error', (err) => console.error('[Redis Client Error]', err));

export default redisClient;
