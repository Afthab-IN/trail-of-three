// Trail of Three — stage definitions
// Each stage has a scene and 3 action options per role.
// Outcomes combine all 3 player choices for a result.

export const STAGES = [
  {
    id: 1,
    title: "The Misty Crossroads",
    scene: "Fog rolls thick across three diverging paths. A crow watches from a dead oak. Something heavy drags through the underbrush.",
    options: {
      scout: [
        { id: "climb", label: "Climb the oak for a view", risk: 1 },
        { id: "track", label: "Track the dragging sound", risk: 2 },
        { id: "hide", label: "Hide and wait", risk: 0 },
      ],
      brawler: [
        { id: "charge", label: "Charge the noise head-on", risk: 3 },
        { id: "block", label: "Block the path with debris", risk: 1 },
        { id: "ready", label: "Ready weapon, hold ground", risk: 1 },
      ],
      mystic: [
        { id: "veil", label: "Cast a veil of silence", risk: 1 },
        { id: "sense", label: "Reach out with the mind", risk: 2 },
        { id: "ward", label: "Place a ward of warning", risk: 1 },
      ],
    },
    // synergy bonuses when specific combinations are picked
    synergies: [
      { picks: { scout: "climb", mystic: "sense" }, gold: 20, msg: "Scout sees the threat early, Mystic confirms — easy avoid." },
      { picks: { scout: "track", brawler: "charge" }, gold: 30, msg: "Tracked and tackled — a bandit drops a coin pouch." },
      { picks: { brawler: "block", mystic: "ward" }, gold: 15, msg: "The bandit hits your trap and flees." },
    ],
  },
  {
    id: 2,
    title: "Bridge of Glass",
    scene: "A bridge of black glass spans a chasm. Wind howls through cracks. A figure waits at the far side, faceless.",
    options: {
      scout: [
        { id: "rope", label: "Throw a rope across first", risk: 1 },
        { id: "edge", label: "Skirt along the edge below", risk: 3 },
        { id: "test", label: "Test each step ahead of group", risk: 2 },
      ],
      brawler: [
        { id: "shout", label: "Shout a challenge at the figure", risk: 2 },
        { id: "anchor", label: "Anchor the rope for others", risk: 0 },
        { id: "shield", label: "Cross with shield raised", risk: 1 },
      ],
      mystic: [
        { id: "illuminate", label: "Illuminate the bridge", risk: 0 },
        { id: "speak", label: "Speak the figure's true name", risk: 2 },
        { id: "freeze", label: "Freeze the wind", risk: 1 },
      ],
    },
    synergies: [
      { picks: { scout: "rope", brawler: "anchor" }, gold: 25, msg: "Smooth crossing. The figure nods and vanishes." },
      { picks: { mystic: "speak", scout: "test" }, gold: 35, msg: "Named, the figure shatters into coins." },
      { picks: { mystic: "illuminate", brawler: "shield" }, gold: 15, msg: "Light reveals the cracks — careful crossing pays off." },
    ],
  },
  {
    id: 3,
    title: "The Hollow Inn",
    scene: "A warm inn appears where no inn should be. The innkeeper smiles too wide. Three meals are already on the table.",
    options: {
      scout: [
        { id: "check", label: "Check the back rooms", risk: 2 },
        { id: "exits", label: "Map every exit first", risk: 1 },
        { id: "leave", label: "Refuse and leave immediately", risk: 0 },
      ],
      brawler: [
        { id: "eat", label: "Eat — you're starving", risk: 3 },
        { id: "demand", label: "Demand to know who they are", risk: 2 },
        { id: "watch", label: "Watch the innkeeper, hand on weapon", risk: 1 },
      ],
      mystic: [
        { id: "dispel", label: "Dispel any illusion", risk: 1 },
        { id: "bless", label: "Bless the food before tasting", risk: 1 },
        { id: "read", label: "Read the innkeeper's intent", risk: 2 },
      ],
    },
    synergies: [
      { picks: { mystic: "dispel", scout: "check" }, gold: 40, msg: "Illusion drops — the 'inn' is a tomb. You find buried treasure." },
      { picks: { brawler: "watch", mystic: "read" }, gold: 20, msg: "Caught the trick early. The innkeeper begs and pays you off." },
      { picks: { scout: "leave", brawler: "demand" }, gold: 10, msg: "You back out without falling for it." },
    ],
  },
  {
    id: 4,
    title: "Wolfsong Hollow",
    scene: "Three wolves circle in a hollow ringed with bones. They are too quiet. Their eyes are too blue.",
    options: {
      scout: [
        { id: "high", label: "Take the high ground", risk: 1 },
        { id: "flank", label: "Slip around to flank", risk: 2 },
        { id: "signal", label: "Signal the others silently", risk: 0 },
      ],
      brawler: [
        { id: "engage", label: "Engage the lead wolf", risk: 2 },
        { id: "roar", label: "Roar to break their nerve", risk: 1 },
        { id: "back", label: "Back the group toward cover", risk: 1 },
      ],
      mystic: [
        { id: "calm", label: "Calm the pack with song", risk: 1 },
        { id: "fire", label: "Conjure a ring of fire", risk: 2 },
        { id: "shift", label: "Speak as one wolf to another", risk: 3 },
      ],
    },
    synergies: [
      { picks: { mystic: "shift", scout: "signal" }, gold: 45, msg: "The pack accepts you. They leave gifts of bone and silver." },
      { picks: { brawler: "engage", scout: "flank" }, gold: 25, msg: "Pincer move — the pack scatters." },
      { picks: { mystic: "calm", brawler: "back" }, gold: 15, msg: "Tense retreat, but everyone makes it." },
    ],
  },
  {
    id: 5,
    title: "The Drowned Chapel",
    scene: "A chapel half-sunk in a still black lake. Candles burn underwater. Something hums a hymn beneath the surface.",
    options: {
      scout: [
        { id: "dive", label: "Dive for the source of the hum", risk: 3 },
        { id: "shore", label: "Search the shore for relics", risk: 1 },
        { id: "map", label: "Map the chapel's outline", risk: 0 },
      ],
      brawler: [
        { id: "break", label: "Smash a window to enter", risk: 2 },
        { id: "guard", label: "Guard the group from shore", risk: 0 },
        { id: "raft", label: "Build a raft", risk: 1 },
      ],
      mystic: [
        { id: "hymn", label: "Join the hymn", risk: 2 },
        { id: "silence", label: "Silence the chapel", risk: 1 },
        { id: "ask", label: "Ask the lake a question", risk: 2 },
      ],
    },
    synergies: [
      { picks: { mystic: "hymn", scout: "dive" }, gold: 50, msg: "The hymn welcomes you. The lake offers a drowned crown." },
      { picks: { brawler: "raft", scout: "map" }, gold: 25, msg: "A safe, methodical crossing. You loot the altar." },
      { picks: { mystic: "silence", brawler: "guard" }, gold: 15, msg: "The chapel falls quiet and lets you pass." },
    ],
  },
  {
    id: 6,
    title: "Carnival of Faces",
    scene: "A carnival blooms overnight in the dead woods. Masked dancers spin. Each mask is the face of someone you've lost.",
    options: {
      scout: [
        { id: "count", label: "Count the dancers — find the odd one", risk: 1 },
        { id: "tent", label: "Slip into the ringmaster's tent", risk: 2 },
        { id: "ignore", label: "Walk through, eyes on the path", risk: 0 },
      ],
      brawler: [
        { id: "tear", label: "Tear a mask off a dancer", risk: 3 },
        { id: "join", label: "Join the dance to blend in", risk: 1 },
        { id: "wait", label: "Wait at the edge, watchful", risk: 0 },
      ],
      mystic: [
        { id: "name", label: "Name a loved one and refuse", risk: 1 },
        { id: "mirror", label: "Conjure a mirror", risk: 2 },
        { id: "burn", label: "Burn the carnival down", risk: 3 },
      ],
    },
    synergies: [
      { picks: { mystic: "mirror", scout: "count" }, gold: 40, msg: "The mirror reveals the ringmaster. He flees, dropping his purse." },
      { picks: { mystic: "name", brawler: "wait" }, gold: 30, msg: "The carnival can't hold you. The masks weep coins." },
      { picks: { scout: "tent", brawler: "join" }, gold: 25, msg: "Distracted dancers, looted tent." },
    ],
  },
  {
    id: 7,
    title: "The Iron Gate",
    scene: "An iron gate with no wall stands in a field. It is locked. Through it, the field continues — but greener.",
    options: {
      scout: [
        { id: "around", label: "Walk around — it leads nowhere", risk: 2 },
        { id: "pick", label: "Pick the lock", risk: 1 },
        { id: "study", label: "Study the runes on the hinges", risk: 0 },
      ],
      brawler: [
        { id: "force", label: "Force the gate open", risk: 3 },
        { id: "climb", label: "Climb over", risk: 2 },
        { id: "key", label: "Search the field for a key", risk: 1 },
      ],
      mystic: [
        { id: "ask", label: "Ask the gate for passage", risk: 1 },
        { id: "shrink", label: "Shrink and slip through", risk: 2 },
        { id: "unbind", label: "Unbind the rune-lock", risk: 1 },
      ],
    },
    synergies: [
      { picks: { mystic: "unbind", scout: "study" }, gold: 50, msg: "The gate opens with a sigh. On the other side: a pile of old coin." },
      { picks: { scout: "pick", brawler: "key" }, gold: 30, msg: "The found key fits. The gate respects you." },
      { picks: { mystic: "ask", brawler: "climb" }, gold: 15, msg: "The gate lets you climb without resistance." },
    ],
  },
  {
    id: 8,
    title: "Choir of Stones",
    scene: "Standing stones sing in a circle. The song is mostly beautiful. One stone is silent. One stone is screaming.",
    options: {
      scout: [
        { id: "silent", label: "Inspect the silent stone", risk: 2 },
        { id: "scream", label: "Inspect the screaming stone", risk: 3 },
        { id: "center", label: "Stand at the center", risk: 1 },
      ],
      brawler: [
        { id: "guard", label: "Guard the perimeter", risk: 0 },
        { id: "strike", label: "Strike the screaming stone", risk: 3 },
        { id: "carry", label: "Try to lift the silent stone", risk: 2 },
      ],
      mystic: [
        { id: "harmony", label: "Sing the missing harmony", risk: 1 },
        { id: "quiet", label: "Quiet the screaming one", risk: 2 },
        { id: "listen", label: "Listen for the true song", risk: 1 },
      ],
    },
    synergies: [
      { picks: { mystic: "harmony", scout: "center" }, gold: 55, msg: "The choir completes itself. A reward of starsilver appears." },
      { picks: { mystic: "quiet", scout: "scream" }, gold: 30, msg: "The screaming stone gives up a hidden gem." },
      { picks: { brawler: "carry", mystic: "listen" }, gold: 20, msg: "Beneath the silent stone — a small hoard." },
    ],
  },
  {
    id: 9,
    title: "The Pale Rider",
    scene: "A rider on a pale horse blocks the trail. They offer a wager: one of you must answer a riddle, or pay in gold.",
    options: {
      scout: [
        { id: "watch", label: "Watch for a trick — they always cheat", risk: 1 },
        { id: "around", label: "Try to sneak around in the trees", risk: 2 },
        { id: "accept", label: "Accept on the group's behalf", risk: 2 },
      ],
      brawler: [
        { id: "fight", label: "Challenge them instead", risk: 3 },
        { id: "stall", label: "Stall while others act", risk: 1 },
        { id: "pay", label: "Just pay and move on", risk: 0 },
      ],
      mystic: [
        { id: "answer", label: "Answer the riddle", risk: 2 },
        { id: "riddle", label: "Counter with your own riddle", risk: 1 },
        { id: "see", label: "See through the rider", risk: 2 },
      ],
    },
    synergies: [
      { picks: { mystic: "answer", scout: "watch" }, gold: 60, msg: "Right answer, no trick. The rider pays YOU and leaves." },
      { picks: { mystic: "riddle", brawler: "stall" }, gold: 35, msg: "Rider can't answer. They forfeit a satchel of gold." },
      { picks: { mystic: "see", scout: "accept" }, gold: 25, msg: "You see the rider is bluffing. They flee." },
    ],
  },
  {
    id: 10,
    title: "The Edge of the Trail",
    scene: "The trail ends at a cliff over a sea of clouds. A bridge of light is forming, but only if all three of you step forward together.",
    options: {
      scout: [
        { id: "step", label: "Step forward, trusting", risk: 1 },
        { id: "scan", label: "Scan for one last danger", risk: 1 },
        { id: "lead", label: "Lead the group across", risk: 1 },
      ],
      brawler: [
        { id: "step", label: "Step forward, trusting", risk: 1 },
        { id: "carry", label: "Be ready to carry someone", risk: 0 },
        { id: "vow", label: "Make a vow of protection", risk: 0 },
      ],
      mystic: [
        { id: "step", label: "Step forward, trusting", risk: 1 },
        { id: "bless", label: "Bless the bridge", risk: 0 },
        { id: "song", label: "Sing the bridge stronger", risk: 0 },
      ],
    },
    synergies: [
      { picks: { scout: "step", brawler: "step", mystic: "step" }, gold: 100, msg: "All three of you step as one. The bridge holds. You make it." },
      { picks: { scout: "lead", brawler: "vow", mystic: "song" }, gold: 80, msg: "The bridge sings with you. A safe, glorious crossing." },
      { picks: { scout: "scan", brawler: "carry", mystic: "bless" }, gold: 60, msg: "Careful, blessed, prepared — you cross together." },
    ],
  },
];
