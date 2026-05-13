// Story beats for The Lantern Path.
// Each beat has a trigger position. Walking near it + pressing E opens the dialogue.
// Choices update story.flags. The final beat reads flags to pick an ending.

export const STORY_BEATS = [
  {
    id: "opening",
    triggerAt: { x: 0, z: -8 },
    triggerRadius: 4,
    npc: { type: "storyteller", x: 0, z: -10, color: 0xc08a3e },
    lines: [
      { who: "The Storyteller", text: "You wake on a path you don't remember walking onto." },
      { who: "The Storyteller", text: "These trees have seen things. They do not blink." },
      { who: "The Storyteller", text: "Before you go, choose what you'll carry through the dark." },
    ],
    choices: [
      { label: "Carry CAUTION — eyes open, hand on hilt.", flags: { caution: 1 } },
      { label: "Carry COURAGE — straight back, no flinching.", flags: { courage: 1 } },
      { label: "Carry CURIOSITY — questions before answers.", flags: { curiosity: 1 } },
    ],
  },
  {
    id: "wounded",
    triggerAt: { x: 3, z: -32 },
    triggerRadius: 5,
    npc: { type: "wounded", x: 4, z: -33, color: 0xc45c5c },
    lines: [
      { who: "Wounded Woman", text: "Wait — please. I'm not what's chasing me, I swear it." },
      { who: "Wounded Woman", text: "There's something on this road. It takes the slow ones." },
    ],
    choices: [
      { label: "Help her up. Walk with her.", flags: { trust: 1, slowed: 1 } },
      { label: "Ask what's hunting her.", flags: { curiosity: 1 }, followup: [
        { who: "Wounded Woman", text: "A figure with a lantern that gives no light. It calls you by name." },
      ]},
      { label: "Step around her. You have your own road.", flags: { caution: 1, trust: -1 } },
      { label: "Take her lantern. She won't reach the end anyway.", flags: { shadow: 1, trust: -2 } },
    ],
  },
  {
    id: "fork",
    triggerAt: { x: 0, z: -65 },
    triggerRadius: 4,
    npc: { type: "child", x: 0, z: -67, color: 0x6ec79b },
    lines: [
      { who: "A small child", text: "The path splits ahead. Both lead somewhere." },
      { who: "A small child", text: "The left goes to the Watchtower. The right goes to the Silent Door." },
      { who: "A small child", text: "I would not choose either, if I were you. But I am only six." },
    ],
    choices: [
      { label: "Take the LEFT path — toward the Watchtower.", flags: { path: "watchtower" } },
      { label: "Take the RIGHT path — toward the Silent Door.", flags: { path: "silent" } },
      { label: "Sit with the child a moment first.", flags: { trust: 1 }, followup: [
        { who: "A small child", text: "Thank you. No one ever sits." },
        { who: "A small child", text: "There's a thing about the lanterns — they only light for those who carry something true." },
      ]},
    ],
  },
  {
    id: "ending",
    triggerAt: { x: 0, z: -110 },
    triggerRadius: 5,
    npc: { type: "tower", x: 0, z: -115, color: 0xd4a259 },
    // Resolved by computeEnding(flags); lines are picked there.
    final: true,
  },
];

export function computeEnding(flags) {
  const f = flags || {};
  // The Pale Lantern — bad ending if you took the wounded woman's lantern AND chose caution/silent
  if ((f.shadow || 0) >= 1 && f.path === "silent") {
    return {
      title: "The Pale Lantern",
      lines: [
        "You reach the Silent Door with two lanterns burning.",
        "Neither of them is yours.",
        "When the door opens, only the lanterns walk through.",
      ],
      tone: "shadow",
    };
  }
  if ((f.shadow || 0) >= 1) {
    return {
      title: "What You Took",
      lines: [
        "You make it to the end, but the lantern you stole goes out at the threshold.",
        "She would have made it. You did not give her the chance.",
        "The dark beyond is patient. It will wait for you to come back.",
      ],
      tone: "shadow",
    };
  }
  // Hero: trust + courage + watchtower
  if ((f.trust || 0) >= 1 && (f.courage || 0) >= 1 && f.path === "watchtower") {
    return {
      title: "The Watchtower Lit",
      lines: [
        "You climb the tower steps with the woman beside you.",
        "At the top, you set your lantern in the stone cradle. It catches, then catches the next, and the next.",
        "Below, the forest fills with quiet light. Somewhere, a child sleeps for the first time in years.",
      ],
      tone: "hero",
    };
  }
  // Wanderer: caution + silent door
  if ((f.caution || 0) >= 1 && f.path === "silent") {
    return {
      title: "The Silent Door",
      lines: [
        "The door has no handle. You sit before it until the night thins to grey.",
        "It does not open. It does not need to.",
        "You walk back the way you came, carrying a small new thing — the knowing of where the door is.",
      ],
      tone: "wanderer",
    };
  }
  // Curious: curiosity + watchtower OR met fork-with-child
  if ((f.curiosity || 0) >= 1 && f.path === "watchtower") {
    return {
      title: "The Tower's Question",
      lines: [
        "The Watchtower is empty when you climb it.",
        "On the stone cradle, a single word is carved: WHY.",
        "You leave your lantern lit, sit down beside it, and begin to think.",
      ],
      tone: "curious",
    };
  }
  // Default: the long walk
  return {
    title: "The Long Walk Out",
    lines: [
      "You reach the end of the path without ceremony.",
      "The forest releases you the way it received you — without comment.",
      "Some night you'll dream of the woman, the child, and a lantern you never carried.",
    ],
    tone: "neutral",
  };
}
