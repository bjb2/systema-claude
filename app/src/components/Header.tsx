import { Theme, ViewKey } from "../themes";

interface Props {
  theme: Theme;
  view: ViewKey;
  orgRoot: string;
}

export default function Header({ theme, view, orgRoot }: Props) {
  const shortRoot = orgRoot.replace(/\\/g, "/").split("/").slice(-2).join("/");
  return (
    <header
      className="flex items-center justify-between px-4 py-2 border-b text-sm flex-shrink-0"
      style={{ background: theme.bgSecondary, borderColor: theme.border }}
    >
      <div className="flex items-center gap-3">
        <span className="font-bold tracking-wider" style={{ color: theme.accent }}>
          ORG
        </span>
        <span style={{ color: theme.textDim }}>›</span>
        <span style={{ color: theme.textMuted }}>{view}</span>
      </div>
      <div className="text-xs" style={{ color: theme.textDim }}>
        {shortRoot}
      </div>
    </header>
  );
}
