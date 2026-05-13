import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { generateWorld, isWalkable, manhattan, TILE_PX, WORLD_W, WORLD_H } from "./world.js";

const ROLES = {
  scout:   { name: "Scout",   glyph: "◈", color: "#6ec79b", desc: "Quick on their feet. Moves twice per tick.", maxHp: 25, dmg: 3, moveMs: 110 },
  brawler: { name: "Brawler", glyph: "✦", color: "#d97455", desc: "Tough and heavy-handed. Hits twice as hard.", maxHp: 45, dmg: 6, moveMs: 220 },
  mystic:  { name: "Mystic",  glyph: "✧", color: "#9b7ed4", desc: "Channels light. Press E to heal nearby allies.", maxHp: 28, dmg: 3, moveMs: 170 },
};

const state = {
  supabase: null,
  channel: null,
  roomCode: null,
  myId: crypto.randomUUID(),
  myName: "",
  myRole: null,
  isHost: false,
  phase: "home",
  players: {},     // id -> { name, role, x, y, hp, maxHp, gold, alive }
  world: null,     // { W, H, tiles, spawns }
  entities: {},    // id -> entity
  lastMoveAt: 0,
  lastAbilityAt: 0,
  pressed: {},
};

const $ = (s) => document.querySelector(s);

function show(id) { $(id).classList.remove("hidden"); }
function hide(id) { $(id).classList.add("hidden"); }
function setText(s, t) { $(s).textContent = t; }

function banner(msg, kind = "info") {
  const b = $("#banner");
  b.textContent = msg;
  b.className = "banner" + (kind === "info" ? " info" : "");
  b.classList.remove("hidden");
  clearTimeout(banner._t);
  banner._t = setTimeout(() => b.classList.add("hidden"), 4000);
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

// --- Supabase init ---
function initSupabase() {
  if (SUPABASE_URL.includes("PASTE_") || SUPABASE_ANON_KEY.includes("PASTE_")) {
    banner("Edit config.js with your Supabase URL and anon key.", "error");
    return false;
  }
  state.supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return true;
}

function makeRoomCode() {
  const chars = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
  let c = "";
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

// --- Networking ---
async function connectChannel() {
  const channel = state.supabase.channel(`trail:${state.roomCode}`, {
    config: { broadcast: { self: true }, presence: { key: state.myId } },
  });

  channel.on("broadcast", { event: "msg" }, ({ payload }) => handle(payload));
  channel.on("presence", { event: "sync" }, () => {
    const ps = channel.presenceState();
    const present = new Set();
    for (const arr of Object.values(ps)) for (const p of arr) present.add(p.id);
    let changed = false;
    for (const id of Object.keys(state.players)) {
      if (!present.has(id)) { delete state.players[id]; changed = true; }
    }
    if (changed) renderHud();
  });

  await new Promise((res) => {
    channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await channel.track({ id: state.myId, name: state.myName });
        res();
      }
    });
  });
  state.channel = channel;

  send({ type: "hello", id: state.myId, name: state.myName });
  send({ type: "req-state", id: state.myId });
}

function send(payload) {
  state.channel.send({ type: "broadcast", event: "msg", payload });
}

// --- Host / join ---
async function hostRoom() {
  const name = $("#name").value.trim();
  if (!name) return banner("Enter your name first.", "error");
  if (!initSupabase()) return;
  state.myName = name;
  state.roomCode = makeRoomCode();
  state.isHost = true;
  await connectChannel();
  enterLobby();
}

async function joinRoom() {
  const name = $("#name").value.trim();
  const code = $("#room-code-input").value.trim().toUpperCase();
  if (!name) return banner("Enter your name first.", "error");
  if (code.length !== 6) return banner("Enter a 6-char room code.", "error");
  if (!initSupabase()) return;
  state.myName = name;
  state.roomCode = code;
  state.isHost = false;
  await connectChannel();
  enterLobby();
}

function enterLobby() {
  state.phase = "lobby";
  hide("#screen-home");
  show("#screen-role");
  setText("#room-code-display", state.roomCode);
  renderRolePick();
}

// --- Message handler ---
function handle(m) {
  switch (m.type) {
    case "hello": {
      if (!state.players[m.id]) {
        state.players[m.id] = { name: m.name, role: null, x: 0, y: 0, hp: 0, maxHp: 0, gold: 0, alive: true };
      } else {
        state.players[m.id].name = m.name;
      }
      if (state.isHost) sendSnapshotTo(m.id);
      renderHud();
      renderRolePick();
      break;
    }
    case "req-state": {
      if (state.isHost && m.id !== state.myId) sendSnapshotTo(m.id);
      break;
    }
    case "snapshot": {
      if (m.to !== state.myId) return;
      for (const [id, p] of Object.entries(m.players)) {
        state.players[id] = { ...(state.players[id] || {}), ...p };
      }
      state.phase = m.phase;
      if (m.world) state.world = m.world;
      if (m.entities) state.entities = m.entities;
      renderHud();
      if (state.phase === "lobby") renderRolePick();
      if (state.phase === "playing") enterGame();
      break;
    }
    case "role-pick": {
      if (!state.players[m.id]) state.players[m.id] = { name: m.name, gold: 0, alive: true };
      state.players[m.id].role = m.role;
      state.players[m.id].name = m.name;
      const role = ROLES[m.role];
      state.players[m.id].maxHp = role.maxHp;
      state.players[m.id].hp = role.maxHp;
      renderRolePick();
      renderHud();
      break;
    }
    case "start": {
      state.phase = "playing";
      state.world = m.world;
      state.entities = m.entities;
      for (const [id, p] of Object.entries(m.players)) {
        state.players[id] = { ...(state.players[id] || {}), ...p };
      }
      enterGame();
      break;
    }
    case "move": {
      if (state.players[m.id]) {
        state.players[m.id].x = m.x;
        state.players[m.id].y = m.y;
      }
      renderPlayers();
      // Host: check if anyone walked onto an item
      if (state.isHost) hostCheckPickup(m.id);
      break;
    }
    case "attack": {
      if (state.isHost) hostResolveAttack(m.id);
      break;
    }
    case "ability": {
      if (state.isHost) hostResolveAbility(m.id);
      break;
    }
    case "entity-update": {
      state.entities[m.id] = m.entity;
      renderEntities();
      break;
    }
    case "entity-remove": {
      delete state.entities[m.id];
      renderEntities();
      break;
    }
    case "player-hp": {
      if (state.players[m.id]) {
        state.players[m.id].hp = m.hp;
        if (m.x !== undefined) state.players[m.id].x = m.x;
        if (m.y !== undefined) state.players[m.id].y = m.y;
        state.players[m.id].alive = m.hp > 0;
      }
      renderHud();
      renderPlayers();
      if (m.id === state.myId && m.hp <= 0) flashScreen("hurt");
      else if (m.id === state.myId && m.delta < 0) flashScreen("hurt");
      else if (m.id === state.myId && m.delta > 0) flashScreen("heal");
      break;
    }
    case "player-gold": {
      if (state.players[m.id]) state.players[m.id].gold = m.gold;
      renderHud();
      if (m.id === state.myId) toast(`+${m.delta} gold`, "gold");
      break;
    }
    case "win": {
      state.phase = "won";
      show("#screen-end");
      $("#end-title").textContent = "The Pale Lord falls.";
      $("#end-sub").textContent = "The ruin grows silent. The three of you stand victorious.";
      $("#end-stats").innerHTML = endStatsHTML();
      hide("#screen-game");
      break;
    }
    case "lose": {
      state.phase = "lost";
      show("#screen-end");
      $("#end-title").textContent = "The trail claims you.";
      $("#end-sub").textContent = "All three of you fell. The forest goes quiet.";
      $("#end-stats").innerHTML = endStatsHTML();
      hide("#screen-game");
      break;
    }
  }
}

function sendSnapshotTo(toId) {
  send({
    type: "snapshot",
    to: toId,
    players: state.players,
    phase: state.phase,
    world: state.world,
    entities: state.entities,
  });
}

// --- Lobby / role pick ---
function renderRolePick() {
  const container = $("#role-pick");
  container.innerHTML = "";
  for (const [role, info] of Object.entries(ROLES)) {
    const taken = Object.values(state.players).find(p => p.role === role);
    const mine = state.myRole === role;
    const div = document.createElement("div");
    div.className = `role-card ${role}` + (taken && !mine ? " taken" : "") + (mine ? " mine" : "");
    div.innerHTML = `
      <span class="glyph">${info.glyph}</span>
      <div class="name">${info.name}</div>
      <div class="desc">${info.desc}</div>
      <div class="stats">HP ${info.maxHp} · DMG ${info.dmg}</div>
      ${taken ? `<div class="muted-small">${escapeHTML(taken.name)}${mine ? " (you)" : ""}</div>` : ""}
    `;
    if (!taken || mine) div.addEventListener("click", () => pickRole(role));
    container.appendChild(div);
  }
  renderLobbyPlayers();

  const filled = Object.values(state.players).filter(p => p.role).length;
  const sb = $("#start-btn");
  if (filled === 3 && state.isHost) {
    sb.classList.remove("hidden");
    setText("#waiting-host", "");
  } else {
    sb.classList.add("hidden");
    setText("#waiting-host", filled === 3 ? "All roles filled — waiting for host to start…" : `${filled} of 3 chosen…`);
  }
}

function renderLobbyPlayers() {
  const c = $("#lobby-players");
  if (!c) return;
  c.innerHTML = "";
  for (const role of ["scout", "brawler", "mystic"]) {
    const p = Object.values(state.players).find(x => x.role === role);
    const tile = document.createElement("div");
    tile.className = `lobby-tile ${role}`;
    tile.innerHTML = `
      <div class="role-name">${ROLES[role].glyph} ${ROLES[role].name}</div>
      <div class="player-name">${p ? escapeHTML(p.name) : "— empty —"}</div>
    `;
    c.appendChild(tile);
  }
}

function pickRole(role) {
  const taken = Object.values(state.players).find(p => p.role === role);
  if (taken && taken !== state.players[state.myId]) {
    return banner("That role is taken — pick another.", "error");
  }
  state.myRole = role;
  if (!state.players[state.myId]) state.players[state.myId] = { name: state.myName, gold: 0, alive: true };
  state.players[state.myId].role = role;
  state.players[state.myId].name = state.myName;
  state.players[state.myId].maxHp = ROLES[role].maxHp;
  state.players[state.myId].hp = ROLES[role].maxHp;
  send({ type: "role-pick", id: state.myId, name: state.myName, role });
}

function startGame() {
  // Host generates the world
  const seed = Math.floor(Math.random() * 0x7fffffff);
  const w = generateWorld(seed);
  state.world = { W: w.W, H: w.H, tiles: w.tiles, spawns: w.spawns };
  state.entities = w.entities;

  // Assign spawn positions per role
  const order = ["scout", "brawler", "mystic"];
  for (const [id, p] of Object.entries(state.players)) {
    if (!p.role) continue;
    const idx = order.indexOf(p.role);
    const sp = w.spawns[idx] || w.spawns[0];
    p.x = sp.x;
    p.y = sp.y;
    p.hp = ROLES[p.role].maxHp;
    p.maxHp = ROLES[p.role].maxHp;
    p.gold = 0;
    p.alive = true;
  }

  send({ type: "start", world: state.world, entities: state.entities, players: state.players });
}

// --- Game ---
function enterGame() {
  hide("#screen-role");
  hide("#screen-home");
  hide("#screen-end");
  show("#screen-game");
  renderWorld();
  renderEntities();
  renderPlayers();
  renderHud();
  centerOnMe();
  if (state.isHost) startHostLoop();
}

function renderWorld() {
  const w = state.world;
  const board = $("#board");
  board.style.width = (w.W * TILE_PX) + "px";
  board.style.height = (w.H * TILE_PX) + "px";
  const tilesEl = $("#tiles");
  tilesEl.innerHTML = "";
  for (let y = 0; y < w.H; y++) {
    for (let x = 0; x < w.W; x++) {
      const d = document.createElement("div");
      d.className = "tile " + w.tiles[y][x];
      d.style.left = (x * TILE_PX) + "px";
      d.style.top = (y * TILE_PX) + "px";
      tilesEl.appendChild(d);
    }
  }
}

function renderEntities() {
  const layer = $("#entities");
  layer.innerHTML = "";
  for (const [id, e] of Object.entries(state.entities)) {
    const d = document.createElement("div");
    d.className = "entity " + e.type;
    d.style.left = (e.x * TILE_PX) + "px";
    d.style.top = (e.y * TILE_PX) + "px";
    if (e.type === "gold")    d.innerHTML = "<span>$</span>";
    if (e.type === "flower")  d.innerHTML = "<span>✿</span>";
    if (e.type === "chest")   d.innerHTML = "<span>▣</span>";
    if (e.type === "monster") d.innerHTML = `<span>${e.name[0]}</span><div class="hp-bar"><div style="width:${(e.hp/e.maxHp)*100}%"></div></div>`;
    if (e.type === "boss")    { d.classList.add("big"); d.innerHTML = `<span>☠</span><div class="hp-bar boss"><div style="width:${(e.hp/e.maxHp)*100}%"></div></div>`; }
    layer.appendChild(d);
  }
}

function renderPlayers() {
  const layer = $("#players-layer");
  layer.innerHTML = "";
  for (const [id, p] of Object.entries(state.players)) {
    if (!p.role || p.x === undefined) continue;
    const d = document.createElement("div");
    d.className = "player " + p.role + (id === state.myId ? " me" : "") + (p.alive ? "" : " dead");
    d.style.left = (p.x * TILE_PX) + "px";
    d.style.top = (p.y * TILE_PX) + "px";
    d.innerHTML = `<span>${ROLES[p.role].glyph}</span><div class="name">${escapeHTML(p.name)}</div>`;
    layer.appendChild(d);
  }
  centerOnMe();
}

function centerOnMe() {
  const me = state.players[state.myId];
  if (!me || me.x === undefined) return;
  const view = $("#view");
  const targetX = me.x * TILE_PX - view.clientWidth / 2 + TILE_PX / 2;
  const targetY = me.y * TILE_PX - view.clientHeight / 2 + TILE_PX / 2;
  view.scrollTo({ left: targetX, top: targetY, behavior: "smooth" });
}

function renderHud() {
  const hud = $("#hud");
  if (!hud) return;
  hud.innerHTML = "";
  for (const role of ["scout", "brawler", "mystic"]) {
    const p = Object.values(state.players).find(x => x.role === role);
    if (!p) continue;
    const pct = p.maxHp ? Math.max(0, (p.hp / p.maxHp) * 100) : 0;
    const tile = document.createElement("div");
    tile.className = `hud-tile ${role}` + (p.alive ? "" : " dead");
    tile.innerHTML = `
      <div class="role-row">${ROLES[role].glyph} <strong>${escapeHTML(p.name)}</strong> <span class="role-tag">${ROLES[role].name}</span></div>
      <div class="hp-row"><div class="hp-bar"><div style="width:${pct}%"></div></div><span class="hp-num">${p.hp}/${p.maxHp}</span></div>
      <div class="gold-row">★ ${p.gold} gold</div>
    `;
    hud.appendChild(tile);
  }
}

// --- Input ---
function tryMove(dx, dy) {
  const me = state.players[state.myId];
  if (!me || !me.alive) return;
  const now = performance.now();
  const cd = ROLES[state.myRole].moveMs;
  if (now - state.lastMoveAt < cd) return;
  const nx = me.x + dx, ny = me.y + dy;
  if (!isWalkable(state.world, nx, ny)) return;
  // Blocked by monster or boss tile
  const blocker = Object.values(state.entities).find(e =>
    (e.type === "monster" || e.type === "boss") && e.x === nx && e.y === ny);
  if (blocker) return;
  me.x = nx; me.y = ny;
  state.lastMoveAt = now;
  send({ type: "move", id: state.myId, x: nx, y: ny });
  renderPlayers();
}

function tryAttack() {
  const me = state.players[state.myId];
  if (!me || !me.alive) return;
  send({ type: "attack", id: state.myId });
}

function tryAbility() {
  const me = state.players[state.myId];
  if (!me || !me.alive) return;
  if (state.myRole !== "mystic") return;
  const now = performance.now();
  if (now - state.lastAbilityAt < 8000) {
    banner("Ability cooling down…", "info");
    return;
  }
  state.lastAbilityAt = now;
  send({ type: "ability", id: state.myId });
}

// --- Host logic (authoritative) ---
function hostCheckPickup(playerId) {
  const p = state.players[playerId];
  if (!p) return;
  for (const [id, e] of Object.entries(state.entities)) {
    if (e.x !== p.x || e.y !== p.y) continue;
    if (e.type === "gold" || e.type === "chest") {
      const delta = e.value ?? e.gold ?? 0;
      p.gold = (p.gold || 0) + delta;
      send({ type: "player-gold", id: playerId, gold: p.gold, delta });
      delete state.entities[id];
      send({ type: "entity-remove", id });
    } else if (e.type === "flower") {
      const newHp = Math.min(p.maxHp, p.hp + e.heal);
      const delta = newHp - p.hp;
      p.hp = newHp;
      send({ type: "player-hp", id: playerId, hp: newHp, delta });
      delete state.entities[id];
      send({ type: "entity-remove", id });
    }
  }
}

function hostResolveAttack(playerId) {
  const p = state.players[playerId];
  if (!p || !p.alive) return;
  // Find adjacent monster/boss
  let target = null, targetId = null;
  for (const [id, e] of Object.entries(state.entities)) {
    if (e.type !== "monster" && e.type !== "boss") continue;
    if (manhattan(p, e) === 1) { target = e; targetId = id; break; }
  }
  if (!target) return;
  const role = ROLES[p.role];
  target.hp -= role.dmg;
  if (target.hp <= 0) {
    p.gold = (p.gold || 0) + (target.gold || 0);
    send({ type: "player-gold", id: playerId, gold: p.gold, delta: target.gold || 0 });
    delete state.entities[targetId];
    send({ type: "entity-remove", id: targetId });
    if (target.type === "boss") {
      send({ type: "win" });
      state.phase = "won";
    }
  } else {
    state.entities[targetId] = target;
    send({ type: "entity-update", id: targetId, entity: target });
  }
}

function hostResolveAbility(playerId) {
  // Mystic heal pulse: heal all allies within 3 tiles for 12 HP
  const p = state.players[playerId];
  if (!p) return;
  for (const [id, ally] of Object.entries(state.players)) {
    if (!ally.role || !ally.alive) continue;
    if (manhattan(ally, p) <= 3) {
      const newHp = Math.min(ally.maxHp, ally.hp + 12);
      const delta = newHp - ally.hp;
      if (delta > 0) {
        ally.hp = newHp;
        send({ type: "player-hp", id, hp: newHp, delta });
      }
    }
  }
}

function startHostLoop() {
  if (state._loop) return;
  state._loop = setInterval(() => hostTick(), 700);
}

function hostTick() {
  if (state.phase !== "playing") return;
  // Monsters: if a player is adjacent, attack them
  for (const [eid, e] of Object.entries(state.entities)) {
    if (e.type !== "monster" && e.type !== "boss") continue;
    let victim = null, victimId = null;
    for (const [pid, p] of Object.entries(state.players)) {
      if (!p.alive || !p.role) continue;
      if (manhattan(p, e) === 1) { victim = p; victimId = pid; break; }
    }
    if (victim) {
      victim.hp -= e.dmg;
      if (victim.hp <= 0) {
        victim.hp = 0;
        victim.alive = false;
        // Respawn at spawn after 4 seconds
        setTimeout(() => respawn(victimId), 4000);
      }
      send({ type: "player-hp", id: victimId, hp: victim.hp, delta: -e.dmg });
    }
  }
  // Check if all alive players are dead
  const aliveCount = Object.values(state.players).filter(p => p.role && p.alive).length;
  const totalPlayers = Object.values(state.players).filter(p => p.role).length;
  if (totalPlayers >= 1 && aliveCount === 0) {
    // already all dead and respawning; treat as defeat if all 3 dead simultaneously
    // Only trigger lose if no respawn happens — we already schedule respawn, so skip
  }
}

function respawn(playerId) {
  const p = state.players[playerId];
  if (!p) return;
  const order = ["scout", "brawler", "mystic"];
  const sp = state.world.spawns[order.indexOf(p.role)] || state.world.spawns[0];
  p.x = sp.x; p.y = sp.y;
  p.hp = Math.floor(p.maxHp * 0.7);
  p.alive = true;
  send({ type: "player-hp", id: playerId, hp: p.hp, delta: p.hp, x: sp.x, y: sp.y });
}

// --- FX helpers ---
function flashScreen(kind) {
  const f = $("#flash");
  f.className = "flash " + kind;
  setTimeout(() => { f.className = "flash"; }, 250);
}

function toast(text, kind = "info") {
  const t = document.createElement("div");
  t.className = "toast " + kind;
  t.textContent = text;
  $("#toasts").appendChild(t);
  setTimeout(() => t.classList.add("fade"), 1100);
  setTimeout(() => t.remove(), 1700);
}

function endStatsHTML() {
  return Object.values(state.players)
    .filter(p => p.role)
    .sort((a, b) => (b.gold || 0) - (a.gold || 0))
    .map((p, i) => `
      <div class="hud-tile ${p.role}">
        <div class="role-row">${i === 0 ? "★ " : ""}${ROLES[p.role].glyph} <strong>${escapeHTML(p.name)}</strong></div>
        <div class="gold-row">${p.gold || 0} gold</div>
      </div>
    `).join("");
}

// --- Keyboard ---
function setupInput() {
  document.addEventListener("keydown", (e) => {
    if (state.phase !== "playing") return;
    if (state.pressed[e.key]) return;
    state.pressed[e.key] = true;
    const k = e.key.toLowerCase();
    if (k === "w" || k === "arrowup")    tryMove(0, -1);
    else if (k === "s" || k === "arrowdown")  tryMove(0, 1);
    else if (k === "a" || k === "arrowleft")  tryMove(-1, 0);
    else if (k === "d" || k === "arrowright") tryMove(1, 0);
    else if (k === " ") { e.preventDefault(); tryAttack(); }
    else if (k === "e") tryAbility();
  });
  document.addEventListener("keyup", (e) => { state.pressed[e.key] = false; });

  // Hold-to-move
  setInterval(() => {
    if (state.phase !== "playing") return;
    if (state.pressed["w"] || state.pressed["ArrowUp"])    tryMove(0, -1);
    else if (state.pressed["s"] || state.pressed["ArrowDown"])  tryMove(0, 1);
    else if (state.pressed["a"] || state.pressed["ArrowLeft"])  tryMove(-1, 0);
    else if (state.pressed["d"] || state.pressed["ArrowRight"]) tryMove(1, 0);
  }, 60);
}

// --- Wire-up ---
document.addEventListener("DOMContentLoaded", () => {
  $("#host-btn").addEventListener("click", hostRoom);
  $("#join-btn").addEventListener("click", joinRoom);
  $("#start-btn").addEventListener("click", startGame);
  $("#play-again").addEventListener("click", () => location.reload());
  $("#btn-attack").addEventListener("click", tryAttack);
  $("#btn-ability").addEventListener("click", tryAbility);
  setupInput();
});
