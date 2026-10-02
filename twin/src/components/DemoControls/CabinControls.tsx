import { CABIN, SEATS, getCabinSnapshot } from '../../data/cabinLayout';
import type { MockBusSimulator } from '../../simulation/mockBus';
import type { VehicleState } from '../../types/vehicle';

export function CabinControls({ bus, state }: { bus: MockBusSimulator; state: VehicleState }) {
  const snapshot = getCabinSnapshot(state);
  function download() {
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = 'b70a02-cabin-state.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="dc-card cabin-controls">
    <div className="dc-row between"><h3>Passenger cabin</h3><span className="dc-pill">Simulated</span></div>
    <p className="dc-sub">{snapshot.occupiedFixedSeats} / 16 fixed seats occupied · {snapshot.availableFixedSeats} available</p>
    <div className="cabin-presets dc-mt" role="group" aria-label="Passenger scene">
      <button className="dc-btn" onClick={() => bus.setOccupancyPreset('mixed')}>Mixed</button>
      <button className="dc-btn" onClick={() => bus.setOccupancyPreset('empty')}>Empty all</button>
      <button className="dc-btn" onClick={() => bus.setOccupancyPreset('full')}>Fill all</button>
    </div>
    <p className="dc-sub dc-mt">Click a seat to add or remove a passenger.</p>
    <div className="cabin-plan" role="group" aria-label="Seat occupancy map, front at top">
      <div className="cabin-front">FRONT · DRIVER</div>
      <div className="cabin-wheelchair">♿ Wheelchair bay</div><div className="cabin-entry">Entrance →</div>
      <div className="cabin-stairs" style={{ top: `${24 + (CABIN.steps[0] + 2.2) * 44}px` }}>3 steps ↑</div>
      {SEATS.map((seat) => {
        const occupied = state.seatOccupancy?.[seat.id] ?? false;
        return <button key={seat.id} className={`cabin-seat ${occupied ? 'occupied' : ''} ${seat.kind === 'priority' ? 'priority' : ''}`}
          style={{ top: `${24 + (seat.position[0] + 2.2) * 44}px`, left: `${50 + seat.position[2] * 41}%` }}
          aria-label={`${seat.id}, ${seat.kind}, ${occupied ? 'occupied' : 'empty'}`} aria-pressed={occupied}
          title={`${seat.id} · ${seat.zone} · ${seat.kind}`} onClick={() => bus.setSeatOccupied(seat.id, !occupied)}>
          <span aria-hidden="true">{occupied ? '●' : '○'}</span> {seat.id}
        </button>;
      })}
      <div className="cabin-rear">REAR PLATFORM</div>
    </div>
    <div className="cabin-legend"><span>● Occupied</span><span>○ Empty</span><span className="priority-key">Priority</span></div>
    <p className="dc-sub dc-mt">F01 is an additional fold-up seat. It folds away when empty; wheelchair occupancy is not simulated.</p>
    <button className="dc-btn dc-mt" onClick={download}>Export seat state (JSON)</button>
  </section>;
}
