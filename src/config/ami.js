import dotenv from 'dotenv';

dotenv.config();

export default {
    host: process.env.AMI_HOST || 'localhost',
    port: parseInt(process.env.AMI_PORT || '5038'),
    user: process.env.AMI_USER || 'admin',
    secret: process.env.AMI_SECRET || 'secret'
};
