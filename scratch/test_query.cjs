const { listDevices } = require('../src/services/device-service.js');

async function test() {
  try {
    const result = listDevices({ page: 1, pageSize: 20 });
    console.log('SUCCESS:', result.devices.length, 'devices found');
  } catch (e) {
    console.error('ERROR:', e.message);
  }
}

test();
