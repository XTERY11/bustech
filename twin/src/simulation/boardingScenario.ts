import type { ScenarioStep } from './mockBus';

/**
 * Accessible boarding sequence, expressed as a timed telemetry stream.
 * Each frame is exactly what a real vehicle gateway might publish.
 */
export const BOARDING_SCENARIO: ScenarioStep[] = [
  {
    at: 0,
    label: 'Assistance request received',
    frame: {
      boardingStatus: 'request_received',
      passengerInfo: { title: 'Boarding assistance', message: 'Wheelchair boarding requested at this stop.' },
      announcement: { active: true, text: 'Boarding assistance requested.' },
    },
  },
  {
    at: 1,
    label: 'Bus kneels',
    frame: { boardingStatus: 'preparing', kneeling: true, announcement: { active: false, text: '' } },
  },
  { at: 2, label: 'Door opens', frame: { door: 'opening' } },
  { at: 3, label: 'Ramp extends', frame: { door: 'open', ramp: 'extending' } },
  {
    at: 5,
    label: '"Ramp deployed. Please board."',
    frame: {
      ramp: 'extended',
      boardingStatus: 'ready',
      passengerInfo: { title: 'Ready to board', message: 'Ramp deployed. Please board.' },
      announcement: { active: true, text: 'Ramp deployed. Please board.' },
    },
  },
  {
    at: 7,
    label: 'Passenger boarding',
    frame: {
      boardingStatus: 'boarding',
      passengerInfo: { title: 'Boarding in progress', message: 'Please keep the doorway clear.' },
      announcement: { active: false, text: 'Ramp deployed. Please board.' },
    },
  },
  {
    at: 10,
    label: 'Boarding complete',
    frame: {
      boardingStatus: 'complete',
      passengerInfo: { title: 'Boarding complete', message: 'Thank you. The ramp will now retract.' },
      announcement: { active: true, text: 'Boarding complete. Ramp retracting.' },
    },
  },
  { at: 11, label: 'Ramp retracts', frame: { ramp: 'retracting' } },
  {
    at: 13,
    label: 'Door closes',
    frame: { ramp: 'retracted', door: 'closing', announcement: { active: false, text: '' } },
  },
  { at: 14.2, label: 'Suspension raised', frame: { door: 'closed', kneeling: false } },
  { at: 16, label: 'Ready to depart', frame: { boardingStatus: 'idle', passengerInfo: null } },
];
