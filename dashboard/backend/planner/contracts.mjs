export const ACTIONS = [
  'ABORT_ASSISTANCE_SEQUENCE', 'HOLD_AT_STOP', 'REQUEST_ONBOARD_SAFETY_OPERATOR',
  'CHECK_SINGLE_ENTRANCE_CLEARANCE', 'KEEP_SINGLE_ENTRANCE_CLEAR',
  'PREPARE_WHEELCHAIR_AREA', 'EXTEND_DWELL_TIME', 'KEEP_RAMPS_STOWED',
  'OPEN_SINGLE_ENTRANCE', 'DEPLOY_AUTOMATIC_SHORT_RAMP', 'REQUEST_MANUAL_RAMP_DEPLOYMENT',
  'ACTIVATE_EXTERNAL_SPEAKER', 'CONFIRM_ROUTE_IDENTITY', 'PLAY_ENTRANCE_AUDIO_BEACON',
  'SHOW_EXTERNAL_DISPLAY', 'WAIT_FOR_BOARDING_CONFIRMATION', 'GUIDE_PASSENGER_TO_ASSIGNED_PLACE',
  'WAIT_FOR_SEATED_AND_BELTED_CONFIRMATION',
];
export const SEAT_IDS = Object.freeze([
  'S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09',
  'S10', 'S11', 'S12', 'S13', 'S14', 'S15', 'S16', 'F01',
]);
const text = (maxLength = 100) => ({ type: 'string', minLength: 1, maxLength });
const bool = { type: ['boolean', 'null'] };
const num = maximum => ({ type: ['number', 'null'], minimum: 0, maximum });
const en = values => ({ type: ['string', 'null'], enum: [...values, null] });
const obj = (properties, required = [], extra = true) => ({ type: 'object', properties, required, additionalProperties: extra });
const id = { ...text(80), pattern: '^[A-Za-z0-9_.:-]+$' };
const age = num(86400000);
const capability = en(['AVAILABLE', 'AVAILABLE_FOR_DEMO', 'UNAVAILABLE', 'UNKNOWN', 'CONCEPT_ONLY']);
const boardingTarget = {
  type: ['object', 'null'],
  properties: {
    type: { type: 'string', enum: ['SEAT', 'WHEELCHAIR_BAY'] },
    id: { type: 'string', enum: [...SEAT_IDS.filter(seat => seat !== 'F01'), 'WHEELCHAIR_BAY'] },
  },
  required: ['type', 'id'], additionalProperties: false,
};
const equipmentTarget = {
  type: ['object', 'null'],
  properties: { type: { type: 'string', enum: ['WHEELCHAIR_BAY'] }, id: { type: 'string', enum: ['WHEELCHAIR_BAY'] } },
  required: ['type', 'id'], additionalProperties: false,
};
const navigationSteps = {
  type: ['array', 'null'], minItems: 2, maxItems: 16,
  items: obj({
    step: { type: 'integer', minimum: 1, maximum: 16 },
    maneuver: { type: 'string', enum: ['START', 'STRAIGHT', 'TURN_LEFT', 'TURN_RIGHT', 'PARK_STROLLER', 'ARRIVE'] },
    distance_m: num(20),
    text: text(200),
  }, ['step', 'maneuver', 'distance_m', 'text'], false),
};
export const INPUT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'AccessRide v2 input (missing safety values fail closed)',
  ...obj({
    request_id: id,
    booking_event_id: id,
    presentation_mode: en(['WEB_DEMO']),
    request: obj({
      active: bool, observation_age_ms: age,
      intent: en(['BOARDING', 'ALIGHTING', 'UNKNOWN']), route_id: id, stop_id: id,
      accessibility_need: en(['WHEELCHAIR', 'CRUTCH', 'CANE', 'WALKER', 'STROLLER', 'VISUAL_ASSISTANCE', 'HEARING_ASSISTANCE', 'MOBILITY_ASSISTANCE', 'NONE', 'UNKNOWN']),
      assistance_requested: { type: 'array', maxItems: 8, uniqueItems: true, items: en(['WHEELCHAIR_RAMP', 'ADDITIONAL_BOARDING_TIME', 'AUDIO_BOARDING_GUIDANCE', 'VISUAL_BOARDING_GUIDANCE', 'CONFIRM_BUS_IDENTITY']) },
      ramp_preference: en(['REQUESTED', 'DECLINED', 'UNSPECIFIED']),
      preferred_interaction: en(['AUDIO', 'VISUAL', 'BOTH']), language: en(['zh-CN', 'en-SG']),
      // With active:false: the journey_id (booking event_id) this cancel or reset ends. Optional; see hub.cancelTarget.
      cancels: id,
    }),
    perception: obj({
      observation_age_ms: age, target_match_confirmed: bool,
      yolo_detections: { type: 'array', maxItems: 20, items: obj({
        label: en(['WHEELCHAIR', 'CRUTCH', 'CANE', 'WALKER', 'STROLLER', 'PERSON', 'NONE', 'UNKNOWN']),
        confidence: num(1), track_id: text(80),
      }, ['label', 'confidence']) },
      // Optional region-trigger metadata from the camera bridge (vision/yolo_bridge.py); informational only.
      // event: what happened at the stop region (heartbeats are 'present'); left: aid labels that were
      // there when it emptied. On exit, boarding is the bridge's estimate of intent: the passenger waited at
      // least a couple of seconds and left towards the bus (false: a short stay, or walked off another way);
      // dwell_seconds is how long the region was occupied. The dashboard uses a matching exit after a READY
      // plan as "passenger has boarded" unless boarding === false. Exit is never proof of boarding.
      zone: obj({ triggered: bool, roi_id: text(80), visit_id: id, event: en(['enter', 'present', 'exit']),
        left: { type: 'array', maxItems: 8, items: en(['WHEELCHAIR', 'CRUTCH', 'CANE', 'WALKER', 'STROLLER']) },
        boarding: bool, dwell_seconds: num(86400) }),
      geometry: obj({
        geometry_valid: bool, confidence: num(1), measured_gap_cm: num(1000), measured_slope_deg: num(90),
      }),
    }),
    vehicle_context: obj({
      observation_age_ms: age, route_id: id, stop_id: id,
      motion_state: en(['STOPPED', 'MOVING', 'UNKNOWN']), parking_brake_engaged: bool,
      emergency_stop_active: bool, single_entrance_state: en(['OPEN', 'CLOSED', 'MOVING', 'UNKNOWN']),
      entrance_clear: bool, ramp_area_clear: bool, ramp_state: en(['STOWED', 'DEPLOYED', 'MOVING', 'UNKNOWN']),
      supervision_mode: en(['ONBOARD_SAFETY_OPERATOR', 'REMOTE_OPERATOR', 'UNKNOWN']),
      safety_operator_available: bool, safety_operator_approval: bool, wheelchair_button_pressed: bool,
      wheelchair_area_ready: bool,
      cabin: obj({
        layout_id: { type: 'string', enum: ['byd-b70a02-photo-v1'] },
        occupied_seat_ids: { type: 'array', maxItems: SEAT_IDS.length, uniqueItems: true, items: { type: 'string', enum: SEAT_IDS } },
        wheelchair_bay_occupied: { type: 'boolean' },
      }, ['layout_id', 'occupied_seat_ids', 'wheelchair_bay_occupied'], false),
      hardware_capabilities: obj({
        automatic_short_ramp: capability, manual_ramp: capability, automatic_ramp_limits_verified: bool,
        automatic_ramp_max_gap_cm: num(1000), automatic_ramp_max_slope_deg: num(90),
        external_speaker: capability, external_display: capability, entrance_audio_beacon: capability,
      }),
    }),
  }, ['request_id']),
};
export const SUMMARY_SCHEMA = obj({ request_id: id, decision_summary: {
  type: 'array', minItems: 1, maxItems: 3, items: text(160),
} }, ['request_id', 'decision_summary'], false);
export const MODEL_OUTPUT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'AccessRide compact model output',
  ...obj({
    ...SUMMARY_SCHEMA.properties,
    plan_status: en(['READY', 'NEEDS_CONFIRMATION', 'CANNOT_EXECUTE']),
    actions: { type: 'array', minItems: 1, maxItems: ACTIONS.length, uniqueItems: true, items: { type: 'string', enum: ACTIONS } },
    boarding_target: boardingTarget,
    equipment_target: equipmentTarget,
    navigation_steps: navigationSteps,
  }, ['request_id', 'plan_status', 'decision_summary', 'actions', 'boarding_target', 'equipment_target', 'navigation_steps'], false),
};
