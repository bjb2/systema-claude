import { Theme } from "../themes";
import { OrgDocument } from "../types";

export interface ViewProps {
  docs: OrgDocument[];
  theme: Theme;
  orgRoot: string;
  selectedDoc: OrgDocument | null;
  setSelectedDoc: (d: OrgDocument | null) => void;
  onSpawnClaude?: (path: string, title: string, notes?: string, agentId?: string) => void;
  onOpenUrl?: (url: string) => void;
  activePaths?: Set<string>;
}
