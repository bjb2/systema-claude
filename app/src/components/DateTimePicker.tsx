import { Theme } from "../themes";

interface Props {
  value: string; // "YYYY-MM-DDTHH:MM"
  onChange: (value: string) => void;
  theme: Theme;
}

const HOURS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const MINUTES = ["00", "05", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55"];

function parse(value: string) {
  const [datePart = "", timePart = ""] = value.split("T");
  const [hStr = "9", mStr = "00"] = timePart.split(":");
  const h24 = parseInt(hStr, 10) || 9;
  const period = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 || 12;
  // round minutes down to nearest 5
  const mRaw = parseInt(mStr, 10) || 0;
  const mSnapped = Math.floor(mRaw / 5) * 5;
  const minute = String(mSnapped).padStart(2, "0");
  return { date: datePart, hour: String(h12), minute, period };
}

function toIso(date: string, hour: string, minute: string, period: string): string {
  let h24 = parseInt(hour, 10) % 12;
  if (period === "PM") h24 += 12;
  return `${date}T${String(h24).padStart(2, "0")}:${minute}`;
}

const selectStyle = (theme: Theme): React.CSSProperties => ({
  background: theme.bgSecondary,
  color: theme.text,
  border: `1px solid ${theme.border}`,
  borderRadius: "4px",
  padding: "3px 4px",
  fontSize: "12px",
  outline: "none",
  cursor: "pointer",
});

export default function DateTimePicker({ value, onChange, theme }: Props) {
  const { date, hour, minute, period } = parse(value);

  const update = (patch: Partial<ReturnType<typeof parse>>) => {
    const next = { date, hour, minute, period, ...patch };
    onChange(toIso(next.date, next.hour, next.minute, next.period));
  };

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {/* Date — native date input is fine, scroll only affects time spinners */}
      <input
        type="date"
        value={date}
        onChange={e => update({ date: e.target.value })}
        style={{
          ...selectStyle(theme),
          colorScheme: "dark",
          padding: "3px 6px",
        }}
      />

      {/* Time selects — immune to scroll */}
      <div className="flex items-center gap-0.5">
        <select
          value={hour}
          onChange={e => update({ hour: e.target.value })}
          style={selectStyle(theme)}
        >
          {HOURS.map(h => (
            <option key={h} value={h} style={{ background: theme.bgSecondary }}>
              {h}
            </option>
          ))}
        </select>

        <span style={{ color: theme.textDim, fontSize: "12px", padding: "0 1px" }}>:</span>

        <select
          value={minute}
          onChange={e => update({ minute: e.target.value })}
          style={selectStyle(theme)}
        >
          {MINUTES.map(m => (
            <option key={m} value={m} style={{ background: theme.bgSecondary }}>
              {m}
            </option>
          ))}
        </select>

        <select
          value={period}
          onChange={e => update({ period: e.target.value })}
          style={{ ...selectStyle(theme), marginLeft: "2px" }}
        >
          <option value="AM" style={{ background: theme.bgSecondary }}>AM</option>
          <option value="PM" style={{ background: theme.bgSecondary }}>PM</option>
        </select>
      </div>
    </div>
  );
}
