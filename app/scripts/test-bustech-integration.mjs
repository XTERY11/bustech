import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Read and exercise the actual module C implementation without changing it.
const repository = resolve(process.argv[2] ?? '..');
const { SignalHub } = await import(pathToFileURL(resolve(repository, 'dashboard/backend/hub.mjs')));
const { createBridge } = await import(pathToFileURL(resolve(repository, 'dashboard/backend/server.mjs')));
const hub = new SignalHub();
hub.setMode('rules');
const token = randomUUID();
const server = createBridge({ hub, token });
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
hub.receive('perception', {
  event_id: 'integration-wheelchair', observed_at: new Date().toISOString(),
  payload: { yolo_detections: [{ label: 'WHEELCHAIR', confidence: 0.96 }], target_match_confirmed: true }
});
let bookings = 0, cancellations = 0, ready = 0;
hub.on('event', event => {
  if (event.type === 'signal' && event.data.channel === 'booking') {
    const active = event.data.snapshot.context.request.active;
    if (active) bookings++; else cancellations++;
    console.log(`Hub booking: active=${active}`);
  }
  if (event.type === 'result') {
    console.log(`Hub result: ${event.data.result.plan_status}`);
    if (event.data.result.plan_status === 'READY') ready++;
  }
});
const address = `http://127.0.0.1:${server.address().port}`;
const args = [
  '-project', 'BusPulse SG.xcodeproj', '-scheme', 'BusPulse SG',
  '-destination', process.env.BUSTECH_TEST_DESTINATION ?? 'platform=iOS Simulator,name=iPhone 17 Pro Max,OS=27.0',
  '-derivedDataPath', '.build/BusTechDerivedData', '-parallel-testing-enabled', 'NO',
  '-only-testing:BusPulse SGTests',
  '-only-testing:BusPulse SGUITests/BusPulseSGUITests/testBusTechBookingAndCancellationWithRealHub',
  '-only-testing:BusPulse SGUITests/BusPulseSGUITests/testManualAssistanceUsesTheSameDeliveryStatusFlow',
  '-only-testing:BusPulse SGUITests/BusPulseSGUITests/testAccessibilityDynamicTypeKeepsPrimaryTransitActionsUsable',
  '-only-testing:BusPulse SGUITests/BusPulseSGUITests/testAssistantTabStartsVoiceFirstAndResolvesTheJourney',
  '-only-testing:BusPulse SGUITests/BusPulseSGUITests/testVoiceAssistanceProducesStructuredRequestAndVehicleACK',
  'test'
];
const child = spawn('xcodebuild', args, {
  stdio: 'inherit', env: {
    ...process.env, DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? '/Applications/Xcode-beta.app/Contents/Developer',
    TEST_RUNNER_BUSTECH_HUB_URL: address, TEST_RUNNER_BUSTECH_HUB_TOKEN: token
  }
});
const stop = () => child.kill('SIGTERM');
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const code = await new Promise(resolve => child.once('exit', resolve));
server.closeAllConnections();
await new Promise(resolve => server.close(resolve));
console.log(`Actual hub acceptance: bookings=${bookings}, cancellations=${cancellations}, READY=${ready}`);
process.exitCode = code === 0 && bookings >= 2 && cancellations >= 2 && ready >= 2 ? 0 : 1;
