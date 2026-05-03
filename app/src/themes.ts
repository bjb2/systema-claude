export interface Theme {
  name: string;
  bg: string;
  bgSecondary: string;
  bgTertiary: string;
  border: string;
  text: string;
  textMuted: string;
  textDim: string;
  accent: string;
  accentMuted: string;
  success: string;
  warning: string;
  error: string;
}

export const themes: Theme[] = [
  {
    name: "void",
    bg: "#0a0a0f",
    bgSecondary: "#12121a",
    bgTertiary: "#1a1a24",
    border: "#2a2a3a",
    text: "#e2e2f0",
    textMuted: "#8888aa",
    textDim: "#444466",
    accent: "#7c6af5",
    accentMuted: "#3d3578",
    success: "#4af076",
    warning: "#f0c44a",
    error: "#f05a4a",
  },
  {
    name: "forest",
    bg: "#0a0f0a",
    bgSecondary: "#121a12",
    bgTertiary: "#1a241a",
    border: "#2a3a2a",
    text: "#e2f0e2",
    textMuted: "#88aa88",
    textDim: "#446644",
    accent: "#4af076",
    accentMuted: "#1a5c2a",
    success: "#7cf094",
    warning: "#f0c44a",
    error: "#f05a4a",
  },
  {
    name: "amber",
    bg: "#0f0c00",
    bgSecondary: "#1a1400",
    bgTertiary: "#241c00",
    border: "#3a2e00",
    text: "#f0e2a0",
    textMuted: "#aa9944",
    textDim: "#665522",
    accent: "#f0c44a",
    accentMuted: "#7a5c00",
    success: "#4af076",
    warning: "#f07a4a",
    error: "#f05a4a",
  },
  {
    name: "arctic",
    bg: "#050d14",
    bgSecondary: "#0a1520",
    bgTertiary: "#101e2c",
    border: "#1a2e40",
    text: "#c8e8f8",
    textMuted: "#6090b0",
    textDim: "#2a4a60",
    accent: "#4ac8f0",
    accentMuted: "#0a4060",
    success: "#4af076",
    warning: "#f0c44a",
    error: "#f05a4a",
  },
  {
    name: "rose",
    bg: "#0f080a",
    bgSecondary: "#1a1012",
    bgTertiary: "#24181a",
    border: "#3a2028",
    text: "#f0d8e0",
    textMuted: "#b07888",
    textDim: "#663344",
    accent: "#f04878",
    accentMuted: "#701030",
    success: "#4af076",
    warning: "#f0c44a",
    error: "#f07040",
  },
  {
    name: "matrix",
    bg: "#000800",
    bgSecondary: "#001200",
    bgTertiary: "#001a00",
    border: "#003a00",
    text: "#00f040",
    textMuted: "#008820",
    textDim: "#004410",
    accent: "#00f040",
    accentMuted: "#004010",
    success: "#00f040",
    warning: "#f0f040",
    error: "#f04000",
  },
];

export type ViewKey = "dashboard" | "tasks" | "knowledge" | "inbox" | "graph" | "code" | "swarm" | "settings" | "routines";
