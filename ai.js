// Simple AI driver — follows track centerline, brakes for sharp turns, uses boost on straights.

import * as THREE from "https://esm.sh/three@0.160.0";

export class AIDriver {
  constructor(car, samples, skill = 0.92) {
    this.car = car;
    this.samples = samples;     // track samples
    this.skill = skill;         // 0.85..1.0 — caps top speed and adds slight noise
    this.lookAhead = 14 + Math.random() * 6;  // meters
    this.brakeLookAhead = 22 + Math.random() * 8;
    this.driftNext = false;
  }

  // Find sample index ahead by ~lookAhead meters of arc.
  // We approximate by stepping forward N indices proportional to sample spacing.
  findTargetIndex(currentIdx, distAhead) {
    const N = this.samples.length;
    // Estimate avg segment length ~ totalLength / N. We don't have totalLength here;
    // step roughly by 1 index per (avg segment ~ trackLength/N). Caller passes meters.
    // Approximate: average segment len ~ 1.0–1.5m given 600 samples / ~600–900m tracks.
    const stepsAhead = Math.max(3, Math.floor(distAhead / 1.2));
    return (currentIdx + stepsAhead) % N;
  }

  curvatureAt(idx, samplesAhead = 18) {
    const N = this.samples.length;
    const a = this.samples[idx].tan;
    const b = this.samples[(idx + samplesAhead) % N].tan;
    // Angle between tangents
    const dot = Math.max(-1, Math.min(1, a.dot(b)));
    return Math.acos(dot);
  }

  step(dt) {
    const car = this.car;
    // Find nearest sample (simple linear search but with a hint via lastTrackIndex)
    const hint = car.lastTrackIndex || 0;
    let bestI = hint, bestD2 = Infinity;
    const N = this.samples.length;
    const range = 30;
    for (let i = -range; i <= range; i++) {
      const idx = (hint + i + N) % N;
      const s = this.samples[idx];
      const d2 = (s.p.x - car.pos.x) ** 2 + (s.p.z - car.pos.z) ** 2;
      if (d2 < bestD2) { bestD2 = d2; bestI = idx; }
    }
    car.lastTrackIndex = bestI;

    // Aim point a bit ahead
    const aim = this.samples[this.findTargetIndex(bestI, this.lookAhead)];

    // Steer toward aim
    const dx = aim.p.x - car.pos.x;
    const dz = aim.p.z - car.pos.z;
    const desiredHeading = Math.atan2(dx, dz);
    let delta = desiredHeading - car.heading;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    car.steerInput = Math.max(-1, Math.min(1, delta * 2.2));

    // Look further ahead to decide throttle/brake
    const curv = this.curvatureAt(bestI, 28);
    const speed = car.speed();
    const targetTop = 55 * this.skill;       // base top speed
    // If upcoming curvature is high, slow down
    if (curv > 0.6 && speed > 30) {
      car.throttle = 0;
      car.brake = 0.85;
      car.drifting = curv > 0.9 && speed > 35;
    } else if (curv > 0.35 && speed > 42) {
      car.throttle = 0.6;
      car.brake = 0;
      car.drifting = false;
    } else {
      car.throttle = 1;
      car.brake = 0;
      car.drifting = false;
    }

    // Boost on straights when full
    if (car.boost > 0.9 && curv < 0.18) car.boostActive = true;
    if (curv > 0.45) car.boostActive = false;

    // Tiny noise so they don't drive perfectly
    car.steerInput += (Math.random() - 0.5) * 0.02;
  }
}
