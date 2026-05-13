// World — terrain heightmap, obstacle positions, spawn points.
// Deterministic from seed so host can broadcast just the seed.

import * as THREE from "https://esm.sh/three@0.160.0";

export const WORLD = {
  SIZE: 220,        // half-extent in each direction; world spans -SIZE..+SIZE on X and Z
  SEG: 90,          // terrain mesh segments per side
  PEAK: { x: 90, z: 90, r: 40, h: 18 },   // mountain peak (boss area)
  SPAWN: { x: -90, z: -90 },              // player spawn area
};

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Cheap fractal noise from sums of sines.
function fnoise(x, z) {
  let h = 0;
  h += Math.sin(x * 0.045) * 1.8;
  h += Math.cos(z * 0.055) * 1.8;
  h += Math.sin((x + z) * 0.08) * 1.1;
  h += Math.sin(x * 0.16 + 13) * 0.5;
  h += Math.cos(z * 0.21 + 7) * 0.4;
  return h;
}

// Public: world-space height at (x, z).
export function heightAt(x, z) {
  let h = fnoise(x, z);

  // Mountain ring around the edges
  const R = WORLD.SIZE;
  const distEdge = Math.max(Math.abs(x), Math.abs(z));
  if (distEdge > R - 60) {
    const t = (distEdge - (R - 60)) / 60;
    h += t * t * 25;
  }

  // Mountain peak (boss area)
  const px = x - WORLD.PEAK.x;
  const pz = z - WORLD.PEAK.z;
  const pd = Math.sqrt(px * px + pz * pz);
  if (pd < WORLD.PEAK.r) {
    const t = 1 - pd / WORLD.PEAK.r;
    h += t * t * WORLD.PEAK.h;
  }

  // River — a low strip running roughly along x=0
  const riverDist = Math.abs(x - Math.sin(z * 0.05) * 8);
  if (riverDist < 4) {
    const t = 1 - riverDist / 4;
    h -= t * t * 3.2;
  }

  return h;
}

// Returns true if (x, z) is inside the river (water).
export function isWater(x, z) {
  return heightAt(x, z) < -1.4;
}

// Build the terrain BufferGeometry.
export function buildTerrainGeometry() {
  const W = WORLD.SIZE * 2;
  const SEG = WORLD.SEG;
  const positions = [];
  const colors = [];
  const uvs = [];
  const indices = [];

  for (let zi = 0; zi <= SEG; zi++) {
    for (let xi = 0; xi <= SEG; xi++) {
      const x = (xi / SEG - 0.5) * W;
      const z = (zi / SEG - 0.5) * W;
      const y = heightAt(x, z);
      positions.push(x, y, z);
      uvs.push(xi / SEG, zi / SEG);

      // Color by elevation/slope for a hand-painted look
      let r, g, b;
      if (y < -1.4) { r = 0.10; g = 0.18; b = 0.30; }                 // water bed
      else if (y < 0.2)  { r = 0.32; g = 0.30; b = 0.22; }            // riverbank/dirt
      else if (y < 4)    { r = 0.18 + Math.random()*0.04; g = 0.32 + Math.random()*0.05; b = 0.16; } // grass
      else if (y < 9)    { r = 0.30; g = 0.30; b = 0.20; }            // hillside
      else               { r = 0.55; g = 0.55; b = 0.58; }            // stone peak
      colors.push(r, g, b);
    }
  }

  for (let zi = 0; zi < SEG; zi++) {
    for (let xi = 0; xi < SEG; xi++) {
      const a = zi * (SEG + 1) + xi;
      const b = a + 1;
      const c = a + (SEG + 1);
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// Scatter trees, rocks, and props. Returns positions arrays.
export function placeProps(seed) {
  const rng = mulberry32(seed);
  const trees = [];
  const bigTrees = [];
  const rocks = [];

  for (let i = 0; i < 800; i++) {
    const x = (rng() - 0.5) * (WORLD.SIZE * 2 - 20);
    const z = (rng() - 0.5) * (WORLD.SIZE * 2 - 20);
    const y = heightAt(x, z);
    // Don't put trees in water, on peak rocks, or in spawn camp
    if (y < 0.1) continue;
    if (y > 9) continue;
    // Skip peak
    const pd2 = (x - WORLD.PEAK.x) ** 2 + (z - WORLD.PEAK.z) ** 2;
    if (pd2 < (WORLD.PEAK.r + 6) ** 2) continue;
    // Skip spawn camp
    const sd2 = (x - WORLD.SPAWN.x) ** 2 + (z - WORLD.SPAWN.z) ** 2;
    if (sd2 < 144) continue;

    const scale = 0.85 + rng() * 0.7;
    const rot = rng() * Math.PI * 2;
    if (rng() < 0.18) bigTrees.push({ x, y, z, scale: scale * 1.3, rot });
    else trees.push({ x, y, z, scale, rot });
  }

  for (let i = 0; i < 180; i++) {
    const x = (rng() - 0.5) * (WORLD.SIZE * 2 - 10);
    const z = (rng() - 0.5) * (WORLD.SIZE * 2 - 10);
    const y = heightAt(x, z);
    if (y < -0.5) continue;
    const scale = 0.6 + rng() * 1.4;
    const rot = rng() * Math.PI * 2;
    rocks.push({ x, y, z, scale, rot });
  }

  return { trees, bigTrees, rocks };
}

// Place monsters + boss + gold piles + chests. Host generates and broadcasts to clients.
export function placeEntities(seed) {
  const rng = mulberry32(seed);
  const entities = {};
  let nextId = 1;
  const newId = (prefix) => prefix + "_" + (nextId++);

  // Monsters scattered around (avoid spawn + peak edges)
  for (let i = 0; i < 22; i++) {
    let x, z, tries = 0;
    do {
      x = (rng() - 0.5) * (WORLD.SIZE * 2 - 30);
      z = (rng() - 0.5) * (WORLD.SIZE * 2 - 30);
      tries++;
    } while (tries < 20 && (
      heightAt(x, z) < 0.1 ||
      heightAt(x, z) > 8 ||
      (x - WORLD.SPAWN.x) ** 2 + (z - WORLD.SPAWN.z) ** 2 < 800 ||
      (x - WORLD.PEAK.x) ** 2 + (z - WORLD.PEAK.z) ** 2 < (WORLD.PEAK.r + 5) ** 2
    ));
    const tier = rng();
    let m;
    if (tier < 0.5) m = { type: "wolf",    hp: 12, maxHp: 12, dmg: 4, speed: 5.5, gold: 8,  attackRange: 1.6, sightRange: 22 };
    else if (tier < 0.85) m = { type: "skeleton", hp: 22, maxHp: 22, dmg: 6, speed: 3.2, gold: 16, attackRange: 1.8, sightRange: 18 };
    else m = { type: "troll", hp: 50, maxHp: 50, dmg: 11, speed: 2.4, gold: 35, attackRange: 2.4, sightRange: 14 };

    const id = newId(m.type);
    entities[id] = { id, ...m, x, z, vx: 0, vz: 0, attackCd: 0 };
  }

  // Gold piles (collectible)
  for (let i = 0; i < 12; i++) {
    let x, z, tries = 0;
    do {
      x = (rng() - 0.5) * (WORLD.SIZE * 1.8);
      z = (rng() - 0.5) * (WORLD.SIZE * 1.8);
      tries++;
    } while (tries < 20 && (heightAt(x, z) < 0.2 || heightAt(x, z) > 7));
    const id = newId("gold");
    entities[id] = { id, type: "gold_pile", x, z, value: 12 + Math.floor(rng() * 25) };
  }

  // Treasure chests (bigger reward)
  for (let i = 0; i < 5; i++) {
    let x, z, tries = 0;
    do {
      x = (rng() - 0.5) * (WORLD.SIZE * 1.7);
      z = (rng() - 0.5) * (WORLD.SIZE * 1.7);
      tries++;
    } while (tries < 20 && (heightAt(x, z) < 0.4 || heightAt(x, z) > 6));
    const id = newId("chest");
    entities[id] = { id, type: "chest", x, z, value: 60 + Math.floor(rng() * 60) };
  }

  // Boss — on the peak
  entities["boss"] = {
    id: "boss",
    type: "dragon",
    hp: 200,
    maxHp: 200,
    dmg: 14,
    speed: 4.0,
    gold: 500,
    attackRange: 3.5,
    sightRange: 60,
    x: WORLD.PEAK.x,
    z: WORLD.PEAK.z,
    vx: 0,
    vz: 0,
    attackCd: 0,
    aggro: false,
  };

  return entities;
}
