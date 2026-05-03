import { useEffect, useState } from "react";

export const WORKING_KAOMOJI = [
  "ヽ༼ຈل͜ຈ༽ﾉ",
  "(ﾉ◕ヮ◕)ﾉ",
  "(ง •̀_•́)ง",
  "(•̀ᴗ•́)و",
  "ᕦ(ò_óˇ)ᕤ",
  "(╯°□°）╯",
  "٩(˘◡˘)۶",
  "(ง'̀-'́)ง",
  "＼(◎o◎)／",
  "(づ｡◕‿‿◕｡)づ",
];

export const AGENT_STYLE = `
@keyframes agentPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: 0.4; transform: scale(0.6); }
}
@keyframes agentRing {
  0%   { transform: scale(0.8); opacity: 0.8; }
  100% { transform: scale(2.2); opacity: 0; }
}
`;

export function useAgentKaomoji(active: boolean, intervalMs = 2800): string {
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * WORKING_KAOMOJI.length));
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setIdx(i => (i + 1) % WORKING_KAOMOJI.length), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs]);
  return WORKING_KAOMOJI[idx];
}
