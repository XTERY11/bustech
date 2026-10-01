export type Mode = 'single' | 'two_turn' | 'rules';
export type Context = {
  request_id: string;
  presentation_mode?: string;
  request?: { active?: boolean | null; accessibility_need?: string | null; ramp_preference?: string | null; assistance_requested?: string[]; preferred_interaction?: string; language?: string; route_id?: string; stop_id?: string; observation_age_ms?: number; [key: string]: unknown };
  perception?: { yolo_detections?: { label: string | null; confidence: number | null; track_id?: string }[]; target_match_confirmed?: boolean; observation_age_ms?: number; geometry?: { measured_gap_cm?: number; measured_slope_deg?: number; [key: string]: unknown }; [key: string]: unknown };
  vehicle_context?: { motion_state?: string; single_entrance_state?: string; ramp_state?: string; entrance_clear?: boolean; ramp_area_clear?: boolean; safety_operator_approval?: boolean; emergency_stop_active?: boolean; observation_age_ms?: number; [key: string]: unknown };
};
export type Summary = { request_id: string; decision_summary: string[] };
export type Result = {
  request_id: string; plan_status: string; simulated: boolean; execution_authorized: boolean;
  decision_summary: string[]; safety_flags: string[];
  action_plan: { step: number; action: string; parameters: Record<string, unknown> }[];
  passenger_communication: { channel: string; language: string; audio_text: string | null; display_text: string | null };
  meta: { mode: string; source: string; api_calls: number; model: string | null; latency_ms: number; error?: string; validation_passed: boolean; usage: { total_tokens?: number } };
};
export type Snapshot = { source: 'demo' | 'external'; mode: Mode; context: Context; channels: Record<string, { received_at: number; observed_at: number; event_id: string }>; running: string | null; summary: Summary | null; result: Result | null };
export type HubEvent = { id: number; type: string; at: number; data: Record<string, unknown> };
