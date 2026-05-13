import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { STAGES } from "./stages.js";

const ROLES = {
  scout:   { name: "Scout",   glyph: "◈", desc: "Sees ahead. Avoids danger." },
  brawler: { name: "Brawler", glyph: "✦", desc: "Stands ground. Hits hard." },
  mystic:  { name: "Mystic",  glyph: "✧", desc: "Bends fate. Reads signs." },
};

// --- State ---
const state = {
  supabase: null,
  channel: null,
  roomCode: null,
  myId: crypto.randomUUID(),
  myName: "",
  myRole: null,
  isHost: false,
  players: {},          // { id: { name, role, gold, lockedIn, choice } }
  phase: "lobby",       // lobby | role | playing | outcome | done
  stageIndex: 0,
  currentChoices: {},   // { role: optionId } — set when player locks in
  lastOutcome: null,
};

// --- DOM helpers ---
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
function show(id) { $(id).classList.remove("hidden"); }
function hide(id) { $(id).classList.add("hidden"); }
function setText(sel, txt) { $(sel).textContent = txt; }

// --- Supabase init ---
function initSupabase() {
  if (SUPABASE_URL.includes("PASTE_") || SUPABASE_ANON_KEY.includes("PASTE_")) {
    showBanner("Edit config.js with your Supabase URL and anon key first.", "error");
    return false;
  }
  state.supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return true;
}

function showBanner(msg, kind = "info") {
  const b = $("#banner");
  b.textContent = msg;
  b.className = "banner" + (kind === "info" ? " info" : "");
  b.classList.remove("hidden");
  setTimeout(() => b.classList.add("hidden"), 5000);
}

// --- Room code ---
function makeRoomCode() {
  const chars = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
  let c = "";
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

// --- Join / Host ---
async function hostRoom() {
  const name = $("#name").value.trim();
  if (!name) return showBanner("Enter your name first.");
  if (!initSupabase()) return;
  state.myName = name;
  state.roomCode = makeRoomCode();
  state.isHost = true;
  await connectChannel();
  goToRolePick();
}

async function joinRoom() {
  const name = $("#name").value.trim();
  const code = $("#room-code-input").value.trim().toUpperCase();
  if (!name) return showBanner("Enter your name first.");
  if (!code || code.length !== 6) return showBanner("Enter a 6-char room code.");
  if (!initSupabase()) return;
  state.myName = name;
  state.roomCode = code;
  state.isHost = false;
  await connectChannel();
  goToRolePick();
}

async function connectChannel() {
  const channel = state.supabase.channel(`trail:${state.roomCode}`, {
    config: { broadcast: { self: true }, presence: { key: state.myId } },
  });

  channel.on("broadcast", { event: "msg" }, ({ payload }) => handleMessage(payload));

  channel.on("presence", { event: "sync" }, () => {
    const presenceState = channel.presenceState();
    // Clean up players who left
    const presentIds = new Set();
    for (const ids of Object.values(presenceState)) {
      for (const p of ids) presentIds.add(p.id);
    }
    let changed = false;
    for (const id of Object.keys(state.players)) {
      if (!presentIds.has(id)) { delete state.players[id]; changed = true; }
    }
    if (changed) renderAll();
  });

  await new Promise((resolve) => {
    channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await channel.track({ id: state.myId, name: state.myName });
        resolve();
      }
    });
  });

  state.channel = channel;

  // Announce self
  send({ type: "hello", id: state.myId, name: state.myName });
  // Ask anyone for current state (so late joiners can catch up)
  send({ type: "request-state", id: state.myId });
}

function send(payload) {
  state.channel.send({ type: "broadcast", event: "msg", payload });
}

// --- Message handling ---
function handleMessage(msg) {
  if (msg.from && msg.from === state.myId) {
    // Ignore my own broadcasts that loop back, EXCEPT for outcomes I authored as host
    // (we set self:true so host can render its own outcome too — handled below)
  }

  switch (msg.type) {
    case "hello": {
      if (!state.players[msg.id]) {
        state.players[msg.id] = { name: msg.name, role: null, gold: 0, lockedIn: false, choice: null };
      } else {
        state.players[msg.id].name = msg.name;
      }
      renderAll();
      // If we are host, send current state to the newcomer
      if (state.isHost && msg.id !== state.myId) {
        send({
          type: "state-snapshot",
          to: msg.id,
          players: state.players,
          phase: state.phase,
          stageIndex: state.stageIndex,
          currentChoices: state.currentChoices,
        });
      }
      break;
    }
    case "request-state": {
      if (state.isHost && msg.id !== state.myId) {
        send({
          type: "state-snapshot",
          to: msg.id,
          players: state.players,
          phase: state.phase,
          stageIndex: state.stageIndex,
          currentChoices: state.currentChoices,
        });
      }
      break;
    }
    case "state-snapshot": {
      if (msg.to !== state.myId) return;
      // Merge in players we don't know about
      for (const [id, p] of Object.entries(msg.players)) {
        state.players[id] = { ...state.players[id], ...p };
      }
      state.phase = msg.phase;
      state.stageIndex = msg.stageIndex;
      state.currentChoices = msg.currentChoices || {};
      renderAll();
      if (state.phase === "playing") renderStage();
      break;
    }
    case "role-pick": {
      if (!state.players[msg.id]) state.players[msg.id] = { name: msg.name, gold: 0, lockedIn: false };
      state.players[msg.id].role = msg.role;
      state.players[msg.id].name = msg.name;
      renderAll();
      break;
    }
    case "start-game": {
      state.phase = "playing";
      state.stageIndex = 0;
      state.currentChoices = {};
      for (const p of Object.values(state.players)) { p.lockedIn = false; p.choice = null; }
      renderAll();
      renderStage();
      break;
    }
    case "lock-choice": {
      if (state.players[msg.id]) {
        state.players[msg.id].lockedIn = true;
        state.players[msg.id].choice = msg.choice;
      }
      if (msg.role) state.currentChoices[msg.role] = msg.choice;
      renderAll();

      // Host: check if all roles have locked in
      if (state.isHost) {
        const filledRoles = Object.values(state.players).filter(p => p.role).map(p => p.role);
        const allLocked = filledRoles.every(r => state.currentChoices[r]);
        if (filledRoles.length === 3 && allLocked) {
          resolveStage();
        }
      }
      break;
    }
    case "outcome": {
      state.phase = "outcome";
      state.lastOutcome = msg.outcome;
      // Apply gold
      for (const p of Object.values(state.players)) {
        p.gold = (p.gold || 0) + (msg.outcome.goldPerPlayer || 0);
      }
      renderAll();
      renderOutcome();
      break;
    }
    case "next-stage": {
      state.stageIndex = msg.stageIndex;
      state.currentChoices = {};
      state.lastOutcome = null;
      for (const p of Object.values(state.players)) { p.lockedIn = false; p.choice = null; }
      if (state.stageIndex >= STAGES.length) {
        state.phase = "done";
        renderAll();
        renderEnd();
      } else {
        state.phase = "playing";
        renderAll();
        renderStage();
      }
      break;
    }
  }
}

// --- Phase transitions ---
function goToRolePick() {
  hide("#screen-home");
  show("#screen-role");
  setText("#room-code-display", state.roomCode);
  renderRolePick();
}

function pickRole(role) {
  // Make sure no one else has it
  const taken = Object.values(state.players).find(p => p.role === role && p !== state.players[state.myId]);
  if (taken) return showBanner("That role is taken — pick another.");
  state.myRole = role;
  if (!state.players[state.myId]) state.players[state.myId] = { name: state.myName, gold: 0, lockedIn: false };
  state.players[state.myId].role = role;
  state.players[state.myId].name = state.myName;
  send({ type: "role-pick", id: state.myId, name: state.myName, role });
  renderRolePick();
  checkStartReady();
}

function checkStartReady() {
  const filled = Object.values(state.players).filter(p => p.role).length;
  const startBtn = $("#start-btn");
  if (filled === 3 && state.isHost) {
    startBtn.classList.remove("hidden");
    startBtn.disabled = false;
  } else {
    startBtn.classList.add("hidden");
  }
  if (filled === 3 && !state.isHost) {
    setText("#waiting-host", "All 3 roles picked — waiting for host to start…");
  } else {
    setText("#waiting-host", "");
  }
}

function startGame() {
  send({ type: "start-game" });
}

// --- Stage resolution ---
function lockChoice(optionId) {
  if (state.players[state.myId]?.lockedIn) return;
  state.players[state.myId].lockedIn = true;
  state.players[state.myId].choice = optionId;
  state.currentChoices[state.myRole] = optionId;
  send({ type: "lock-choice", id: state.myId, role: state.myRole, choice: optionId });
  renderStage();
}

function resolveStage() {
  const stage = STAGES[state.stageIndex];
  const picks = { ...state.currentChoices };
  let bestMatch = null;
  let bestScore = -1;

  for (const syn of (stage.synergies || [])) {
    let score = 0;
    let match = true;
    for (const [role, opt] of Object.entries(syn.picks)) {
      if (picks[role] === opt) score++;
      else { match = false; break; }
    }
    if (match && score > bestScore) {
      bestScore = score;
      bestMatch = syn;
    }
  }

  let gold = 0;
  let msg = "";
  if (bestMatch) {
    gold = bestMatch.gold;
    msg = bestMatch.msg;
  } else {
    // No synergy — base reward by avg risk
    const risks = Object.entries(picks).map(([role, optId]) => {
      const opt = (stage.options[role] || []).find(o => o.id === optId);
      return opt?.risk ?? 1;
    });
    const avgRisk = risks.reduce((a, b) => a + b, 0) / Math.max(risks.length, 1);
    gold = Math.max(0, Math.round(10 - avgRisk * 2));
    msg = avgRisk >= 2.5
      ? "You stumble through. Costly lesson, little reward."
      : "You make it through. A modest find on the way.";
  }

  const goldPerPlayer = Math.round(gold / 3);
  const outcome = { stageId: stage.id, picks, gold, goldPerPlayer, msg };
  send({ type: "outcome", outcome });
}

function nextStage() {
  send({ type: "next-stage", stageIndex: state.stageIndex + 1 });
}

// --- Rendering ---
function renderAll() {
  renderPlayers();
  checkStartReady();
}

function renderPlayers() {
  const container = $("#players");
  if (!container) return;
  container.innerHTML = "";
  // Show 3 slots ordered by role
  const byRole = { scout: null, brawler: null, mystic: null };
  for (const [id, p] of Object.entries(state.players)) {
    if (p.role) byRole[p.role] = { id, ...p };
  }
  for (const role of ["scout", "brawler", "mystic"]) {
    const p = byRole[role];
    const tile = document.createElement("div");
    tile.className = `player-tile ${role}` + (p?.lockedIn ? " locked-in" : "");
    tile.innerHTML = `
      <div class="role-name">${ROLES[role].glyph} ${ROLES[role].name}</div>
      <div class="player-name">${p ? escapeHTML(p.name) : "— empty —"}</div>
      <div class="gold">${p ? `${p.gold || 0} gold` : ""}</div>
    `;
    container.appendChild(tile);
  }
}

function renderRolePick() {
  const container = $("#role-pick");
  container.innerHTML = "";
  for (const [role, info] of Object.entries(ROLES)) {
    const taken = Object.values(state.players).find(p => p.role === role);
    const isMine = state.myRole === role;
    const div = document.createElement("div");
    div.className = `role-card ${role}` + (taken && !isMine ? " taken" : "");
    div.innerHTML = `
      <span class="glyph">${info.glyph}</span>
      <div class="name">${info.name}</div>
      <div class="desc">${info.desc}</div>
      ${taken ? `<div class="muted" style="margin-top:8px;">${escapeHTML(taken.name)}${isMine ? " (you)" : ""}</div>` : ""}
    `;
    if (!taken || isMine) div.addEventListener("click", () => pickRole(role));
    container.appendChild(div);
  }
  renderPlayers();
}

function renderStage() {
  hide("#screen-role");
  hide("#screen-outcome");
  hide("#screen-end");
  show("#screen-stage");
  const stage = STAGES[state.stageIndex];
  setText("#stage-num", `Stage ${state.stageIndex + 1} of ${STAGES.length}`);
  setText("#stage-title", stage.title);
  setText("#scene", stage.scene);

  const opts = stage.options[state.myRole] || [];
  const me = state.players[state.myId];
  const locked = me?.lockedIn;
  const container = $("#options");
  container.innerHTML = "";
  for (const opt of opts) {
    const btn = document.createElement("button");
    btn.className = "option" + (me?.choice === opt.id ? " picked" : "") + (locked ? " locked" : "");
    btn.disabled = locked;
    btn.innerHTML = `<strong>${escapeHTML(opt.label)}</strong>`;
    btn.addEventListener("click", () => lockChoice(opt.id));
    container.appendChild(btn);
  }

  // Status line
  const filledRoles = Object.values(state.players).filter(p => p.role);
  const lockedCount = filledRoles.filter(p => p.lockedIn).length;
  setText("#stage-status", `${lockedCount} of ${filledRoles.length} locked in${locked ? " — waiting on others…" : ""}`);
  renderPlayers();
}

function renderOutcome() {
  hide("#screen-stage");
  show("#screen-outcome");
  const o = state.lastOutcome;
  const stage = STAGES[state.stageIndex];
  setText("#outcome-stage", `${stage.title} — Stage ${state.stageIndex + 1}`);
  setText("#outcome-gold", `+${o.gold} gold (${o.goldPerPlayer} each)`);
  setText("#outcome-msg", o.msg);

  // Choice summary
  const summary = $("#choice-summary");
  summary.innerHTML = "";
  for (const role of ["scout", "brawler", "mystic"]) {
    const optId = o.picks[role];
    const opt = (stage.options[role] || []).find(x => x.id === optId);
    const div = document.createElement("div");
    div.className = "pick";
    div.innerHTML = `
      <div class="who">${ROLES[role].glyph} ${ROLES[role].name}</div>
      <div>${opt ? escapeHTML(opt.label) : "(no choice)"}</div>
    `;
    summary.appendChild(div);
  }

  const nextBtn = $("#next-btn");
  if (state.isHost) {
    nextBtn.classList.remove("hidden");
    nextBtn.textContent = state.stageIndex + 1 >= STAGES.length ? "See the End" : "Continue Trail →";
  } else {
    nextBtn.classList.add("hidden");
  }
  renderPlayers();
}

function renderEnd() {
  hide("#screen-stage");
  hide("#screen-outcome");
  show("#screen-end");
  const players = Object.values(state.players).filter(p => p.role).sort((a, b) => (b.gold || 0) - (a.gold || 0));
  const total = players.reduce((a, p) => a + (p.gold || 0), 0);
  setText("#end-total", `${total} gold`);
  const list = $("#end-list");
  list.innerHTML = "";
  players.forEach((p, i) => {
    const div = document.createElement("div");
    div.className = "player-tile " + p.role;
    div.innerHTML = `
      <div class="role-name">${i === 0 ? "★ " : ""}${ROLES[p.role].glyph} ${ROLES[p.role].name}</div>
      <div class="player-name">${escapeHTML(p.name)}</div>
      <div class="gold">${p.gold || 0} gold</div>
    `;
    list.appendChild(div);
  });
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// --- Wire up ---
document.addEventListener("DOMContentLoaded", () => {
  $("#host-btn").addEventListener("click", hostRoom);
  $("#join-btn").addEventListener("click", joinRoom);
  $("#start-btn").addEventListener("click", startGame);
  $("#next-btn").addEventListener("click", nextStage);
  $("#play-again").addEventListener("click", () => location.reload());
});
