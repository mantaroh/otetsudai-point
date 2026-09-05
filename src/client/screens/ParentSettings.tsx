import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { BonusRule, BonusState, Chore, FamilySettings, Member } from "../../shared/types";
import { api } from "../api";
import { QrCode } from "../components/QrCode";
import { withExternalBrowser } from "../lib/inviteUrl";
import { useBootstrap, useRefreshBootstrap } from "../hooks";
import { useScreen } from "../lib/telemetry";
import { usePin } from "../pin";

/**
 * せってい。
 *
 * 家庭ごとに変わるルールはすべてここから触れる。
 * 「設定は存在するが画面から変えられない」状態を作らないことを優先していて、
 * 見た目より、必要な操作が全部そろっていることを重視している。
 */
export function SettingsTab() {
  const { data } = useBootstrap();
  useScreen("parent-settings");
  if (!data) return null;

  return (
    <div className="space-y-6">
      <MembersSection />
      <RulesSection />
      <BonusSection />
      <PinSection />
      <DevicesSection />
      <ChoresSection />
      <DataSection />

      <button
        type="button"
        onClick={async () => {
          await api.signOut();
          window.location.href = "/";
        }}
        className="w-full py-3 text-sm text-ink-soft underline"
      >
        ログアウト
      </button>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="paper-card p-5">
      <h2 className="font-bold">{title}</h2>
      {hint && <p className="mt-1 text-sm text-ink-soft">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

// ── 家族 ──────────────────────────────────────

const AVATARS = ["🙂", "😄", "🐱", "🐶", "🦊", "🐰", "🐼", "🦁", "🐸", "🐧", "👤", "⭐"];
const COLORS = ["#ff8fab", "#5bc0eb", "#9bc53d", "#fa9f42", "#a06cd5", "#7c6f5a"];

/**
 * 家族の名前・アイコン・色。
 *
 * 名前は変わる。呼び名が変わることもあれば、下の子が自分で決め直すこともある。
 * 名前は表示のためだけに持っているので、変えると過去の履歴の表示も新しい名前になる
 * (同じ人のままなので、それでよい)。
 */
function MembersSection() {
  const { data } = useBootstrap();
  const { withPin } = usePin();
  const refresh = useRefreshBootstrap();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const archived = useQuery({
    queryKey: ["members", "archived"],
    queryFn: () => api.archivedMembers(),
    retry: false,
  });

  if (!data) return null;

  async function run(action: (pin?: string) => Promise<unknown>) {
    setError(null);
    try {
      await withPin(action);
      await Promise.all([refresh(), archived.refetch()]);
      setEditing(null);
      setAdding(false);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "うまくいきませんでした");
      return false;
    }
  }

  const save = (memberId: string, patch: { name: string; avatar: string; color: string }) =>
    run((pin) => api.updateMember(memberId, patch, pin));

  async function remove(member: Member) {
    const confirmed = confirm(
      `「${member.name}」を家族からはずしますか?\n\n` +
        "これまでの記録は残ります。せってい画面からいつでも戻せます。",
    );
    if (!confirmed) return;
    await run((pin) => api.removeMember(member.id, {}, pin));
  }

  return (
    <Section title="家族" hint="名前やアイコンは、あとから変えられます。">
      <ul className="space-y-1">
        {data.members.map((member) =>
          editing === member.id ? (
            <li key={member.id}>
              <MemberEditor
                member={member}
                onCancel={() => setEditing(null)}
                onSave={save}
                onRemove={() => remove(member)}
              />
            </li>
          ) : (
            <li key={member.id}>
              <button
                type="button"
                onClick={() => setEditing(member.id)}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-paper-deep"
              >
                <Avatar member={member} />
                <span className="flex-1 truncate font-bold">{member.name}</span>
                <Badge>{member.role === "child" ? "こども" : "おうちの人"}</Badge>
                <span className="text-xs text-ink-soft">変える</span>
              </button>
            </li>
          ),
        )}
      </ul>

      {adding ? (
        <div className="mt-2">
          <MemberAdder
            onCancel={() => setAdding(false)}
            onSave={(body) => run((pin) => api.addMember(body, pin))}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-3 w-full rounded-xl border-2 border-dashed border-line py-3 text-sm"
        >
          ＋ 家族をふやす
        </button>
      )}

      {archived.isError && (
        <button
          type="button"
          onClick={() => void archived.refetch()}
          className="mt-3 w-full rounded-xl bg-paper-deep py-3 text-sm"
        >
          しまってある人を見る
        </button>
      )}

      {archived.data && archived.data.length > 0 && (
        <div className="mt-5 border-t border-line pt-4">
          <p className="text-sm font-bold">しまってある人</p>
          <p className="mt-0.5 text-xs text-ink-soft">
            記録は残っています。戻すと、そのときの台帳から続けられます。
          </p>
          <ul className="mt-2 space-y-1">
            {archived.data.map((member) => (
              <li key={member.id} className="flex items-center gap-3 rounded-lg bg-paper-deep p-2">
                <Avatar member={member} />
                <span className="flex-1 truncate text-sm">{member.name}</span>
                <button
                  type="button"
                  onClick={() =>
                    void run((pin) => api.removeMember(member.id, { purge: true }, pin))
                  }
                  className="rounded-lg bg-card px-3 py-2 text-xs"
                >
                  完全に削除
                </button>
                <button
                  type="button"
                  onClick={() => void run((pin) => api.restoreMember(member.id, pin))}
                  className="rounded-lg bg-accent px-3 py-2 text-xs font-bold text-white"
                >
                  もどす
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
    </Section>
  );
}

function Avatar({ member }: { member: Member }) {
  return (
    <span
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg"
      style={{ backgroundColor: member.color ?? "#e5d8c0" }}
    >
      {member.avatar ?? "🙂"}
    </span>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-full bg-paper-deep px-2 py-0.5 text-xs text-ink-soft">
      {children}
    </span>
  );
}

/** 家族を増やすときの入力。子どもなら、追加した時点で1冊目の台帳が始まる */
function MemberAdder({
  onCancel,
  onSave,
}: {
  onCancel: () => void;
  onSave: (body: { name: string; role: "child" | "parent"; avatar: string }) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<"child" | "parent">("child");
  const [avatar, setAvatar] = useState(AVATARS[1]!);
  const [busy, setBusy] = useState(false);

  return (
    <div className="rounded-xl bg-paper-deep p-3">
      <div className="flex gap-2" role="group" aria-label="どちらを追加するか">
        {(
          [
            ["child", "こども"],
            ["parent", "おうちの人"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={role === value}
            onClick={() => {
              setRole(value);
              setAvatar(value === "child" ? AVATARS[1]! : "👤");
            }}
            className={`flex-1 rounded-lg py-2 text-sm font-bold ${
              role === value ? "bg-accent text-white" : "bg-card"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="名前"
        maxLength={20}
        aria-label="あたらしい家族の名前"
        className="input mt-2"
      />

      <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="アイコン">
        {AVATARS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-label={`アイコン ${candidate}`}
            aria-pressed={avatar === candidate}
            onClick={() => setAvatar(candidate)}
            className={`h-9 w-9 rounded-lg text-lg ${
              avatar === candidate ? "bg-accent/20 ring-2 ring-accent" : "bg-card"
            }`}
          >
            {candidate}
          </button>
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <button type="button" onClick={onCancel} className="flex-1 rounded-lg bg-card py-2 text-sm">
          やめる
        </button>
        <button
          type="button"
          disabled={!name.trim() || busy}
          onClick={async () => {
            setBusy(true);
            const ok = await onSave({ name: name.trim(), role, avatar });
            if (!ok) setBusy(false);
          }}
          className="flex-1 rounded-lg bg-accent py-2 text-sm font-bold text-white disabled:opacity-40"
        >
          ふやす
        </button>
      </div>

      {role === "child" && (
        <p className="mt-2 text-xs text-ink-soft">
          追加すると、その場で1さつめの台帳がはじまります。
        </p>
      )}
    </div>
  );
}

function MemberEditor({
  member,
  onCancel,
  onSave,
  onRemove,
}: {
  member: Member;
  onCancel: () => void;
  onSave: (memberId: string, patch: { name: string; avatar: string; color: string }) => void;
  onRemove: () => void;
}) {
  const [name, setName] = useState(member.name);
  const [avatar, setAvatar] = useState(member.avatar ?? "🙂");
  const [color, setColor] = useState(member.color ?? COLORS[0]!);

  return (
    <div className="rounded-xl bg-paper-deep p-3">
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={20}
        aria-label="名前"
        className="input"
      />

      <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="アイコン">
        {AVATARS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-label={`アイコン ${candidate}`}
            aria-pressed={avatar === candidate}
            onClick={() => setAvatar(candidate)}
            className={`h-9 w-9 rounded-lg text-lg ${
              avatar === candidate ? "bg-accent/20 ring-2 ring-accent" : "bg-card"
            }`}
          >
            {candidate}
          </button>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="いろ">
        {COLORS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-label={`いろ ${candidate}`}
            aria-pressed={color === candidate}
            onClick={() => setColor(candidate)}
            className={`h-8 w-8 rounded-full ${
              color === candidate ? "ring-2 ring-ink ring-offset-2" : ""
            }`}
            style={{ backgroundColor: candidate }}
          />
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <button type="button" onClick={onCancel} className="flex-1 rounded-lg bg-card py-2 text-sm">
          やめる
        </button>
        <button
          type="button"
          disabled={!name.trim()}
          onClick={() => onSave(member.id, { name: name.trim(), avatar, color })}
          className="flex-1 rounded-lg bg-accent py-2 text-sm font-bold text-white disabled:opacity-40"
        >
          ほぞん
        </button>
      </div>

      <p className="mt-2 text-xs text-ink-soft">
        名前を変えると、これまでの記録の表示も新しい名前になります。
      </p>

      <button
        type="button"
        onClick={onRemove}
        className="mt-3 w-full rounded-lg border border-line py-2 text-xs text-ink-soft"
      >
        この人を家族からはずす
      </button>
    </div>
  );
}

function useSettingsMutation() {
  const { withPin } = usePin();
  const refresh = useRefreshBootstrap();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(patch: Partial<FamilySettings>) {
    setBusy(true);
    setError(null);
    try {
      await withPin((pin) => api.updateSettings(patch, pin));
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "うまくいきませんでした");
    } finally {
      setBusy(false);
    }
  }

  return { run, error, busy };
}

// ── ルール ────────────────────────────────────

const CAPACITY_CHOICES = [10, 20, 30, 50];

function RulesSection() {
  const { data } = useBootstrap();
  const { run, error, busy } = useSettingsMutation();
  const [custom, setCustom] = useState("");
  if (!data) return null;

  const { settings } = data;

  return (
    <Section title="この家庭のルール">
      <div className="space-y-4">
        <Toggle
          label="シールに親の承認をもとめる"
          hint="オフなら、子が押した瞬間に貼られます(うちの運用)"
          value={settings.requireApproval}
          disabled={busy}
          onChange={() => run({ requireApproval: !settings.requireApproval })}
        />
        <Toggle
          label="子どもが自分で貼れる"
          hint="オフにすると、おうちの人しか貼れなくなります"
          value={settings.allowSelfGrant}
          disabled={busy}
          onChange={() => run({ allowSelfGrant: !settings.allowSelfGrant })}
        />
        <Toggle
          label="きょうだいの台帳が見える"
          value={settings.siblingsVisible}
          disabled={busy}
          onChange={() => run({ siblingsVisible: !settings.siblingsVisible })}
        />
      </div>

      <div className="mt-6" role="group" aria-label="台帳1さつのマス数">
        <p className="text-sm font-bold">
          台帳1さつのマス数(いまは {settings.capacity} マス)
        </p>
        <p className="mt-0.5 text-xs text-ink-soft">
          変えても、使いかけの台帳はそのままです。次に始まる台帳から新しいマス数になります。
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {CAPACITY_CHOICES.map((value) => (
            <button
              key={value}
              type="button"
              disabled={busy}
              aria-pressed={settings.capacity === value}
              onClick={() => run({ capacity: value })}
              className={`min-w-16 flex-1 rounded-xl py-3 font-bold disabled:opacity-40 ${
                settings.capacity === value ? "bg-accent text-white" : "bg-paper-deep"
              }`}
            >
              {value}
            </button>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <input
            value={custom}
            onChange={(event) => setCustom(event.target.value.replace(/\D/g, "").slice(0, 3))}
            inputMode="numeric"
            placeholder="そのほかの数"
            aria-label="そのほかのマス数"
            className="input flex-1"
          />
          <button
            type="button"
            disabled={busy || !custom || Number(custom) < 1 || Number(custom) > 200}
            onClick={() => {
              run({ capacity: Number(custom) });
              setCustom("");
            }}
            className="rounded-xl bg-paper-deep px-5 font-bold disabled:opacity-40"
          >
            決定
          </button>
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
    </Section>
  );
}

// ── ポイント2倍デー ──────────────────────────────

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/**
 * ポイント2倍デー。
 *
 * 単発(今日だけ)と定期(毎週・毎月)を1か所で扱う。
 * 定期の設定で2倍になっている日は、単発の取り消しでは戻せないので、
 * トグルを出さずに理由だけを見せる。
 */
function BonusSection() {
  const { withPin } = usePin();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["bonus"], queryFn: () => api.bonus() });
  const [dayOfMonth, setDayOfMonth] = useState("");
  const [busy, setBusy] = useState(false);

  const state = query.data?.state;
  const rules = query.data?.rules ?? [];

  // 他の設定は useSettingsMutation() のように bootstrap の refresh() で反映するが、
  // ここはそれをしない。「今日だけ」の on/off は結果に新しい state がそのまま
  // 返ってくるので、それをそのままキャッシュへ書く方が、refetch を待つ間だけ
  // 古い表示が一瞬見える(stale-UI flash)のを避けられる。
  // ルールの追加・削除は state を返さないので、そのときだけ refetch() で取り直す。
  async function run(action: (pin?: string) => Promise<unknown>) {
    setBusy(true);
    try {
      const result = await withPin(action);
      if (result && typeof result === "object" && "state" in result) {
        const nextState = (result as { state: BonusState }).state;
        queryClient.setQueryData<{ state: BonusState; rules: BonusRule[] }>(
          ["bonus"],
          (prev) => ({ rules: prev?.rules ?? [], state: nextState }),
        );
      } else {
        await query.refetch();
      }
    } finally {
      setBusy(false);
    }
  }

  const weekly = new Map(rules.filter((rule) => rule.kind === "weekly").map((r) => [r.weekday, r]));
  const monthly = rules.filter((rule) => rule.kind === "monthly");

  return (
    <Section title="ポイント2倍デー" hint="お手伝い1回で、シールが2まい貼られます">
      {state?.active ? (
        <p className="font-bold">今日はポイント2倍です</p>
      ) : (
        <p className="text-ink-soft">今日はふつうの1倍です</p>
      )}

      {state?.active && state.source !== "once" ? (
        <p className="mt-2 text-sm text-ink-soft">
          {state.source === "weekly"
            ? `毎週${WEEKDAYS[new Date(`${state.dayKey}T00:00:00Z`).getUTCDay()]}曜日の設定で2倍になっています`
            : "毎月の設定で2倍になっています"}
          。やめるときは下の設定を消してください。
        </p>
      ) : state?.active ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => run((pin) => api.disableBonusToday(pin))}
          className="mt-3 w-full rounded-xl bg-paper-deep py-3 text-sm font-bold disabled:opacity-40"
        >
          今日の2倍をやめる
        </button>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => run((pin) => api.enableBonusToday(pin))}
          className="mt-3 w-full rounded-xl bg-accent py-3 text-sm font-bold text-white disabled:opacity-40"
        >
          今日をポイント2倍にする
        </button>
      )}

      <h3 className="mt-6 text-sm font-bold">毎週きまった曜日</h3>
      <div className="mt-2 flex flex-wrap gap-2">
        {WEEKDAYS.map((label, weekday) => {
          const rule = weekly.get(weekday);
          return (
            <button
              key={weekday}
              type="button"
              disabled={busy}
              aria-pressed={rule !== undefined}
              onClick={() =>
                run((pin) =>
                  rule
                    ? api.removeBonusRule(rule.id, pin)
                    : api.addBonusRule({ kind: "weekly", weekday }, pin),
                )
              }
              className={`rounded-lg px-3 py-2 text-sm font-bold disabled:opacity-40 ${
                rule ? "bg-accent text-white" : "bg-card"
              }`}
            >
              {rule ? `毎週${label}曜日 を削除` : `毎週 ${label}曜日`}
            </button>
          );
        })}
      </div>

      <h3 className="mt-6 text-sm font-bold">毎月きまった日</h3>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="text-sm text-ink-soft" htmlFor="bonus-day-of-month">
          毎月の日にち
        </label>
        <input
          id="bonus-day-of-month"
          inputMode="numeric"
          value={dayOfMonth}
          onChange={(event) => setDayOfMonth(event.target.value.replace(/\D/g, "").slice(0, 2))}
          className="input w-20"
        />
        <button
          type="button"
          disabled={busy || dayOfMonth === "" || Number(dayOfMonth) < 1 || Number(dayOfMonth) > 31}
          onClick={() =>
            run(async (pin) => {
              await api.addBonusRule({ kind: "monthly", dayOfMonth: Number(dayOfMonth) }, pin);
              setDayOfMonth("");
            })
          }
          className="rounded-xl bg-paper-deep px-5 py-2 text-sm font-bold disabled:opacity-40"
        >
          毎月の日を追加
        </button>
      </div>
      <ul className="mt-2 space-y-1">
        {monthly.map((rule) => (
          <li
            key={rule.id}
            className="flex items-center justify-between rounded-lg bg-paper-deep px-3 py-2"
          >
            <span className="text-sm">毎月 {rule.dayOfMonth}日</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => run((pin) => api.removeBonusRule(rule.id, pin))}
              className="rounded-lg bg-card px-3 py-2 text-xs"
            >
              毎月{rule.dayOfMonth}日 を削除
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-ink-soft">31日を選ぶと、31日がない月はお休みになります。</p>
    </Section>
  );
}

function Toggle({
  label,
  hint,
  value,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className="flex w-full items-center gap-3 text-left disabled:opacity-50"
    >
      <span className="flex-1">
        <span className="block text-sm font-bold">{label}</span>
        {hint && <span className="block text-xs text-ink-soft">{hint}</span>}
      </span>
      <span className={`h-7 w-12 shrink-0 rounded-full p-1 transition ${value ? "bg-accent" : "bg-line"}`}>
        <span className={`block h-5 w-5 rounded-full bg-white transition ${value ? "translate-x-5" : ""}`} />
      </span>
    </button>
  );
}

// ── PIN ───────────────────────────────────────

function PinSection() {
  const { withPin } = usePin();
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const valid = /^\d{4,8}$/.test(next) && next === confirm;

  async function submit() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await withPin((pin) => api.changePin(next, pin));
      setMessage("PIN を変えました");
      setNext("");
      setConfirm("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "うまくいきませんでした");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="PIN の変更" hint="共有タブレットから親の操作をするときに使う番号です。">
      <div className="space-y-2">
        <input
          value={next}
          onChange={(event) => setNext(event.target.value.replace(/\D/g, "").slice(0, 8))}
          inputMode="numeric"
          placeholder="あたらしい PIN(4〜8桁)"
          aria-label="あたらしい PIN"
          className="input tracking-[0.3em]"
        />
        <input
          value={confirm}
          onChange={(event) => setConfirm(event.target.value.replace(/\D/g, "").slice(0, 8))}
          inputMode="numeric"
          placeholder="もう一度"
          aria-label="あたらしい PIN(確認)"
          className="input tracking-[0.3em]"
        />
      </div>

      {next && confirm && next !== confirm && (
        <p className="mt-2 text-sm text-red-700">2つの PIN が一致しません</p>
      )}
      {message && <p className="mt-2 text-sm font-bold">{message}</p>}
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}

      <button
        type="button"
        disabled={!valid || busy}
        onClick={submit}
        className="mt-3 w-full rounded-xl bg-paper-deep py-3 font-bold disabled:opacity-40"
      >
        PIN を変える
      </button>
    </Section>
  );
}

// ── 端末 ──────────────────────────────────────

/** 端末の種類。何ができる端末なのかが、名前を見なくても分かるようにする */
const DEVICE_KINDS: Record<string, { label: string; icon: string; note: string }> = {
  shared: {
    label: "みんなで使う",
    icon: "🏠",
    note: "だれの台帳にも貼れる。親の操作には PIN が要る",
  },
  child: {
    label: "子ども専用",
    icon: "🧒",
    note: "その子の台帳しか開かない",
  },
  parent: {
    label: "おうちの人",
    icon: "🔑",
    note: "親の操作ができる",
  },
};

function DevicesSection() {
  const { data } = useBootstrap();
  const { withPin } = usePin();
  const [invite, setInvite] = useState<{ url: string; expiresAt: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * 端末の一覧は親の情報なので PIN が要る。
   * ただし、せっていを開いた瞬間にテンキーが出るのは唐突なので、
   * まずは PIN なしで試し、断られたら「見る」ボタンを出すだけにする。
   */
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: () => api.devices(),
    retry: false,
  });

  if (!data) return null;

  async function unlock() {
    setError(null);
    try {
      await withPin((pin) => api.devices(pin));
      await devices.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "うまくいきませんでした");
    }
  }

  async function issue(kind: string, label: string, memberId?: string) {
    setError(null);
    setInvite(null);
    try {
      setInvite(await withPin((pin) => api.createInvite({ kind, label, memberId }, pin)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "うまくいきませんでした");
    }
  }

  async function rename(deviceId: string, label: string) {
    setError(null);
    try {
      await withPin((pin) => api.updateDevice(deviceId, { label }, pin));
      await devices.refetch();
      setRenaming(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "うまくいきませんでした");
    }
  }

  async function revoke(deviceId: string, label: string) {
    if (!confirm(`「${label}」を使えなくしますか?\nその端末は次に開いたときログインを求められます。`)) {
      return;
    }
    try {
      await withPin((pin) => api.revokeDevice(deviceId, pin));
      await devices.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "うまくいきませんでした");
    }
  }

  const nameOf = (memberId: string | null) =>
    data.members.find((member) => member.id === memberId)?.name ?? "";

  return (
    <Section
      title="端末"
      hint="発行したリンクをその端末で開き、確認のボタンを押すと、以後ログインなしで使えます。開くだけでは登録されないので、LINE などで送っても大丈夫です。リンクは30分で切れ、1回登録すると無効になります。"
    >
      {devices.isError && (
        <button
          type="button"
          onClick={unlock}
          className="mb-4 w-full rounded-xl bg-paper-deep py-3 text-sm font-bold"
        >
          PIN を入れて、登録ずみの端末を見る
        </button>
      )}

      {devices.data && devices.data.length > 0 && (
        <ul className="mb-4 space-y-2">
          {devices.data.map((device) => {
            const kind = DEVICE_KINDS[device.kind];
            return (
              <li key={device.id} className="rounded-xl bg-paper-deep p-3">
                {renaming === device.id ? (
                  <DeviceEditor
                    label={device.label}
                    onCancel={() => setRenaming(null)}
                    onSave={(label) => rename(device.id, label)}
                  />
                ) : (
                  <>
                    <div className="flex items-center gap-3">
                      <span className="text-xl" aria-hidden>
                        {kind?.icon ?? "📱"}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold">{device.label}</p>
                        <p className="text-xs text-ink-soft">
                          {kind?.label ?? device.kind}
                          {device.memberId && ` ・ ${nameOf(device.memberId)}`}
                          {device.lastSeenAt && ` ・ さいご ${formatDate(device.lastSeenAt)}`}
                        </p>
                      </div>
                    </div>

                    {kind && <p className="mt-1 pl-8 text-xs text-ink-soft">{kind.note}</p>}

                    <div className="mt-2 flex gap-2 pl-8">
                      <button
                        type="button"
                        onClick={() => setRenaming(device.id)}
                        className="rounded-lg bg-card px-3 py-2 text-xs"
                      >
                        名前を変える
                      </button>
                      <button
                        type="button"
                        onClick={() => revoke(device.id, device.label)}
                        className="rounded-lg bg-card px-3 py-2 text-xs"
                      >
                        失効
                      </button>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="space-y-2">
        <button
          type="button"
          onClick={() => issue("shared", "リビングのタブレット")}
          className="w-full rounded-xl bg-paper-deep py-3 text-sm font-bold"
        >
          共有タブレット用のリンクを発行
        </button>
        {data.members
          .filter((member) => member.role === "child")
          .map((child) => (
            <button
              key={child.id}
              type="button"
              onClick={() => issue("child", `${child.name}のスマホ`, child.id)}
              className="w-full rounded-xl bg-paper-deep py-3 text-sm font-bold"
            >
              {child.name}せんよう端末のリンクを発行
            </button>
          ))}
      </div>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {invite && <InviteResult invite={invite} />}
    </Section>
  );
}

/**
 * 発行した招待リンクの渡し方。
 *
 * いちばん確実なのは QR コードを相手の端末のカメラで読むこと。
 * コピーも貼り付けも要らず、既定のブラウザで開くので、後述の問題も起きない。
 */
function InviteResult({ invite }: { invite: { url: string; expiresAt: number } }) {
  const [forMessaging, setForMessaging] = useState(true);
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(true);

  const url = withExternalBrowser(invite.url, forMessaging);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  return (
    <div className="mt-4 rounded-xl bg-paper-deep p-4">
      <p className="text-xs text-ink-soft">
        {new Date(invite.expiresAt).toLocaleTimeString("ja-JP")} まで有効・1回だけ使えます
      </p>

      {showQr && (
        <div className="mt-3 flex flex-col items-center">
          <QrCode value={url} />
          <p className="mt-2 text-xs text-ink-soft">
            渡したい端末のカメラで読み取ってください
          </p>
        </div>
      )}

      <p data-testid="invite-url" className="mt-3 break-all font-mono text-xs">
        {url}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard?.writeText(url);
            setCopied(true);
          }}
          className="rounded-lg bg-card px-4 py-2 text-sm"
        >
          {copied ? "コピーしました" : "コピー"}
        </button>

        {canShare && (
          <button
            type="button"
            onClick={() => {
              void navigator
                .share({ title: "おてつだいポイント", text: "この端末を登録してね", url })
                .catch(() => {
                  // 共有シートを閉じただけ。何もしない
                });
            }}
            className="rounded-lg bg-card px-4 py-2 text-sm"
          >
            LINE などで送る
          </button>
        )}

        <button
          type="button"
          onClick={() => setShowQr((current) => !current)}
          className="rounded-lg bg-card px-4 py-2 text-sm"
        >
          {showQr ? "QR をかくす" : "QR を出す"}
        </button>
      </div>

      {/*
        説明文まで label に含めると、読み上げのときにチェックボックスの名前が
        段落まるごとになってしまう。名前は短く、理由は説明として結びつける。
      */}
      <div className="mt-3 flex items-start gap-2 text-xs">
        <input
          id="invite-for-messaging"
          type="checkbox"
          aria-describedby="invite-for-messaging-hint"
          checked={forMessaging}
          onChange={(event) => {
            setForMessaging(event.target.checked);
            setCopied(false);
          }}
          className="mt-0.5"
        />
        <div>
          <label htmlFor="invite-for-messaging" className="font-bold">
            LINE で送る用にする
          </label>
          <p id="invite-for-messaging-hint" className="mt-0.5 text-ink-soft">
            LINE のリンクは、そのままだとアプリ内ブラウザで開きます。そこで登録しても
            Safari や Chrome では未登録のままになるため、外部ブラウザで開くよう
            URL に印を付けます。QR やメールで渡すときは、付いていても害はありません。
          </p>
        </div>
      </div>
    </div>
  );
}

function DeviceEditor({
  label,
  onCancel,
  onSave,
}: {
  label: string;
  onCancel: () => void;
  onSave: (label: string) => void;
}) {
  const [value, setValue] = useState(label);

  return (
    <div>
      <input
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        maxLength={40}
        aria-label="端末の名前"
        className="input"
      />
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={onCancel} className="flex-1 rounded-lg bg-card py-2 text-sm">
          やめる
        </button>
        <button
          type="button"
          disabled={!value.trim()}
          onClick={() => onSave(value.trim())}
          className="flex-1 rounded-lg bg-accent py-2 text-sm font-bold text-white disabled:opacity-40"
        >
          ほぞん
        </button>
      </div>
    </div>
  );
}

// ── お手伝いメニュー ──────────────────────────

const EMOJI_CHOICES = ["✨", "🧹", "🍽️", "🧺", "🛁", "🗑️", "👟", "🍚", "🧸", "🐕", "📚", "🚗"];

function ChoresSection() {
  const { data } = useBootstrap();
  const { withPin } = usePin();
  const refresh = useRefreshBootstrap();
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!data) return null;

  async function save(choreId: string, patch: Parameters<typeof api.updateChore>[1]) {
    setError(null);
    try {
      await withPin((pin) => api.updateChore(choreId, patch, pin));
      await refresh();
      setEditing(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "うまくいきませんでした");
    }
  }

  return (
    <Section
      title="お手伝いメニュー"
      hint="よく使う順にならびます。子が「そのほか」で入力したものも、ここに載ります。"
    >
      <ul className="space-y-1">
        {data.chores.map((chore) =>
          editing === chore.id ? (
            <li key={chore.id}>
              <ChoreEditor chore={chore} onCancel={() => setEditing(null)} onSave={save} />
            </li>
          ) : (
            <li key={chore.id}>
              <button
                type="button"
                onClick={() => setEditing(chore.id)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-paper-deep"
              >
                <span className="text-lg">{chore.emoji ?? "✨"}</span>
                <span className="flex-1 truncate">{chore.name}</span>
                {chore.defaultCount > 1 && (
                  <span className="rounded-full bg-paper-deep px-2 py-0.5 text-xs">
                    めやす {chore.defaultCount}まい
                  </span>
                )}
                <span className="text-xs text-ink-soft">{chore.useCount}回</span>
              </button>
            </li>
          ),
        )}
      </ul>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
    </Section>
  );
}

function ChoreEditor({
  chore,
  onCancel,
  onSave,
}: {
  chore: Chore;
  onCancel: () => void;
  onSave: (choreId: string, patch: { name?: string; emoji?: string; defaultCount?: number; archived?: boolean }) => void;
}) {
  const [name, setName] = useState(chore.name);
  const [emoji, setEmoji] = useState(chore.emoji ?? "✨");
  const [count, setCount] = useState(chore.defaultCount);

  return (
    <div className="rounded-xl bg-paper-deep p-3">
      <div className="mb-2 flex flex-wrap gap-1">
        {EMOJI_CHOICES.map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-label={`絵文字 ${candidate}`}
            aria-pressed={emoji === candidate}
            onClick={() => setEmoji(candidate)}
            className={`h-9 w-9 rounded-lg text-lg ${
              emoji === candidate ? "bg-accent/20 ring-2 ring-accent" : "bg-card"
            }`}
          >
            {candidate}
          </button>
        ))}
      </div>

      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={40}
        aria-label="お手伝いの名前"
        className="input"
      />

      <div className="mt-2 flex items-center gap-3">
        <span className="text-sm">めやす枚数</span>
        <button
          type="button"
          aria-label="めやす枚数をへらす"
          onClick={() => setCount((current) => Math.max(1, current - 1))}
          className="h-9 w-9 rounded-lg bg-card font-bold"
        >
          −
        </button>
        <span className="w-6 text-center font-bold">{count}</span>
        <button
          type="button"
          aria-label="めやす枚数をふやす"
          onClick={() => setCount((current) => Math.min(50, current + 1))}
          className="h-9 w-9 rounded-lg bg-card font-bold"
        >
          ＋
        </button>
      </div>

      <div className="mt-3 flex gap-2">
        <button type="button" onClick={onCancel} className="flex-1 rounded-lg bg-card py-2 text-sm">
          やめる
        </button>
        <button
          type="button"
          onClick={() => onSave(chore.id, { archived: true })}
          className="rounded-lg bg-card px-3 py-2 text-sm"
        >
          しまう
        </button>
        <button
          type="button"
          disabled={!name.trim()}
          onClick={() => onSave(chore.id, { name: name.trim(), emoji, defaultCount: count })}
          className="flex-1 rounded-lg bg-accent py-2 text-sm font-bold text-white disabled:opacity-40"
        >
          ほぞん
        </button>
      </div>

      <p className="mt-2 text-xs text-ink-soft">
        「しまう」とメニューから消えますが、これまでの記録は残ります。
      </p>
    </div>
  );
}

// ── データ ────────────────────────────────────

function DataSection() {
  const { withPin } = usePin();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const data = await withPin((pin) => api.exportData(pin));
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "otetsudai-point.json";
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "うまくいきませんでした");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="データの持ち出し"
      hint="台帳・シール・交換の記録をすべて JSON で書き出します。"
    >
      <button
        type="button"
        onClick={download}
        disabled={busy}
        className="w-full rounded-xl bg-paper-deep py-3 text-sm font-bold disabled:opacity-40"
      >
        書き出す
      </button>
      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
    </Section>
  );
}

function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
}
