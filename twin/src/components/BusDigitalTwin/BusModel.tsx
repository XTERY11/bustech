import type { SeatOccupancy } from '../../data/cabinLayout';
import type { PassengerJourney, VehicleArrival } from '../../types/vehicle';
import { Interior } from './parts/Interior';
import { memo, useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { Callout } from '../../state/presentation';
import { BUS } from './dimensions';
import { useTwin } from './twinContext';
import { Body } from './parts/Body';
import { Windows } from './parts/Windows';
import { Wheels } from './parts/Wheels';
import { ExteriorLights } from './parts/ExteriorLights';
import { AccessibilityIndicator, GroundCues } from './parts/StatusIndicators';
import { FrontDoor } from './Door';
import { RampAssembly } from './Ramp';
import { DestinationDisplay } from './DestinationDisplay';
import { AnnouncementIndicator, VehicleCallouts } from './VehicleCallouts';
import { PassengerJourneyActor } from '../Passengers/PassengerJourney';
import { advanceArrivalProgress, arrivalPosition, ARRIVAL_START_X } from '../../simulation/arrival';

/**
 * Scene graph of the vehicle:
 *
 *   BusStopScene
 *   ├── GroundCues            (world space)
 *   ├── PassengerJourney      (world space, fixed while waiting)
 *   └── BusRoot               (arrival transform)
 *   ├── Wheels                (unsprung — stay on the ground)
 *   └── SprungBody            (kneeling transform)
 *       ├── Body · Windows · ExteriorLights
 *       ├── FrontDoor ─ DoorLeafA / DoorLeafB
 *       ├── RampAssembly ─ Ramp
 *       ├── DestinationDisplay
 *       ├── StatusIndicators
 *       └── Callouts / announcement (DOM, anchored)
 *
 * To swap in a production GLB: replace Body/Windows/Wheels/ExteriorLights
 * with the model's meshes and parent the door leaves / ramp nodes the same
 * way — the animation drivers only need those groups.
 */

interface Props {
  cutaway: boolean;
  occupancy?: SeatOccupancy;
  passengerJourney?: PassengerJourney | null;
  arrival?: VehicleArrival | null;
  selectedSeatId?: string;
  destination?: string;
  announcementActive: boolean;
  primaryCallout: Callout | null;
  destinationCallout: Callout | null;
}

export const BusModel = memo(function BusModel({ destination, announcementActive, primaryCallout, destinationCallout, cutaway, occupancy, passengerJourney, arrival, selectedSeatId }: Props) {
  const ctx = useTwin();
  const sprung = useRef<THREE.Group>(null!);
  const busRoot = useRef<THREE.Group>(null!);
  const passengerRoot = useRef<THREE.Group>(null!);
  const invalidate = useThree((state) => state.invalidate);
  const arrivalProgress = useRef(arrival?.progress ?? 1);
  const previousArrival = useRef<string | undefined>(arrival?.id);
  const wheelTravel = useRef(0);

  useEffect(() => {
    if (!arrival) {
      arrivalProgress.current = 1;
      previousArrival.current = undefined;
    } else if (arrival.id !== previousArrival.current) {
      arrivalProgress.current = arrival.progress;
      previousArrival.current = arrival.id;
    }
    busRoot.current.position.x = arrival ? arrivalPosition(arrivalProgress.current) : 0;
    invalidate();
  }, [arrival, invalidate]);

  useFrame((_, delta) => {
    const target = arrival?.progress ?? 1;
    if (Math.abs(target - arrivalProgress.current) > 0.000001) {
      arrivalProgress.current = advanceArrivalProgress(arrivalProgress.current, target, delta);
      invalidate();
    }
    const x = arrival ? arrivalPosition(arrivalProgress.current) : 0;
    busRoot.current.position.x = x;
    wheelTravel.current = arrival ? x - ARRIVAL_START_X : 0;
    const k = ctx.anim.values.kneelAmount;
    sprung.current.position.y = -BUS.kneel.drop * k;
    sprung.current.rotation.x = BUS.kneel.roll * k;
    const passengerKneel = passengerJourney?.stage === 'waiting' ? 0 : k;
    passengerRoot.current.position.y = -BUS.kneel.drop * passengerKneel;
    passengerRoot.current.rotation.x = BUS.kneel.roll * passengerKneel;
  });

  return (
    <group name="BusStopScene">
      <GroundCues />
      <group ref={passengerRoot} name="PassengerWorldRoot">
        <PassengerJourneyActor journey={passengerJourney} cutaway={cutaway} />
      </group>
      <group ref={busRoot} name="BusRoot" position={[arrival ? arrivalPosition(arrivalProgress.current) : 0, 0, 0]}>
        <Wheels travel={wheelTravel} />
        <group ref={sprung} name="SprungBody">
          <Body cutaway={cutaway} />
          <group visible={!cutaway}><Windows /></group>
          <Interior destination={destination} occupancy={occupancy} cutaway={cutaway} selectedSeatId={selectedSeatId} />
          <ExteriorLights cutaway={cutaway} />
          {!cutaway && <FrontDoor />}
          <RampAssembly />
          {!cutaway && <DestinationDisplay destination={destination} />}
          <group name="StatusIndicators">
            <AccessibilityIndicator />
          </group>
          <VehicleCallouts primary={primaryCallout} secondary={destinationCallout} />
          <AnnouncementIndicator active={announcementActive} />
        </group>
      </group>
    </group>
  );
});
