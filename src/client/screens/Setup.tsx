import { useState } from "react";
import { api } from "../api";

/**
 * 家庭の新規作成。
 *
 * うちの運用に合わせた既定値(30マス・自己申告OK・承認なし)で始まる。
 * 他の家庭が使うときも、まずはこの既定で動かして、あとから設定で変えられればよい。
 */
const AVATARS = ["🙂", "😄", "🐱", "🐶", "🦊", "🐰", "🐼", "🦁", "🐸", "🐧"];
const COLORS = ["#ff8fab", "#5bc0eb", "#9bc53d", "#fa9f42", "#a06cd5"];

export function SetupScreen({
  /** 作成後の遷移。既定は再読み込みだが、テストからは差し替えられるようにしておく */
  onCreated = () => {
    window.location.href = "/";
  },
}: {
  onCreated?: () => void;
} = {}) {
  const [familyName, setFamilyName] = useState("");
  const [parentName, setParentName] = useState("");
  const [pin, setPin] = useState("");
  const [capacity, setCapacity] = useState(30);
  const [children, setChildren] = useState([
    { name: "", avatar: AVATARS[1]!, color: COLORS[0]! },
    { name: "", avatar: AVATARS[2]!, color: COLORS[1]! },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canSubmit =
    familyName.trim() && parentName.trim() && /^\d{4,8}$/.test(pin) &&
    children.some((child) => child.name.trim());

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.createFamily({
        familyName: familyName.trim(),
        parentName: parentName.trim(),
        pin,
        capacity,
        children: children
          .filter((child) => child.name.trim())
          .map((child) => ({ name: child.name.trim(), avatar: child.avatar, color: child.color })),
      });
      onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "うまくいきませんでした");
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg px-5 py-8">
      <h1 className="text-2xl font-bold">はじめの設定</h1>
      <p className="mt-1 text-sm text-ink-soft">あとから変えられます。</p>

      <Field label="家族の名前">
        <input
          value={familyName}
          onChange={(event) => setFamilyName(event.target.value)}
          placeholder="やまだ家"
          maxLength={40}
          className="input"
        />
      </Field>

      <Field label="あなた(おうちの人)の名前">
        <input
          value={parentName}
          onChange={(event) => setParentName(event.target.value)}
          placeholder="おかあさん"
          maxLength={20}
          className="input"
        />
      </Field>

      <Field
        label="おうちの人のPIN(4〜8桁の数字)"
        hint="交換のハンコや、シールの取り消しに使います"
      >
        <input
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 8))}
          inputMode="numeric"
          placeholder="1234"
          className="input tracking-[0.4em]"
        />
      </Field>

      <FieldGroup label="台帳1さつのマス数" hint="うちは30マスで運用しています">
        <div className="flex gap-2">
          {[20, 30, 50].map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={capacity === value}
              onClick={() => setCapacity(value)}
              className={`flex-1 rounded-xl py-3 font-bold ${
                capacity === value ? "bg-accent text-white" : "bg-paper-deep"
              }`}
            >
              {value}
            </button>
          ))}
        </div>
      </FieldGroup>

      <div className="mt-6">
        <p className="mb-2 text-sm font-bold">お子さん</p>
        <div className="space-y-3">
          {children.map((child, index) => (
            <div key={index} className="paper-card p-4">
              <div className="flex gap-2">
                <select
                  value={child.avatar}
                  onChange={(event) =>
                    setChildren((current) =>
                      current.map((item, i) =>
                        i === index ? { ...item, avatar: event.target.value } : item,
                      ),
                    )
                  }
                  className="rounded-xl border border-line bg-white px-2 py-3 text-2xl"
                >
                  {AVATARS.map((avatar) => (
                    <option key={avatar} value={avatar}>
                      {avatar}
                    </option>
                  ))}
                </select>
                <input
                  value={child.name}
                  onChange={(event) =>
                    setChildren((current) =>
                      current.map((item, i) =>
                        i === index ? { ...item, name: event.target.value } : item,
                      ),
                    )
                  }
                  placeholder={`${index + 1}人目の名前`}
                  maxLength={20}
                  className="input min-w-0 flex-1"
                />
              </div>
              <div className="mt-2 flex gap-2">
                {COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    aria-label={`いろ ${color}`}
                    onClick={() =>
                      setChildren((current) =>
                        current.map((item, i) => (i === index ? { ...item, color } : item)),
                      )
                    }
                    className={`h-8 w-8 rounded-full ${
                      child.color === color ? "ring-2 ring-ink ring-offset-2" : ""
                    }`}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        {children.length < 10 && (
          <button
            type="button"
            onClick={() =>
              setChildren((current) => [
                ...current,
                {
                  name: "",
                  avatar: AVATARS[(current.length + 1) % AVATARS.length]!,
                  color: COLORS[current.length % COLORS.length]!,
                },
              ])
            }
            className="mt-3 w-full rounded-xl border-2 border-dashed border-line py-3 text-sm"
          >
            ＋ お子さんを追加
          </button>
        )}
      </div>

      {error && (
        <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      )}

      <button
        type="button"
        disabled={!canSubmit || busy}
        onClick={submit}
        className="mt-8 w-full rounded-2xl bg-accent py-4 text-lg font-bold text-white disabled:opacity-40"
      >
        はじめる
      </button>
    </div>
  );
}

/** 入力欄が1つだけの項目。label で包むことで、見出しがそのまま入力欄の名前になる。 */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="mt-6 block">
      <span className="text-sm font-bold">{label}</span>
      {hint && <span className="mt-0.5 block text-xs text-ink-soft">{hint}</span>}
      <div className="mt-2">{children}</div>
    </label>
  );
}

/**
 * 選択肢が複数ある項目。
 *
 * label で包んでしまうと、中の最初のボタンが「その項目の入力欄」とみなされ、
 * 見出しや他の選択肢まで含んだ長い名前で読み上げられてしまう。
 * ボタン群には label ではなく group を使う。
 */
function FieldGroup({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-6" role="group" aria-label={label}>
      <span className="block text-sm font-bold">{label}</span>
      {hint && <span className="mt-0.5 block text-xs text-ink-soft">{hint}</span>}
      <div className="mt-2">{children}</div>
    </div>
  );
}
