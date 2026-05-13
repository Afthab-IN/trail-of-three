// Minimal Supabase Realtime wrapper for the game.
// Solo mode: send() dispatches locally; no network.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export class Net {
  constructor() {
    this.supabase = null;
    this.channel = null;
    this.solo = false;
    this.myId = crypto.randomUUID();
    this.onMessage = () => {};
    this.onPresenceChange = () => {};
  }

  initSolo() {
    this.solo = true;
  }

  async joinRoom(code) {
    if (SUPABASE_URL.includes("PASTE_") || SUPABASE_ANON_KEY.includes("PASTE_")) {
      throw new Error("Supabase config missing — edit config.js");
    }
    this.supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const channel = this.supabase.channel(`vale:${code}`, {
      config: { broadcast: { self: true }, presence: { key: this.myId } },
    });

    channel.on("broadcast", { event: "msg" }, ({ payload }) => this.onMessage(payload));
    channel.on("presence", { event: "sync" }, () => {
      const ps = channel.presenceState();
      const present = new Set();
      for (const arr of Object.values(ps)) for (const p of arr) present.add(p.id);
      this.onPresenceChange(present);
    });

    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("Channel subscribe timeout")), 10000);
      channel.subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          clearTimeout(t);
          await channel.track({ id: this.myId });
          res();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          clearTimeout(t);
          rej(new Error("Channel failed: " + status));
        }
      });
    });

    this.channel = channel;
  }

  send(payload) {
    payload.from = this.myId;
    if (this.solo) {
      // Dispatch locally on next tick
      setTimeout(() => this.onMessage(payload), 0);
      return;
    }
    if (this.channel) {
      this.channel.send({ type: "broadcast", event: "msg", payload });
    }
  }
}

export function makeRoomCode() {
  const chars = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
  let c = "";
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}
