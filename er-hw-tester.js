const socketcan = require('socketcan');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

// --- ER CAN Protocol (from er-common.js) ---

const ER_OPCODES = {
    ER_OPCODE_INVALID: 0x00,
    ER_OPCODE_EMERGENCY_STOP: 0x01,
    ER_OPCODE_DIGITAL_OUTPUT_SET_STATE: 0x02,
    ER_OPCODE_DIGITAL_OUTPUT_GET_STATE: 0x03,
    ER_OPCODE_DIGITAL_OUTPUT_STATE_CHANGED: 0x04,
    ER_OPCODE_DIGITAL_INPUT_GET_STATE: 0x05,
    ER_OPCODE_DIGITAL_INPUT_STATE_CHANGED: 0x06,
    ER_OPCODE_PWM_OUTPUT_SET_VALUE: 0x07,
    ER_OPCODE_PWM_OUTPUT_VALUE_CHANGED: 0x08,
    ER_OPCODE_SERVO_SET_TARGET_VALUE: 0x09,
    ER_OPCODE_USB_HID_MOUSE_STATE_CHANGED: 0x21,
    ER_OPCODE_USB_KEYBOARD_STATE_CHANGED: 0x22,
};

const OPCODE_NAMES = {};
for (const [k, v] of Object.entries(ER_OPCODES)) {
    OPCODE_NAMES[v] = k.replace('ER_OPCODE_', '');
}

const ER_SUBSYSTEMS = {
    ER_SUBSYSTEM_DIGITAL_OUTPUTS: 0x01,
    ER_SUBSYSTEM_DIGITAL_INPUTS: 0x02,
    ER_SUBSYSTEM_PWM_OUTPUTS: 0x03,
    ER_SUBSYSTEM_SERVO_OUTPUTS: 0x04,
    ER_SUBSYSTEM_USB_HID_MOUSE: 0x11,
    ER_SUBSYSTEM_USB_HID_KEYBOARD: 0x12,
};

const SUBSYSTEM_NAMES = {};
for (const [k, v] of Object.entries(ER_SUBSYSTEMS)) {
    SUBSYSTEM_NAMES[v] = k.replace('ER_SUBSYSTEM_', '');
}

const ER_FRAME_ID_PRIORITY = { HIGH: 0, LOW: 1 };
const ER_FRAME_ID_DEVICE_TYPE = { SERVICE_PC: 0, GAME_MASTER_PC: 1, GAME_MASTER_UC: 2, ENDPOINT: 3 };

const DEVICE_TYPE_NAMES = {};
for (const [k, v] of Object.entries(ER_FRAME_ID_DEVICE_TYPE)) {
    DEVICE_TYPE_NAMES[v] = k;
}

function buildERFrameId(priority, deviceType, deviceId) {
    return ((priority << 10) & 0x400) | ((deviceType << 8) & 0x300) | (deviceId & 0xFF);
}

function decodeERFrameId(rawID) {
    return {
        priority: (rawID & 0x400) >> 10,
        deviceType: (rawID & 0x300) >> 8,
        deviceId: rawID & 0xFF,
    };
}

function decodeFrameData(buffer) {
    const byte0 = buffer.readUInt8(0);
    return {
        isResponse: !!((byte0 & 0x80) >> 7),
        opcode: byte0 & 0x7F,
        subsystem: buffer.readUInt8(1),
        address: buffer.readUInt16LE(2),
        payload: Array.from(buffer.slice(4)),
    };
}

function buildPwmFrame(deviceId, channel, value) {
    const buffer = Buffer.alloc(6);
    buffer.writeUInt8(ER_OPCODES.ER_OPCODE_PWM_OUTPUT_SET_VALUE, 0);
    buffer.writeUInt8(ER_SUBSYSTEMS.ER_SUBSYSTEM_PWM_OUTPUTS, 1);
    buffer.writeUInt16LE(channel, 2);
    buffer.writeUInt16LE(value, 4);
    return {
        id: buildERFrameId(ER_FRAME_ID_PRIORITY.LOW, ER_FRAME_ID_DEVICE_TYPE.GAME_MASTER_PC, deviceId),
        data: buffer,
        ext: false,
        rtr: false,
    };
}

function buildServoFrame(deviceId, channel, targetValue, rampTime, rampType) {
    const buffer = Buffer.alloc(8);
    buffer.writeUInt8(ER_OPCODES.ER_OPCODE_SERVO_SET_TARGET_VALUE, 0);
    buffer.writeUInt8(ER_SUBSYSTEMS.ER_SUBSYSTEM_SERVO_OUTPUTS, 1);
    buffer.writeUInt16LE(channel, 2);
    buffer.writeUInt8(targetValue & 0xFF, 4);
    buffer.writeUInt8((targetValue >> 8) & 0xFF, 5);
    buffer.writeUInt8(rampTime, 6);
    buffer.writeUInt8(rampType, 7);
    return {
        id: buildERFrameId(ER_FRAME_ID_PRIORITY.LOW, ER_FRAME_ID_DEVICE_TYPE.GAME_MASTER_PC, deviceId),
        data: buffer,
        ext: false,
        rtr: false,
    };
}

// --- Node-RED Module ---

module.exports = function (RED) {
    let wss = null;
    let channel = null;
    let activeNodes = 0;

    // Serve static dashboard (no express dependency)
    const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
    const publicDir = path.join(__dirname, 'public');
    RED.httpNode.get('/er-hw-tester/*', function (req, res) {
        let filePath = path.join(publicDir, req.params[0] || 'index.html');
        if (filePath.indexOf(publicDir) !== 0) return res.sendStatus(403);
        fs.readFile(filePath, function (err, data) {
            if (err) return res.sendStatus(404);
            const ext = path.extname(filePath);
            res.set('Content-Type', MIME[ext] || 'application/octet-stream');
            res.send(data);
        });
    });
    RED.httpNode.get('/er-hw-tester', function (req, res) { res.redirect('/er-hw-tester/index.html'); });

    function broadcastWS(data) {
        if (!wss) return;
        const json = JSON.stringify(data);
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(json);
            }
        });
    }

    function decodedCanFrame(direction, rawId, dataBuffer) {
        const frameId = decodeERFrameId(rawId);
        const frameData = decodeFrameData(dataBuffer);
        return {
            type: 'can_frame',
            direction,
            timestamp: Date.now(),
            raw_id: rawId,
            device_id: frameId.deviceId,
            device_type: frameId.deviceType,
            device_type_name: DEVICE_TYPE_NAMES[frameId.deviceType] || 'UNKNOWN',
            priority: frameId.priority,
            is_response: frameData.isResponse,
            opcode: frameData.opcode,
            opcode_name: OPCODE_NAMES[frameData.opcode] || 'UNKNOWN',
            subsystem: frameData.subsystem,
            subsystem_name: SUBSYSTEM_NAMES[frameData.subsystem] || 'UNKNOWN',
            address: frameData.address,
            payload: frameData.payload,
            raw_data: Array.from(dataBuffer).map(b => b.toString(16).padStart(2, '0')).join(' '),
        };
    }

    function sendCanFrame(frame, node) {
        if (!channel) {
            node.error('CAN channel not open');
            return;
        }
        channel.send(frame, function (err) {
            if (err) {
                node.error('Failed to send CAN frame: ' + err.toString());
            }
        });
        broadcastWS(decodedCanFrame('out', frame.id, frame.data));
    }

    function ErHwTesterNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const canInterface = config.interface || 'can0';

        activeNodes++;

        // Open CAN channel (shared — first node opens, last closes)
        if (!channel) {
            try {
                channel = socketcan.createRawChannel(canInterface, true);
                channel.addListener('onMessage', (msg) => {
                    broadcastWS(decodedCanFrame('in', msg.id, msg.data));
                });
                channel.start();
                node.log('CAN channel opened on ' + canInterface);
            } catch (err) {
                node.error('Failed to open CAN channel on ' + canInterface + ': ' + err.toString());
                channel = null;
            }
        }

        // Start WebSocket server (shared — first node creates)
        if (!wss) {
            wss = new WebSocket.Server({
                server: RED.server,
                path: '/er-hw-tester/ws',
            });

            wss.on('connection', (ws) => {
                node.log('WebSocket client connected');

                ws.on('message', (raw) => {
                    let msg;
                    try {
                        msg = JSON.parse(raw);
                    } catch (e) {
                        return;
                    }

                    if (msg.type === 'set_pwm') {
                        const deviceId = parseInt(msg.device_id);
                        const ch = parseInt(msg.channel);
                        const value = Math.max(0, Math.min(1000, parseInt(msg.value)));
                        if (deviceId >= 1 && deviceId <= 255 && ch >= 0 && ch <= 7) {
                            sendCanFrame(buildPwmFrame(deviceId, ch, value), node);
                        }
                    } else if (msg.type === 'set_servo') {
                        const deviceId = parseInt(msg.device_id);
                        const ch = parseInt(msg.channel);
                        const tv = Math.max(0, Math.min(1000, parseInt(msg.target_value)));
                        const rt = Math.max(0, Math.min(255, parseInt(msg.ramp_time)));
                        const rtype = Math.max(0, Math.min(5, parseInt(msg.ramp_type)));
                        if (deviceId >= 1 && deviceId <= 255 && ch >= 0 && ch <= 15) {
                            sendCanFrame(buildServoFrame(deviceId, ch, tv, rt, rtype), node);
                        }
                    }
                });

                ws.on('close', () => {
                    node.log('WebSocket client disconnected');
                });
            });

            node.log('WebSocket server started on /er-hw-tester/ws');
        }

        node.status({ fill: 'green', shape: 'dot', text: canInterface });

        node.on('close', (done) => {
            activeNodes--;
            if (activeNodes <= 0) {
                if (channel) {
                    channel.stop();
                    channel = null;
                    node.log('CAN channel closed');
                }
                if (wss) {
                    wss.close();
                    wss = null;
                    node.log('WebSocket server closed');
                }
                activeNodes = 0;
            }
            done();
        });
    }

    RED.nodes.registerType('er-hw-tester', ErHwTesterNode);
};
