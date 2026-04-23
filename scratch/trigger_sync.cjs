const { runDeviceSyncNow } = require('../src/services/device-sync-service.js');
const { runSolaxRealtimeSyncNow } = require('../src/services/solax-realtime-sync-service.js');

async function run() {
  console.log('Running Device Sync...');
  await runDeviceSyncNow('manual-fix');
  console.log('Running Realtime Sync (First few)...');
  // Just trigger it, it will run in background or process a few
  await runSolaxRealtimeSyncNow('manual-fix');
  console.log('Done!');
}

run().catch(console.error);
