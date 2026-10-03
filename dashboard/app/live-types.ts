export type Mode = 'single' | 'two_turn' | 'rules';
export type Context = {
  request_id: string;
  booking_event_id?: string;
  presentation_mode?: string;
  request?: { active?: boolean | null; accessibility_need?: string | null; ramp_preference?: string | null; assistance_requested?: string[]; preferred_interaction?: string; language?: string; route_id?: string; stop_id?: string; observation_age_ms?: number; [key: string]: unknown };
  perception?: { yolo_detections?: { label: string | null; confidence: number | null; track_id?: string }[]; target_match_confirmed?: boolean; observation_age_ms?: number; zone?: { triggered?: boolean | null; roi_id?: string; visit_id?: string; event?: 'enter' | 'present' | 'exit' | null; left?: string[] }; geometry?: { measured_gap_cm?: number; measured_slope_deg?: number; [key: string]: unknown }; [key: string]: unknown };
  vehicle_context?: { motion_state?: string; single_entrance_state?: string; ramp_state?: string; entrance_clear?: boolean; ramp_area_clear?: boolean; safety_operator_approval?: boolean; emergency_stop_active?: boolean; observation_age_ms?: number; cabin?: { layout_id: string; occupied_seat_ids: string[]; wheelchair_bay_occupied: boolean }; [key: string]: unknown };
};
export type BoardingTarget = { type: 'SEAT' | 'WHEELCHAIR_BAY'; id: string };
export type NavigationStep = { step: number; maneuver: 'START' | 'STRAIGHT' | 'TURN_LEFT' | 'TURN_RIGHT' | 'PARK_STROLLER' | 'ARRIVE'; distance_m: number | null; text: string };
export type CabinNavigation = { layout_id: string; origin: { type: 'ENTRANCE'; id: 'SINGLE_ENTRANCE'; facing: 'INTO_BUS' }; target: BoardingTarget;
  equipment_target?: BoardingTarget | null; steps: NavigationStep[]; mode: 'map_based'; simulated: true; requires_operator: true };
export type JourneyAnimation = { id: string; phase: 'arrival' | 'boarding'; aid: string; started_at: number; duration_ms: number; target: BoardingTarget | null; equipment_target?: BoardingTarget | null };
export type Navigation = { id: string; revision: number; phase: 'TO_STOP' | 'WAIT_AT_STOP' | 'BOARD_BUS' | 'TO_SEAT' | 'TO_WHEELCHAIR_BAY'; destination: { type: 'BUS_STOP' | 'SEAT' | 'WHEELCHAIR_BAY'; id: string }; instruction: string; simulated: true; animation?: JourneyAnimation | null;
  equipment_target?: BoardingTarget | null; steps?: NavigationStep[]; cabin_route?: CabinNavigation | null };
export type Summary = { request_id: string; decision_summary: string[] };
export type Result = {
  request_id: string; plan_status: string; simulated: boolean; execution_authorized: boolean;
  schema_version?: string; boarding_target?: BoardingTarget | null; equipment_target?: BoardingTarget | null; cabin_navigation?: CabinNavigation | null;
  decision_summary: string[]; safety_flags: string[];
  action_plan: { step: number; action: string; parameters: Record<string, unknown> }[];
  passenger_communication: { channel: string; language: string; audio_text: string | null; display_text: string | null };
  meta: { mode: string; source: string; api_calls: number; model: string | null; latency_ms: number; error?: string; validation_passed: boolean; usage: { total_tokens?: number } };
};
/** Passenger journey from the hub (backend/journey.mjs); null for demo presets. The App shows `guidance`. */
export type Journey = { stage: 'IDLE' | 'BOOKED' | 'AT_STOP' | 'ON_BOARD'; journey_id?: string | null; revision?: number; completed?: boolean; pending_exit?: boolean; reason?: string | null; visit_id?: string | null; roi_id?: string | null; updated_at?: number; boarding_target?: BoardingTarget | null; equipment_target?: BoardingTarget | null; animation?: JourneyAnimation | null; matched?: boolean; need?: string | null; labels?: string[]; seat?: string | null;
  guidance: { title: string; display_text: string; audio_text: string } };
export type Snapshot = { journey?: Journey | null; navigation?: Navigation | null; source: 'demo' | 'external'; mode: Mode; context: Context; channels: Record<string, { received_at: number; observed_at: number; event_id: string }>; running: string | null; summary: Summary | null; result: Result | null };
export type HubEvent = { id: number; type: string; at: number; data: Record<string, unknown> };
