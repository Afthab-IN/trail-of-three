// World generation — host generates once and broadcasts to all clients.

export const TILE_PX = 24;
export const WORLD_W = 40;
export const WORLD_H = 25;

// Mulberry32 RNG
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function carvePath(tiles, x1, y1, x2, y2) {
  let x = x1, y = y1;
  while (x !== x2 || y !== y2) {
    tiles[y][x] = "path";
    if (x !== x2 && Math.random() < 0.6) x += x < x2 ? 1 : -1;
    else if (y !== y2) y += y < y2 ? 1 : -1;
    else x += x < x2 ? 1 : -1;
  }
  tiles[y2][x2] = "path";
}

export function generateWorld(seed) {
  const rng = makeRng(seed);
  const W = WORLD_W, H = WORLD_H;
  const tiles = [];

  for (let y = 0; y < H; y++) {
    const row = [];
    for (let x = 0; x < W; x++) {
      // Border = trees
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) {
        row.push("tree");
        continue;
      }
      const r = rng();
      if (r < 0.12) row.push("tree");
      else if (r < 0.16) row.push("rock");
      else if (r < 0.20) row.push("water");
      else row.push("grass");
    }
    tiles.push(row);
  }

  // Clear spawn area (top-left)
  for (let y = 1; y <= 4; y++) {
    for (let x = 1; x <= 4; x++) tiles[y][x] = "grass";
  }

  // Clear ruin area (bottom-right) for boss
  for (let y = H - 6; y <= H - 2; y++) {
    for (let x = W - 6; x <= W - 2; x++) tiles[y][x] = "ruin";
  }

  // Carve a winding path from spawn to ruin
  let x = 3, y = 3;
  while (x < W - 4 || y < H - 4) {
    tiles[y][x] = "path";
    const goRight = x < W - 4 && (y >= H - 4 || rng() < 0.55);
    if (goRight) x++;
    else y++;
  }

  // Entities
  const entities = {};
  let nextId = 1;
  const placeOnGrass = (factory, count) => {
    let placed = 0, tries = 0;
    while (placed < count && tries < count * 30) {
      tries++;
      const ex = 2 + Math.floor(rng() * (W - 4));
      const ey = 2 + Math.floor(rng() * (H - 4));
      if (tiles[ey][ex] !== "grass") continue;
      // Avoid spawn cluster
      if (ex <= 5 && ey <= 5) continue;
      // Check no entity already there
      if (Object.values(entities).some(e => e.x === ex && e.y === ey)) continue;
      const e = factory(ex, ey, rng);
      entities[`e${nextId++}`] = e;
      placed++;
    }
  };

  placeOnGrass((x, y, rng) => ({ type: "gold", x, y, value: 5 + Math.floor(rng() * 10) }), 18);
  placeOnGrass((x, y, rng) => {
    const tier = rng();
    if (tier < 0.5) return { type: "monster", name: "Wisp",   x, y, hp: 6,  maxHp: 6,  dmg: 2, gold: 8 };
    if (tier < 0.85) return { type: "monster", name: "Wraith", x, y, hp: 12, maxHp: 12, dmg: 3, gold: 15 };
    return { type: "monster", name: "Hollow", x, y, hp: 20, maxHp: 20, dmg: 4, gold: 25 };
  }, 10);
  placeOnGrass((x, y, rng) => ({ type: "chest",  x, y, gold: 30 + Math.floor(rng() * 50) }), 4);
  placeOnGrass((x, y, rng) => ({ type: "flower", x, y, heal: 15 }), 5);

  // Boss in the ruins
  entities["boss"] = {
    type: "boss",
    name: "The Pale Lord",
    x: W - 3,
    y: H - 3,
    hp: 80,
    maxHp: 80,
    dmg: 6,
    gold: 200,
  };

  // Spawn points cluster
  const spawns = [
    { x: 2, y: 2 },
    { x: 3, y: 2 },
    { x: 2, y: 3 },
  ];

  return { W, H, tiles, entities, spawns };
}

export const TERRAIN_WALKABLE = new Set(["grass", "path", "ruin"]);

export function isWalkable(world, x, y) {
  if (x < 0 || y < 0 || x >= world.W || y >= world.H) return false;
  return TERRAIN_WALKABLE.has(world.tiles[y][x]);
}

export function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}
