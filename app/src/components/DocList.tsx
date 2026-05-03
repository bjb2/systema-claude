import { OrgDocument } from "../types";
import { Theme } from "../themes";

interface Props {
  docs: OrgDocument[];
  theme: Theme;
  selected: OrgDocument | null;
  onSelect: (d: OrgDocument) => void;
  renderMeta?: (d: OrgDocument) => React.ReactNode;
}

const STATUS_COLORS: Record<string, string> = {
  active: "#4af076",
  blocked: "#f0c44a",
  paused: "#888",
  complete: "#4af076",
  pending: "#f0c44a",
  completed: "#4af076",
  dismissed: "#888",
};

export default function DocList({ docs, theme, selected, onSelect, renderMeta }: Props) {
  if (docs.length === 0) {
    return (
      <div className="p-6 text-sm" style={{ color: theme.textDim }}>
        No documents found.
      </div>
    );
  }

  return (
    <div className="overflow-y-auto h-full">
      {docs.map(doc => {
        const isSelected = selected?.path === doc.path;
        const statusColor = doc.status ? (STATUS_COLORS[doc.status] ?? theme.textMuted) : undefined;
        return (
          <button
            key={doc.path}
            onClick={() => onSelect(doc)}
            className="w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm border-b transition-colors"
            style={{
              background: isSelected ? theme.accentMuted : "transparent",
              borderColor: theme.border,
              color: theme.text,
            }}
          >
            {statusColor && (
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: statusColor }} />
            )}
            <span className="flex-1 truncate">{doc.title}</span>
            {renderMeta ? renderMeta(doc) : (
              <span className="text-xs flex-shrink-0" style={{ color: theme.textDim }}>
                {doc.created ?? ""}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
