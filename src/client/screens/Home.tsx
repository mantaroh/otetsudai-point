import type { Member, Sheet } from "../../shared/types";
import { BonusBanner } from "../components/BonusBanner";
import { useBootstrap } from "../hooks";
import { track, useScreen } from "../lib/telemetry";
import { useNavigate } from "../router";

/**
 * 「だれ?」の画面。共有タブレットの入口。
 * 顔を選ぶだけで台帳に入れる。ログインはしない。
 */
export function HomeScreen() {
  const { data } = useBootstrap();
  const navigate = useNavigate();
  useScreen("home");
  if (!data) return null;

  const children = data.members.filter((member) => member.role === "child");
  const waiting = data.pendingSheets.length;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-8 text-center">
        <h1 className="text-2xl font-bold">おてつだいポイント</h1>
        <p className="mt-1 text-sm text-ink-soft">{data.family.name}</p>
      </header>

      <div className="mb-4">
        <BonusBanner
          onStart={children.length === 1 ? () => navigate(`/m/${children[0]!.id}`) : undefined}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2" data-zone="children">
        {children.map((child) => (
          <ChildCard
            key={child.id}
            member={child}
            sheet={data.sheets[child.id]}
            hasPending={data.pendingSheets.some((sheet) => sheet.memberId === child.id)}
            onClick={() => {
              track("action", "pick-child", { memberId: child.id });
              navigate(`/m/${child.id}`);
            }}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={() => {
          track("action", "open-parent");
          navigate("/parent");
        }}
        className="mt-8 flex w-full flex-wrap items-center justify-center gap-2 rounded-2xl bg-paper-deep py-4 font-bold"
      >
        おうちの人のがめん
        {waiting > 0 && (
          <span className="rounded-full bg-accent px-2.5 py-0.5 text-sm text-white">
            こうかんまち {waiting}
          </span>
        )}
        {data.pendingGrants.length > 0 && (
          <span className="rounded-full bg-ink px-2.5 py-0.5 text-sm text-white">
            しんせいちゅう {data.pendingGrants.length}
          </span>
        )}
      </button>
    </div>
  );
}

function ChildCard({
  member,
  sheet,
  hasPending,
  onClick,
}: {
  member: Member;
  sheet: Sheet | undefined;
  hasPending: boolean;
  onClick: () => void;
}) {
  const accent = member.color ?? "#f2994a";
  const filled = sheet?.filled ?? 0;
  const capacity = sheet?.capacity ?? 30;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`paper-card flex items-center gap-4 p-5 text-left transition active:scale-[0.98] ${
        hasPending ? "animate-shimmer" : ""
      }`}
    >
      <ProgressRing value={filled} max={capacity} color={accent} label={member.avatar ?? "🙂"} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-lg font-bold">{member.name}</p>
        <p className="text-sm text-ink-soft">
          {filled} / {capacity} まい
        </p>
        {hasPending && (
          <p className="mt-1 text-sm font-bold" style={{ color: accent }}>
            こうかんできる!
          </p>
        )}
      </div>
    </button>
  );
}

function ProgressRing({
  value,
  max,
  color,
  label,
}: {
  value: number;
  max: number;
  color: string;
  label: string;
}) {
  const radius = 30;
  const circumference = 2 * Math.PI * radius;
  const ratio = max > 0 ? Math.min(1, value / max) : 0;

  return (
    <div className="relative h-20 w-20 shrink-0">
      <svg viewBox="0 0 72 72" className="h-full w-full -rotate-90">
        <circle cx="36" cy="36" r={radius} fill="none" stroke="#e5d8c0" strokeWidth="7" />
        <circle
          cx="36"
          cy="36"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
          className="transition-[stroke-dashoffset] duration-500"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-3xl">{label}</span>
    </div>
  );
}
