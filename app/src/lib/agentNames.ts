const CLAUDE_NAMES = [
  // One Piece
  "Luffy", "Zoro", "Nami", "Usopp", "Sanji", "Chopper", "Robin", "Franky",
  "Brook", "Jinbe", "Shanks", "Ace", "Sabo", "Law", "Hancock", "Coby",
  "Smoker", "Crocodile", "Doflamingo", "Katakuri",
  // Bleach
  "Ichigo", "Rukia", "Orihime", "Chad", "Uryū", "Renji", "Byakuya",
  "Tōshirō", "Rangiku", "Yoruichi", "Kisuke", "Sōsuke", "Grimmjow",
  "Ulquiorra", "Nelliel", "Kenpachi", "Mayuri", "Shinji", "Gin", "Retsu",
];

const CODEX_NAMES = [
  // The Office
  "Michael", "Dwight", "Jim", "Pam", "Ryan", "Andy", "Angela", "Kevin",
  "Oscar", "Stanley", "Phyllis", "Meredith", "Creed", "Toby", "Kelly",
  "Darryl", "Roy", "Jan", "Holly", "Gabe", "Robert", "Nellie", "Erin",
];

const COPILOT_NAMES = [
  // Naruto
  "Naruto", "Sasuke", "Sakura", "Kakashi", "Rock Lee", "Neji", "TenTen",
  "Gaara", "Shikamaru", "Choji", "Ino", "Hinata", "Kiba", "Shino",
  "Itachi", "Jiraiya", "Tsunade", "Orochimaru", "Minato", "Obito",
  "Madara", "Nagato", "Konan", "Might Guy", "Asuma", "Kurenai",
];

function pick(pool: string[]): string {
  return pool[Math.floor(Math.random() * pool.length)];
}

export function pickAgentName(agentId?: string): string {
  if (agentId === "codex") return pick(CODEX_NAMES);
  if (agentId === "copilot") return pick(COPILOT_NAMES);
  return pick(CLAUDE_NAMES);
}
