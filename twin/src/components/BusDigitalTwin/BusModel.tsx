import type { SeatOccupancy } from '../../data/cabinLayout';
import type { PassengerJourney } from '../../types/vehicle';
import { Interior } from './parts/Interior';
import { memo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
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

/**
 * Scene graph of the vehicle:
 *
 *   BusRoot
 *   ├── Wheels                (unsprung — stay on the ground)
 *   ├── GroundCues            (world space)
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
  selectedSeatId?: string;
  destination?: string;
  announcementActive: boolean;
  primaryCallout: Callout | null;
  destinationCallout: Callout | null;
}

export const BusModel = memo(function BusModel({ destination, announcementActive, primaryCallout, destinationCallout, cutaway, occupancy, passengerJourney, selectedSeatId }: Props) {
  const ctx = useTwin();
  const sprung = useRef<THREE.Group>(null!);

  useFrame(() => {
    const k = ctx.anim.values.kneelAmount;
    sprung.current.position.y = -BUS.kneel.drop * k;
    sprung.current.rotation.x = BUS.kneel.roll * k;
  });

  return (
    <group name="BusRoot">
      <Wheels />
      <GroundCues />
      <group ref={sprung} name="SprungBody">
        <Body cutaway={cutaway} />
        <group visible={!cutaway}><Windows /></group>
        <Interior destination={destination} occupancy={occupancy} cutaway={cutaway} selectedSeatId={selectedSeatId} />
        <PassengerJourneyActor journey={passengerJourney} cutaway={cutaway} />
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
  );
});
