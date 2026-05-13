# Trail of Three

A 3-player co-op adventure game. One Scout, one Brawler, one Mystic — travel 10 stages of a haunted trail, pick actions simultaneously each stage, and synergies between roles unlock the biggest gold rewards.

## How to play

1. Host clicks **Host a new trail** and shares the 6-char room code.
2. The other two players enter the code and click **Join**.
3. Each player picks a unique role (Scout / Brawler / Mystic).
4. Host clicks **Begin the trail**.
5. At each stage, each player picks one of three actions. When all three lock in, the outcome resolves.
6. After 10 stages, gold is totaled and a winner is crowned.

## Stack

- Vanilla HTML + JS (no build step)
- Supabase Realtime broadcast channels (no DB tables needed)
- Deployed as static on Vercel

## Local dev

Open `index.html` in three browser windows. Or serve with:

```
npx serve .
```
