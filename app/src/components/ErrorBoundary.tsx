import { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
  label?: string;
  onClose?: () => void;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error(`[ErrorBoundary:${this.props.label ?? "app"}]`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const btnStyle: React.CSSProperties = {
      marginTop: 16,
      padding: "4px 12px",
      background: "#1a1a3a",
      border: "1px solid #333",
      color: "#aaa",
      borderRadius: 4,
      cursor: "pointer",
      fontSize: 11,
    };

    return (
      <div style={{
        padding: 24,
        fontFamily: "'Cascadia Code', Consolas, monospace",
        fontSize: 12,
        color: "#ff6b6b",
        background: "#0d0d1a",
        height: "100%",
        overflow: "auto",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}>
        <div style={{ color: "#ff4444", fontWeight: 700, marginBottom: 12, fontSize: 14 }}>
          ✗ Render crash{this.props.label ? ` in ${this.props.label}` : ""}
        </div>
        <div style={{ color: "#ffaa44", marginBottom: 8 }}>{error.message}</div>
        <div style={{ color: "#888", fontSize: 11 }}>{error.stack}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => this.setState({ error: null })} style={btnStyle}>
            retry
          </button>
          {this.props.onClose && (
            <button onClick={this.props.onClose} style={{ ...btnStyle, color: "#ff6b6b", borderColor: "#ff4444" }}>
              close tile
            </button>
          )}
        </div>
      </div>
    );
  }
}
