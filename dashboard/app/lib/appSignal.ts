import type { Snapshot } from '../live-types';

export type AppBookingStatus = 'awaiting' | 'booked' | 'at_stop' | 'on_board' | 'cancelled' | 'expired';
export type AppSignal = {
  received: boolean;
  source: 'app' | 'demo' | 'none';
  status: AppBookingStatus;
  statusLabel: string;
  aid: string | null;
  aidLabel: string | null;
  rampPreference: string | null;
  assistance: string[];
  route: string | null;
  stop: string | null;
  interaction: string | null;
  guidance: string;
  eventId: string | null;
  receivedAt: number | null;
};

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const readable = (value: string) => value.toLowerCase().replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase());
const aidLabels: Record<string, string> = {
  WHEELCHAIR: 'Wheelchair', STROLLER: 'Stroller', CANE: 'Cane', CRUTCH: 'Crutches', WALKER: 'Walker',
  VISUAL_ASSISTANCE: 'Vision assistance', HEARING_ASSISTANCE: 'Hearing assistance',
  MOBILITY_ASSISTANCE: 'Mobility assistance', NONE: 'No assistance', UNKNOWN: 'Not specified',
};
const statusLabels: Record<AppBookingStatus, string> = {
  awaiting: 'Awaiting booking', booked: 'Booking received', at_stop: 'At the bus stop',
  on_board: 'On board · simulation', cancelled: 'Booking cancelled', expired: 'Booking expired',
};
const fallbackGuidance: Record<AppBookingStatus, string> = {
  awaiting: 'Submit an assistance request in the app.',
  booked: 'Your assistance request has been received. Please wait for guidance.',
  at_stop: 'Please wait at the marked boarding point for assistance.',
  on_board: 'Follow the assigned-place guidance and wait for the safety operator.',
  cancelled: 'Your assistance request has been cancelled.',
  expired: 'Your booking has expired. Please submit a new assistance request.',
};

/** A booking-channel receipt is evidence of input, not proof that a phone is online. */
export function appSignalFromSnapshot(snapshot: Snapshot | null): AppSignal {
  const booking = snapshot?.channels.booking;
  const request = snapshot?.context.request;
  const journey = snapshot?.journey;
  const eventId = text(booking?.event_id);
  const completedNeed = journey?.completed === true && text(journey.need) !== null;
  const received = snapshot?.source === 'external' && eventId !== null && (!!request || completedNeed);
  if (!received) return {
    received: false, source: snapshot?.source === 'demo' ? 'demo' : 'none',
    status: 'awaiting', statusLabel: statusLabels.awaiting, aid: null, aidLabel: null,
    rampPreference: null, assistance: [], route: null, stop: null, interaction: null,
    guidance: fallbackGuidance.awaiting, eventId: null, receivedAt: null,
  };

  const status: AppBookingStatus = journey?.stage === 'ON_BOARD' ? 'on_board'
    : journey?.stage === 'AT_STOP' ? 'at_stop'
    : journey?.stage === 'BOOKED' ? 'booked'
    : journey?.reason === 'expired' ? 'expired'
    : journey?.reason === 'cancelled' || request?.active === false ? 'cancelled'
    : request?.active === true ? 'booked' : 'awaiting';
  const aid = text(request?.accessibility_need) ?? text(journey?.need);
  const final = status === 'cancelled' || status === 'expired';
  const guidance = (final ? text(journey?.guidance.display_text) :
    text(snapshot.navigation?.instruction) ?? text(journey?.guidance.display_text) ??
      text(snapshot.result?.passenger_communication.display_text)) ?? fallbackGuidance[status];
  return {
    received: true, source: 'app', status, statusLabel: statusLabels[status], aid,
    aidLabel: aid ? aidLabels[aid] ?? readable(aid) : null,
    rampPreference: text(request?.ramp_preference) ? readable(request!.ramp_preference!) : null,
    assistance: (request?.assistance_requested ?? []).filter(item => text(item) !== null).map(readable),
    route: text(request?.route_id), stop: text(request?.stop_id),
    interaction: text(request?.preferred_interaction) ? readable(request!.preferred_interaction!) : null,
    guidance, eventId,
    receivedAt: typeof booking?.received_at === 'number' && Number.isFinite(booking.received_at) ? booking.received_at : null,
  };
}
