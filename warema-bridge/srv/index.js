const warema = require('./warema-wms-venetian-blinds');
const log = require('./logger');
const mqtt = require('mqtt');

process.on('SIGINT', function () {
    // Clean up intervals
    if (availabilityCheckInterval) {
        clearInterval(availabilityCheckInterval);
    }
    if (wakeUpIntervalTimer) {
        clearInterval(wakeUpIntervalTimer);
    }
    if (rescanIntervalTimer) {
        clearInterval(rescanIntervalTimer);
    }
    process.exit(0);
});

const mqttServer = process.env.MQTT_SERVER || 'mqtt://localhost'
const ignoredDevices = process.env.IGNORED_DEVICES ? process.env.IGNORED_DEVICES.split(',') : [];
const forceDevices = process.env.FORCE_DEVICES ? process.env.FORCE_DEVICES.split(',') : [];
const pollingInterval = process.env.POLLING_INTERVAL || 30000;
const movingInterval = process.env.MOVING_INTERVAL || 1000;
const availabilityTimeout = process.env.AVAILABILITY_TIMEOUT || 300000; // 5 minutes default
const wakeUpInterval = process.env.WAKE_UP_INTERVAL || 60000; // 1 minute default
const rescanInterval = process.env.RESCAN_INTERVAL || 3600000; // 1 hour default - periodic re-scanning

const settingsPar = {
    wmsChannel: process.env.WMS_CHANNEL || 17,
    wmsKey: process.env.WMS_KEY || '00112233445566778899AABBCCDDEEFF',
    wmsPanid: process.env.WMS_PAN_ID || 'FFFF',
    wmsSerialPort: process.env.WMS_SERIAL_PORT || '/dev/ttyUSB0',
};

const devices = [];
const deviceAvailability = {}; // Track device availability status
const deviceLastSeen = {}; // Track when devices were last seen

// Function to update device availability
function updateDeviceAvailability(snr, isOnline) {
    const availability_topic = 'warema/' + snr + '/availability';
    const wasOnline = deviceAvailability[snr];
    
    if (isOnline !== wasOnline) {
        deviceAvailability[snr] = isOnline;
        if (isOnline) {
            deviceLastSeen[snr] = Date.now();
            log.info('Device ' + snr + ' is now online');
        } else {
            log.warn('Device ' + snr + ' is now offline');
        }
        client.publish(availability_topic, isOnline ? 'online' : 'offline', {retain: true});
    } else if (isOnline) {
        deviceLastSeen[snr] = Date.now();
    }
}

// Function to check device availability based on last seen time
function checkDeviceAvailability() {
    const now = Date.now();
    let hasLongOfflineDevices = false;
    
    for (const snr in deviceLastSeen) {
        const timeSinceLastSeen = now - deviceLastSeen[snr];
        if (timeSinceLastSeen > availabilityTimeout) {
            updateDeviceAvailability(snr, false);
            // Check if device has been offline for more than 2x the availability timeout
            if (timeSinceLastSeen > availabilityTimeout * 2) {
                hasLongOfflineDevices = true;
            }
        }
    }
    
    // Force re-scan if devices have been offline for too long
    if (hasLongOfflineDevices) {
        log.warn('Some devices have been offline for extended period, forcing re-scan...');
        performPeriodicRescan();
    }
}

// Function to wake up sleeping devices
function wakeUpDevices() {
    let offlineCount = 0;
    
    for (const snr in devices) {
        if (deviceAvailability[snr] === false) {
            offlineCount++;
            log.debug('Attempting to wake up device ' + snr);
            
            // Try multiple wake-up approaches
            try {
                // 1. Send a wave request to wake up the device
                stickUsb.vnBlindWaveRequest(snr);
                
                // 2. Try to get position (this can also wake up devices)
                setTimeout(() => {
                    if (deviceAvailability[snr] === false) {
                        log.debug('Trying position request for device ' + snr);
                        stickUsb.vnBlindGetPosition(snr, {
                            cmdConfirmation: false,
                            callbackOnUnchangedPos: false
                        });
                    }
                }, 1000);
                
            } catch (error) {
                log.error('Error waking up device ' + snr + ': ' + error.message);
            }
        }
    }
    
    // If too many devices are offline, consider a re-scan
    if (offlineCount > 0 && offlineCount >= Object.keys(devices).length / 2) {
        log.warn('More than half of devices are offline, considering re-scan...');
        // This will trigger a re-scan on the next availability check
    }
}

// Function to perform periodic re-scanning
function performPeriodicRescan() {
    log.info('Performing periodic device re-scan...');
    
    // Check if any devices are offline
    const offlineDevices = Object.keys(deviceAvailability).filter(snr => deviceAvailability[snr] === false);
    
    if (offlineDevices.length > 0) {
        log.info('Found ' + offlineDevices.length + ' offline devices, performing re-scan...');
        
        // Clear current device registrations
        const currentDevices = Object.keys(devices);
        currentDevices.forEach(snr => {
            log.debug('Clearing registration for device ' + snr);
            stickUsb.vnBlindRemove(snr);
        });
        
        // Clear availability tracking
        Object.keys(deviceAvailability).forEach(snr => {
            delete deviceAvailability[snr];
            delete deviceLastSeen[snr];
        });
        
        // Clear devices array
        Object.keys(devices).forEach(snr => {
            delete devices[snr];
        });
        
        // Perform new scan
        stickUsb.scanDevices({autoAssignBlinds: false});
    } else {
        log.debug('All devices are online, skipping re-scan');
    }
}

// Set up availability checking intervals
let availabilityCheckInterval;
let wakeUpIntervalTimer;
let rescanIntervalTimer;

function registerDevice(element) {
    log.info('Registering ' + element.snr)
    var topic = 'homeassistant/cover/' + element.snr + '/' + element.snr + '/config'
    var availability_topic = 'warema/' + element.snr + '/availability'

    var base_payload = {
        availability: [
            {topic: 'warema/bridge/state'},
            {topic: availability_topic}
        ],
        unique_id: element.snr,
        name: null
    }

    var base_device = {
        identifiers: element.snr,
        manufacturer: "Warema",
        name: element.snr
    }

    var model
    var payload
    switch (parseInt(element.type)) {
        case 6:
            model = 'Weather station eco'
            payload = {
                ...base_payload,
                device: {
                    ...base_device,
                    model: model
                }
            }

            const illuminance_payload = {
                ...payload,
                state_topic: 'warema/' + element.snr + '/illuminance/state',
                device_class: 'illuminance',
                unique_id: element.snr + '_illuminance',
                object_id: element.snr + '_illuminance',
                unit_of_measurement: 'lx',
            };
            client.publish('homeassistant/sensor/' + element.snr + '/illuminance/config', JSON.stringify(illuminance_payload), {retain: true})

            //No temp on weather station eco
            const temperature_payload = {
                ...payload,
                state_topic: 'warema/' + element.snr + '/temperature/state',
                device_class: 'temperature',
                unique_id: element.snr + '_temperature',
                object_id: element.snr + '_temperature',
                unit_of_measurement: '°C',
            }
            client.publish('homeassistant/sensor/' + element.snr + '/temperature/config', JSON.stringify(temperature_payload), {retain: true})

            const wind_payload = {
                ...payload,
                state_topic: 'warema/' + element.snr + '/wind/state',
                device_class: 'wind_speed',
                unique_id: element.snr + '_wind',
                object_id: element.snr + '_wind',
                unit_of_measurement: 'm/s',
            }
            client.publish('homeassistant/sensor/' + element.snr + '/wind/config', JSON.stringify(wind_payload), {retain: true})

            //No rain on weather station eco
            const rain_payload = {
                ...payload,
                state_topic: 'warema/' + element.snr + '/rain/state',
                device_class: 'moisture',
                unique_id: element.snr + '_rain',
                object_id: element.snr + '_rain',
            }
            client.publish('homeassistant/binary_sensor/' + element.snr + '/rain/config', JSON.stringify(rain_payload), {retain: true})

            client.publish(availability_topic, 'online', {retain: true})

            devices[element.snr] = {
                position: undefined,
                tilt: undefined
            };

            // Initialize availability tracking
            deviceAvailability[element.snr] = true;
            deviceLastSeen[element.snr] = Date.now();

            return;
        case 7:
            // WMS Remote pro
            return;
        case 9:
            // WMS WebControl Pro - while part of the network, we have no business to do with it.
            return;
        case 20:
            model = 'Plug receiver'
            payload = {
                ...base_payload,
                device: {
                    ...base_device,
                    model: model
                },
                position_open: 0,
                position_closed: 100,
                command_topic: 'warema/' + element.snr + '/set',
                state_topic: 'warema/' + element.snr + '/state',
                position_topic: 'warema/' + element.snr + '/position',
                tilt_status_topic: 'warema/' + element.snr + '/tilt',
                set_position_topic: 'warema/' + element.snr + '/set_position',
                tilt_command_topic: 'warema/' + element.snr + '/set_tilt',
                tilt_closed_value: -75,
                tilt_opened_value: 75,
                tilt_min: -75,
                tilt_max: 75,
            }
            break;
        case 21:
            model = 'Actuator UP'
            payload = {
                ...base_payload,
                device: {
                    ...base_device,
                    model: model
                },
                position_open: 0,
                position_closed: 100,
                command_topic: 'warema/' + element.snr + '/set',
                position_topic: 'warema/' + element.snr + '/position',
                tilt_status_topic: 'warema/' + element.snr + '/tilt',
                set_position_topic: 'warema/' + element.snr + '/set_position',
                tilt_command_topic: 'warema/' + element.snr + '/set_tilt',
                tilt_closed_value: -75,
                tilt_opened_value: 75,
                tilt_min: -75,
                tilt_max: 75,
            }

            break;
        case 24:
            // TODO: Smart socket
            model = 'Smart socket';
            payload = {
                ...base_payload,
                device: {
                    ...base_device,
                    model: model
                },
                state_topic: 'warema/' + element.snr + '/state',
                command_topic: 'warema/' + element.snr + '/set',
            }

            break;
        case 25:
            model = 'Radio motor';
            payload = {
                ...base_payload,
                device: {
                    ...base_device,
                    model: model
                },
                position_open: 0,
                position_closed: 100,
                state_topic: 'warema/' + element.snr + '/state',
                command_topic: 'warema/' + element.snr + '/set',
                position_topic: 'warema/' + element.snr + '/position',
                tilt_status_topic: 'warema/' + element.snr + '/tilt',
                set_position_topic: 'warema/' + element.snr + '/set_position',
                tilt_command_topic: 'warema/' + element.snr + '/set_tilt',
                tilt_closed_value: -75,
                tilt_opened_value: 75,
                tilt_min: -75,
                tilt_max: 75,
            }

            break;
        default:
            log.info('Unrecognized device type: ' + element.type)
            model = 'Unknown model ' + element.type
            return
    }

    if (ignoredDevices.includes(element.snr.toString())) {
        log.info('Ignoring and removing device ' + element.snr + ' (type ' + element.type + ')')
    } else {
        log.info('Adding device ' + element.snr + ' (type ' + element.type + ')')

        stickUsb.vnBlindAdd(parseInt(element.snr), element.snr.toString());

        devices[element.snr] = {
            position: undefined,
            tilt: undefined
        };

        // Initialize availability tracking
        deviceAvailability[element.snr] = true;
        deviceLastSeen[element.snr] = Date.now();

        client.publish(availability_topic, 'online', {retain: true})
        client.publish(topic, JSON.stringify(payload), {retain: true})
    }
}

function callback(err, msg) {
    if (err) {
        log.error(err);
    }
    if (msg) {
        // Debug: Log message structure for MQTT v5 compatibility
        log.debug('Received message: topic=' + msg.topic + ', payload=' + JSON.stringify(msg.payload));
        
        switch (msg.topic) {
            case 'wms-vb-init-completion':
                log.info('Warema init completed')

                stickUsb.setPosUpdInterval(pollingInterval);
                stickUsb.setWatchMovingBlindsInterval(movingInterval);

                // Enable command confirmation notifications for availability tracking
                stickUsb.setCmdConfirmationNotificationEnabled(true);

                // Set up availability checking intervals
                availabilityCheckInterval = setInterval(checkDeviceAvailability, availabilityTimeout / 2);
                wakeUpIntervalTimer = setInterval(wakeUpDevices, wakeUpInterval);
                rescanIntervalTimer = setInterval(performPeriodicRescan, rescanInterval);

                log.info('Scanning...')

                stickUsb.scanDevices({autoAssignBlinds: false});
                break;
            case 'wms-vb-scanned-devices':
                log.info('Scanned devices:\n' + JSON.stringify(msg.payload, null, 2));
                if (forceDevices && forceDevices.length) {
                    forceDevices.forEach(deviceString => {
                        const [snr, type] = deviceString.split(':');

                        registerDevice({snr: snr, type: type || 25})
                    })
                } else {
                    msg.payload.devices.forEach(element => registerDevice(element))
                }
                log.info('Registered devices:\n' + JSON.stringify(stickUsb.vnBlindsList(), null, 2))
                break;
            case 'wms-vb-rcv-weather-broadcast':
                log.silly('Weather broadcast:\n' + JSON.stringify(msg.payload, null, 2))

                if (!devices[msg.payload.weather.snr]) {
                    registerDevice({snr: msg.payload.weather.snr, type: 6});
                }

                client.publish('warema/' + msg.payload.weather.snr + '/illuminance/state', msg.payload.weather.lumen.toString(), {retain: true})
                client.publish('warema/' + msg.payload.weather.snr + '/temperature/state', msg.payload.weather.temp.toString(), {retain: true})
                client.publish('warema/' + msg.payload.weather.snr + '/wind/state', msg.payload.weather.wind.toString(), {retain: true})
                client.publish('warema/' + msg.payload.weather.snr + '/rain/state', msg.payload.weather.rain ? 'ON' : 'OFF', {retain: true})

                break;
            case 'wms-vb-blind-position-update':
                log.debug('Position update: \n' + JSON.stringify(msg.payload, null, 2))

                // Validate message payload
                if (!msg.payload || !msg.payload.snr) {
                    log.error('Invalid position update message: missing payload or snr');
                    return;
                }

                // Auto-register device if it doesn't exist (this can happen with devices that weren't found during initial scan)
                if (!devices[msg.payload.snr]) {
                    log.info('Auto-registering unknown device ' + msg.payload.snr + ' from position update');
                    registerDevice({snr: msg.payload.snr, type: 25}); // Default to type 25 (Radio motor)
                }

                // Double-check device exists after registration
                if (!devices[msg.payload.snr]) {
                    log.error('Failed to register device ' + msg.payload.snr + ' for position update');
                    return;
                }

                // Update device availability when we receive a response
                updateDeviceAvailability(msg.payload.snr, true);

                if (typeof msg.payload.position !== "undefined") {
                    const previousPosition = devices[msg.payload.snr]?.position;
                    devices[msg.payload.snr].position = msg.payload.position;
                    client.publish('warema/' + msg.payload.snr + '/position', '' + msg.payload.position, {retain: true})

                    // Update state based on position and moving status
                    if (msg.payload.moving === true) {
                        // Device is currently moving - determine direction
                        if (typeof previousPosition !== "undefined") {
                            if (msg.payload.position > previousPosition) {
                                client.publish('warema/' + msg.payload.snr + '/state', 'closing', {retain: true});
                            } else if (msg.payload.position < previousPosition) {
                                client.publish('warema/' + msg.payload.snr + '/state', 'opening', {retain: true});
                            } else {
                                // Position unchanged but still moving - use position-based logic
                                if (msg.payload.position === 0)
                                    client.publish('warema/' + msg.payload.snr + '/state', 'opening', {retain: true});
                                else if (msg.payload.position === 100)
                                    client.publish('warema/' + msg.payload.snr + '/state', 'closing', {retain: true});
                                else
                                    client.publish('warema/' + msg.payload.snr + '/state', 'closing', {retain: true}); // Default to closing for intermediate positions
                            }
                        } else {
                            // No previous position available - use position-based logic
                            if (msg.payload.position === 0)
                                client.publish('warema/' + msg.payload.snr + '/state', 'opening', {retain: true});
                            else if (msg.payload.position === 100)
                                client.publish('warema/' + msg.payload.snr + '/state', 'closing', {retain: true});
                            else
                                client.publish('warema/' + msg.payload.snr + '/state', 'closing', {retain: true}); // Default to closing for intermediate positions
                        }
                    } else {
                        // Device has stopped moving
                        if (msg.payload.position === 0)
                            client.publish('warema/' + msg.payload.snr + '/state', 'open', {retain: true});
                        else if (msg.payload.position === 100)
                            client.publish('warema/' + msg.payload.snr + '/state', 'closed', {retain: true});
                        else
                            client.publish('warema/' + msg.payload.snr + '/state', 'stopped', {retain: true});
                    }
                }
                if (typeof msg.payload.angle !== "undefined") {
                    devices[msg.payload.snr].tilt = msg.payload.angle;
                    client.publish('warema/' + msg.payload.snr + '/tilt', '' + msg.payload.angle, {retain: true})
                }
                break;
            case 'wms-vb-cmd-result-set-position':
            case 'wms-vb-cmd-result-get-position':
            case 'wms-vb-cmd-result-stop':
                // Handle command results to track device availability
                if (msg.payload.error) {
                    log.warn('Command failed for device ' + msg.payload.snr + ': ' + msg.payload.error);
                    // Mark device as offline if command failed
                    updateDeviceAvailability(msg.payload.snr, false);
                } else {
                    // Command succeeded, device is responsive
                    updateDeviceAvailability(msg.payload.snr, true);
                }
                break;
            default:
                log.info('UNKNOWN MESSAGE: ' + JSON.stringify(msg, null, 2));
        }

        client.publish('warema/bridge/state', 'online', {retain: true})
    }
}

const stickUsb = new warema(settingsPar.wmsSerialPort,
    settingsPar.wmsChannel,
    settingsPar.wmsPanid,
    settingsPar.wmsKey,
    {},
    callback
);

//Do not attempt connecting to MQTT if trying to discover network parameters
if (settingsPar.wmsPanid === 'FFFF') return;

const client = mqtt.connect(mqttServer,
    {
        username: process.env.MQTT_USER,
        password: process.env.MQTT_PASSWORD,
        will: {
            topic: 'warema/bridge/state',
            payload: 'offline',
            retain: true
        }
    }
)

client.on('connect', function () {
    log.info('Connected to MQTT')

    client.subscribe([
        'warema/+/set',
        'warema/+/set_position',
        'warema/+/set_tilt',
        'homeassistant/status'
    ]);
})

client.on('error', function (error) {
    log.error('MQTT Error: ' + error.toString())
})

client.on('message', function (topic, message) {
    let [scope, device, command] = topic.split('/');
    message = message.toString();

    log.debug('Received message on topic')
    log.debug('scope: ' + scope + ', device: ' + device + ', command: ' + command)
    log.debug('message: ' + message)

    if (scope === 'homeassistant' && command === 'status') {
        if (message === 'online') {
            log.info('Home Assistant is online');
        }
        return;
    }

    //scope === 'warema'
    switch (command) {
        case 'set':
            switch (message) {
                case 'ON':
                case 'OFF':
                    //TODO: use stick to turn on/off
                    break;
                case 'CLOSE':
                    log.debug('Closing ' + device);
                    stickUsb.vnBlindSetPosition(device, 100)
                    client.publish('warema/' + device + '/state', 'closing');
                    // Mark device as online when we send a command
                    updateDeviceAvailability(device, true);
                    break;
                case 'OPEN':
                    log.debug('Opening ' + device);
                    stickUsb.vnBlindSetPosition(device, 0);
                    client.publish('warema/' + device + '/state', 'opening');
                    // Mark device as online when we send a command
                    updateDeviceAvailability(device, true);
                    break;
                case 'STOP':
                    log.debug('Stopping ' + device);
                    stickUsb.vnBlindStop(device);
                    // Mark device as online when we send a command
                    updateDeviceAvailability(device, true);
                    break;
            }
            break;
        case 'set_position':
            log.debug('Setting ' + device + ' to ' + message + '%, angle ' + (devices[device]?.tilt || 0));
            const currentAngle = devices[device]?.tilt || 0;
            stickUsb.vnBlindSetPosition(device, parseInt(message), parseInt(currentAngle));
            // Mark device as online when we send a command
            updateDeviceAvailability(device, true);
            // Update state immediately to show movement
            const currentPosition = devices[device]?.position || 0;
            if (parseInt(message) > currentPosition) {
                client.publish('warema/' + device + '/state', 'closing', {retain: true});
            } else if (parseInt(message) < currentPosition) {
                client.publish('warema/' + device + '/state', 'opening', {retain: true});
            }
            break;
        case 'set_tilt':
            log.debug('Setting ' + device + ' to ' + message + '°, position ' + (devices[device]?.position || 0));
            const currentPositionForTilt = devices[device]?.position || 0;
            stickUsb.vnBlindSetPosition(device, parseInt(currentPositionForTilt), parseInt(message));
            // Mark device as online when we send a command
            updateDeviceAvailability(device, true);
            break;
        default:
            log.info('Unrecognised command from HA')
    }
});
