import net from 'net';
import EventEmitter from 'events';
import amiConfig from '../config/ami.js';

class AMIService extends EventEmitter {
    constructor() {
        super();
        this.socket = null;
        this.connected = false;
        this.buffer = '';
        this.reconnectTimeout = null;
        
        this.host = amiConfig.host;
        this.port = amiConfig.port;
        this.user = amiConfig.user;
        this.secret = amiConfig.secret;
    }

    connect() {
        if (this.socket) {
            this.socket.destroy();
        }

        console.log(`[AMI] Connecting to Asterisk at ${this.host}:${this.port}...`);
        this.socket = new net.Socket();
        this.buffer = '';

        this.socket.connect(this.port, this.host, () => {
            console.log(`[AMI] TCP connection established. Sending login...`);
            this.sendAction({
                Action: 'Login',
                Username: this.user,
                Secret: this.secret
            });
        });

        this.socket.on('data', (chunk) => {
            this.buffer += chunk.toString();
            let boundary = this.buffer.indexOf('\r\n\r\n');
            while (boundary !== -1) {
                const packetStr = this.buffer.substring(0, boundary);
                this.buffer = this.buffer.substring(boundary + 4);
                this.handlePacket(packetStr);
                boundary = this.buffer.indexOf('\r\n\r\n');
            }
        });

        this.socket.on('close', () => {
            if (this.connected) {
                console.warn('[AMI] Connection closed by Asterisk.');
            }
            this.connected = false;
            this.scheduleReconnect();
        });

        this.socket.on('error', (err) => {
            console.error('[AMI] Socket error:', err.message);
        });
    }

    scheduleReconnect() {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }
        this.reconnectTimeout = setTimeout(() => {
            console.log('[AMI] Attempting reconnection...');
            this.connect();
        }, 5000);
    }

    sendAction(actionObj) {
        let actionStr = '';
        for (const [key, value] of Object.entries(actionObj)) {
            actionStr += `${key}: ${value}\r\n`;
        }
        actionStr += '\r\n';

        if (this.socket && !this.socket.destroyed) {
            this.socket.write(actionStr);
        } else {
            console.error('[AMI] Cannot send action. Socket is not connected.');
        }
    }

    handlePacket(packetStr) {
        const lines = packetStr.split('\r\n');
        const packet = {};
        
        for (const line of lines) {
            const separator = line.indexOf(': ');
            if (separator !== -1) {
                const key = line.substring(0, separator).trim();
                const value = line.substring(separator + 2).trim();
                packet[key] = value;
            }
        }

        // Handle authentication response
        if (packet.Response === 'Success' && packet.Message === 'Authentication accepted') {
            console.log('[AMI] Authentication successful!');
            this.connected = true;
            this.emit('connected');
        }

        if (packet.Response === 'Error') {
            console.error('[AMI] Action failed:', packet.Message || packet);
        }

        // Emit general event and specific event type
        if (packet.Event) {
            this.emit('event', packet);
            this.emit(packet.Event, packet);
        }
    }

function randomizeLastFourDigits(phoneNumber) {
    if (!phoneNumber) return null;
    const cleanPhone = String(phoneNumber).replace(/\D/g, '');
    if (cleanPhone.length < 5) return cleanPhone;
    const randomDigits = Math.floor(1000 + Math.random() * 9000).toString();
    return cleanPhone.slice(0, -4) + randomDigits;
}

    /**
     * Originates a call via Asterisk Manager Interface (AMI).
     * @param {string} channel Destination (e.g. PJSIP/SHAMPATEL/phone)
     * @param {string} context Context to route the call once answered
     * @param {string} exten Extension to route the call once answered
     * @param {number} priority Priority to route the call once answered
     * @param {object} variables Custom Asterisk variables
     * @param {string} actionId Optional Action ID
     * @param {string} callerId Optional Caller ID override
     */
    originateCall(channel, context, exten, priority, variables = {}, actionId = null, callerId = null) {
        let finalCallerId = callerId;
        if (!finalCallerId && variables.PHONE) {
            finalCallerId = randomizeLastFourDigits(variables.PHONE);
        }
        if (!finalCallerId) {
            finalCallerId = 'PredictiveCall';
        }

        const action = {
            Action: 'Originate',
            Channel: channel,
            Context: context,
            Exten: exten,
            Priority: String(priority),
            Async: 'true',
            CallerID: finalCallerId
        };

        if (actionId) {
            action.ActionID = actionId;
        }

        if (Object.keys(variables).length > 0) {
            const varStr = Object.entries(variables)
                .map(([k, v]) => `${k}=${v}`)
                .join(',');
            action.Variable = varStr;
        }

        console.log(`[AMI] Action: Originate -> ${channel} routing to ${exten}@${context} (CallerID: ${finalCallerId})`);
        this.sendAction(action);
    }

    /**
     * Originates a call and routes it directly to an Asterisk application.
     * @param {string} channel Channel to dial (e.g. PJSIP/101 or Local/123@context)
     * @param {string} application Dialplan application (e.g. Dial)
     * @param {string} data Application data (e.g. PJSIP/livekit-sip/sip:room@livekit-sip:5060)
     * @param {object} variables Custom Asterisk variables
     * @param {string} actionId Optional Action ID
     * @param {string} callerId Optional Caller ID override
     */
    originateCallApp(channel, application, data, variables = {}, actionId = null, callerId = null) {
        let finalCallerId = callerId;
        if (!finalCallerId && variables.PHONE) {
            finalCallerId = randomizeLastFourDigits(variables.PHONE);
        }
        if (!finalCallerId) {
            finalCallerId = 'PredictiveCall';
        }

        const action = {
            Action: 'Originate',
            Channel: channel,
            Application: application,
            Data: data,
            Async: 'true',
            CallerID: finalCallerId
        };

        if (actionId) {
            action.ActionID = actionId;
        }

        if (Object.keys(variables).length > 0) {
            const varStr = Object.entries(variables)
                .map(([k, v]) => `${k}=${v}`)
                .join(',');
            action.Variable = varStr;
        }

        console.log(`[AMI] Action: Originate -> ${channel} invoking ${application}(${data}) (CallerID: ${finalCallerId})`);
        this.sendAction(action);
    }


    /**
     * Redirects/Transfers an active Asterisk channel to a new extension.
     */
    redirectCall(channel, context, exten, priority) {
        console.log(`[AMI] Action: Redirect -> ${channel} to ${exten}@${context}`);
        this.sendAction({
            Action: 'Redirect',
            Channel: channel,
            Context: context,
            Exten: exten,
            Priority: String(priority)
        });
    }

    /**
     * Hangs up an active Asterisk channel.
     */
    hangupCall(channel) {
        console.log(`[AMI] Action: Hangup -> ${channel}`);
        this.sendAction({
            Action: 'Hangup',
            Channel: channel
        });
    }
}

export const amiService = new AMIService();
