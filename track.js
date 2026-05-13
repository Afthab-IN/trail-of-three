// Track definitions — three handcrafted spline-based circuits with themes.
// Each track exports control points (Catmull-Rom) that define the centerline.
// A road mesh is extruded along the spline, walls placed at edges, checkpoints
// inserted at uniform arc-length intervals.

import * as THREE from "https://esm.sh/three@0.160.0";

export const TRACK_WIDTH = 11;          // road width in meters
export const WALL_HEIGHT = 0.9;
export const CHECKPOINT_COUNT = 16;     // checkpoints around the loop

export const TRACKS = {
  vale: {
    id: "vale",
    name: "Vale Circuit",
    blurb: "Sunny forest pass. Banked sweepers and a tunnel.",
    laps: 3,
    theme: {
      sky:        0x88baf0,
      fogColor:   0xa4c8ea,
      fogNear:    220,
      fogFar:     900,
      sunColor:   0xfff5d8,
      sunPos:     [200, 250, 100],
      hemiTop:    0xa6c8f0,
      hemiBot:    0x4a5a30,
      hemiInt:    0.65,
      sunInt:     2.2,
      ground:     0x3a5a28,
      groundBumpScale: 1.6,
      treeColor:  0x1f3a16,
      trunkColor: 0x2a1a10,
      props:      "forest",
      bloomStrength: 0.25,
      bloomThreshold: 0.95,
    },
    // Approximate ring shape with sweepers + hairpin + jump + s-curve + tunnel
    // Centered around origin.
    points: [
      [ 0,    0],
      [ 60,  10],
      [120,  40],
      [170,  90],
      [180, 160],
      [150, 220],
      [ 90, 250],
      [ 20, 240],
      [-30, 220],
      [-50, 170],
      [-30, 130],
      [ 20, 110],
      [ 50,  90],
      [ 20,  60],
      [-30,  60],
      [-90,  80],
      [-150, 90],
      [-200, 60],
      [-220, 0],
      [-200, -60],
      [-150, -90],
      [-80, -90],
      [-30, -60],
      [  0, -20],
    ],
    // Optional jump: which segment to lift slightly (index into resampled curve)
    jump: { tStart: 0.40, tEnd: 0.43, height: 2.5 },
    // Optional tunnel
    tunnel: { tStart: 0.78, tEnd: 0.85 },
  },

  dune: {
    id: "dune",
    name: "Dune Sprint",
    blurb: "Sunset desert. Long straights — keep the boost burning.",
    laps: 3,
    theme: {
      sky:        0xf0a060,
      fogColor:   0xe89060,
      fogNear:    180,
      fogFar:     620,
      sunColor:   0xffc080,
      sunPos:     [-200, 80, -180],
      hemiTop:    0xff9050,
      hemiBot:    0x8a6020,
      hemiInt:    0.9,
      sunInt:     1.3,
      ground:     0xc89060,
      groundBumpScale: 2.8,
      treeColor:  0x6a4a20,   // re-used as cactus color
      trunkColor: 0x4a3010,
      props:      "desert",
      bloomStrength: 0.7,
      bloomThreshold: 0.82,
    },
    // Long elongated oval with subtle wiggles — favors top speed
    points: [
      [   0,    0],
      [ 120,  -10],
      [ 240,  -20],
      [ 360,  -10],
      [ 460,   30],
      [ 510,  110],
      [ 480,  190],
      [ 380,  240],
      [ 220,  260],
      [  40,  250],
      [-120,  220],
      [-240,  180],
      [-320,  110],
      [-340,   30],
      [-310,  -60],
      [-220, -110],
      [-100, -120],
      [  20,  -90],
      [ 100,  -60],
    ],
    jump: { tStart: 0.30, tEnd: 0.32, height: 3.5 },
  },

  neon: {
    id: "neon",
    name: "Neon Strip",
    blurb: "Night city. Tight turns, bloom-heavy, neon walls.",
    laps: 3,
    theme: {
      sky:        0x0a0612,
      fogColor:   0x0a0820,
      fogNear:    60,
      fogFar:     280,
      sunColor:   0x6080ff,    // moonish
      sunPos:     [60, 200, -40],
      hemiTop:    0x1a1828,
      hemiBot:    0x0a0612,
      hemiInt:    0.35,
      sunInt:     0.45,
      ground:     0x0a0612,
      groundBumpScale: 0.6,
      treeColor:  0x06080a,
      trunkColor: 0x101020,
      wallEmissive: 0xff20a0,
      props:      "neon",
      bloomStrength: 1.6,
      bloomThreshold: 0.55,
    },
    // Twisty city layout
    points: [
      [  0,   0],
      [ 50,  10],
      [ 90,  50],
      [ 90, 110],
      [ 50, 150],
      [-10, 170],
      [-60, 170],
      [-90, 130],
      [-90,  90],
      [-60,  70],
      [-30,  80],
      [  0, 110],
      [ 20, 140],
      [  0, 180],
      [-50, 200],
      [-120, 220],
      [-170, 200],
      [-200, 150],
      [-220,  80],
      [-200,   0],
      [-150, -40],
      [-80, -50],
      [-20, -30],
    ],
  },
};

// Build a Catmull-Rom curve for a track. closed=true so it's a loop.
export function makeCurve(track) {
  const pts = track.points.map(([x, z]) => new THREE.Vector3(x, 0, z));
  return new THREE.CatmullRomCurve3(pts, true, "catmullrom", 0.5);
}

// Build the road mesh, walls, and checkpoint positions for a track.
export function buildTrackGeometry(track) {
  const curve = makeCurve(track);
  const SEG = 600;
  const halfW = TRACK_WIDTH / 2;

  // Sample positions + tangents + lateral basis
  const samples = [];
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const p = curve.getPointAt(t);
    const tan = curve.getTangentAt(t);
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(tan, up).normalize();
    // Jump elevation
    let yLift = 0;
    if (track.jump) {
      const { tStart, tEnd, height } = track.jump;
      if (t >= tStart && t <= tEnd) {
        const tt = (t - tStart) / (tEnd - tStart);
        yLift = Math.sin(tt * Math.PI) * height;
      }
    }
    samples.push({ t, p: p.clone().setY(p.y + yLift), tan, right, yLift });
  }

  // Road mesh: extrude a strip
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let i = 0; i <= SEG; i++) {
    const s = samples[i];
    const lp = s.p.clone().addScaledVector(s.right, -halfW);
    const rp = s.p.clone().addScaledVector(s.right,  halfW);
    positions.push(lp.x, lp.y + 0.05, lp.z);
    positions.push(rp.x, rp.y + 0.05, rp.z);
    uvs.push(0, i * 0.5);
    uvs.push(1, i * 0.5);
  }
  for (let i = 0; i < SEG; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, c, b, b, c, d);
  }
  const roadGeo = new THREE.BufferGeometry();
  roadGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  roadGeo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  roadGeo.setIndex(indices);
  roadGeo.computeVertexNormals();

  // Walls — left and right rails
  const leftWall  = buildWallStrip(samples, -halfW - 0.4);
  const rightWall = buildWallStrip(samples,  halfW + 0.4);

  // Checkpoints — sample evenly along arc length
  const checkpoints = [];
  for (let i = 0; i < CHECKPOINT_COUNT; i++) {
    const t = i / CHECKPOINT_COUNT;
    const p = curve.getPointAt(t);
    const tan = curve.getTangentAt(t);
    checkpoints.push({
      index: i,
      pos: p.clone(),
      forward: tan.clone(),
      t,
    });
  }

  // Start line is checkpoint 0
  const startPos = curve.getPointAt(0);
  const startTan = curve.getTangentAt(0);

  return {
    curve,
    samples,
    roadGeo,
    leftWall,
    rightWall,
    checkpoints,
    startPos,
    startTan,
    totalLength: curve.getLength(),
  };
}

function buildWallStrip(samples, lateral) {
  const positions = [];
  const indices = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const base = s.p.clone().addScaledVector(s.right, lateral);
    positions.push(base.x, base.y, base.z);
    positions.push(base.x, base.y + WALL_HEIGHT, base.z);
  }
  for (let i = 0; i < samples.length - 1; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// Helper: given a position, find the nearest point on the centerline curve.
// Returns { t, dist, lateralSigned } so the game can detect off-track / wall.
const TMP_V = new THREE.Vector3();
const TMP_V2 = new THREE.Vector3();

export function nearestOnTrack(samples, x, z, hintIndex = -1) {
  // If hintIndex provided, search nearby; else full scan.
  let bestI = 0, bestD2 = Infinity;
  if (hintIndex >= 0) {
    const range = 20;
    const N = samples.length;
    for (let i = -range; i <= range; i++) {
      const idx = (hintIndex + i + N) % N;
      const s = samples[idx];
      const dx = s.p.x - x;
      const dz = s.p.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; bestI = idx; }
    }
    // If we drifted very far, fall back to full scan
    if (bestD2 > 600 * 600) {
      bestD2 = Infinity;
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        const d2 = (s.p.x - x) ** 2 + (s.p.z - z) ** 2;
        if (d2 < bestD2) { bestD2 = d2; bestI = i; }
      }
    }
  } else {
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const d2 = (s.p.x - x) ** 2 + (s.p.z - z) ** 2;
      if (d2 < bestD2) { bestD2 = d2; bestI = i; }
    }
  }
  const s = samples[bestI];
  // Signed lateral offset (positive = right of centerline)
  TMP_V.set(x - s.p.x, 0, z - s.p.z);
  const lateral = TMP_V.dot(s.right);
  return { index: bestI, t: s.t, dist: Math.sqrt(bestD2), lateral, sample: s };
}
