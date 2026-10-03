export const ACTION_LABELS: Record<string, string> = {
  ABORT_ASSISTANCE_SEQUENCE: 'Abort assistance',
  HOLD_AT_STOP: 'Hold at stop',
  REQUEST_ONBOARD_SAFETY_OPERATOR: 'Request operator assistance',
  CHECK_SINGLE_ENTRANCE_CLEARANCE: 'Check entrance clearance',
  KEEP_SINGLE_ENTRANCE_CLEAR: 'Keep entrance clear',
  PREPARE_WHEELCHAIR_AREA: 'Prepare wheelchair space',
  EXTEND_DWELL_TIME: 'Extend boarding time',
  KEEP_RAMPS_STOWED: 'Keep ramp stowed',
  OPEN_SINGLE_ENTRANCE: 'Open entrance door',
  DEPLOY_AUTOMATIC_SHORT_RAMP: 'Deploy automatic ramp',
  REQUEST_MANUAL_RAMP_DEPLOYMENT: 'Request manual ramp assistance',
  ACTIVATE_EXTERNAL_SPEAKER: 'Activate audio guidance',
  CONFIRM_ROUTE_IDENTITY: 'Announce route',
  PLAY_ENTRANCE_AUDIO_BEACON: 'Play entrance audio beacon',
  SHOW_EXTERNAL_DISPLAY: 'Show boarding message',
  GUIDE_PASSENGER_TO_ASSIGNED_PLACE: 'Guide passenger to assigned place',
  WAIT_FOR_BOARDING_CONFIRMATION: 'Wait for boarding confirmation',
  WAIT_FOR_SEATED_AND_BELTED_CONFIRMATION: 'Wait for seating and securement',
};

export const actionLabel = (action: string) => ACTION_LABELS[action] ?? action;
