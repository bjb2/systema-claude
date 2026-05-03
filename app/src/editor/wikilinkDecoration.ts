import { Extension, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";

const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;

interface WikilinkRange {
  from: number;
  to: number;
  slug: string;
}

function buildDecorations(view: EditorView): {
  decorations: DecorationSet;
  ranges: WikilinkRange[];
} {
  const builder = new RangeSetBuilder<Decoration>();
  const ranges: WikilinkRange[] = [];
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    WIKILINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKILINK_RE.exec(text)) !== null) {
      const start = from + m.index;
      const end = start + m[0].length;
      const slug = m[1];
      builder.add(
        start,
        end,
        Decoration.mark({ class: "cm-wikilink", attributes: { "data-wikilink": slug } })
      );
      ranges.push({ from: start, to: end, slug });
    }
  }
  return { decorations: builder.finish(), ranges };
}

export function wikilinkPlugin(
  onNavigate: (slug: string) => void
): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      ranges: WikilinkRange[];

      constructor(view: EditorView) {
        const built = buildDecorations(view);
        this.decorations = built.decorations;
        this.ranges = built.ranges;
      }

      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) {
          const built = buildDecorations(u.view);
          this.decorations = built.decorations;
          this.ranges = built.ranges;
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(this, e: MouseEvent, view: EditorView) {
          if (!(e.ctrlKey || e.metaKey)) return false;
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos == null) return false;
          for (const r of this.ranges) {
            if (pos >= r.from && pos <= r.to) {
              e.preventDefault();
              onNavigate(r.slug);
              return true;
            }
          }
          return false;
        },
      },
    }
  );

  const theme = EditorView.theme({
    ".cm-wikilink": {
      color: "var(--link-color, #4a9eff)",
      cursor: "pointer",
      textDecoration: "underline",
    },
  });

  return [plugin, theme];
}
