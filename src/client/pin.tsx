import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, PinRequiredError } from "./api";
import { track } from "./lib/telemetry";

/**
 * 親操作の PIN。
 *
 * 呼び出し側は PIN のことを気にせずに `withPin((pin) => api.something(..., pin))` と書く。
 * 401 pin_required が返ったときだけテンキーが出て、通ったら同じ操作を透過的に再実行する。
 * サーバ側は一度通れば15分間チケットが効くので、続けて操作しても再入力は求められない。
 */

interface PinContextValue {
  withPin: <T>(action: (pin?: string) => Promise<T>) => Promise<T>;
}

const PinContext = createContext<PinContextValue | null>(null);

export function PinProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const resolver = useRef<((pin: string | null) => void) | null>(null);

  const askPin = useCallback((): Promise<string | null> => {
    setOpen(true);
    return new Promise((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = useCallback((pin: string | null) => {
    setOpen(false);
    resolver.current?.(pin);
    resolver.current = null;
  }, []);

  const withPin = useCallback(
    async <T,>(action: (pin?: string) => Promise<T>): Promise<T> => {
      try {
        return await action();
      } catch (error) {
        if (!(error instanceof PinRequiredError)) throw error;
        const pin = await askPin();
        if (!pin) throw error;
        return action(pin);
      }
    },
    [askPin],
  );

  const value = useMemo(() => ({ withPin }), [withPin]);

  return (
    <PinContext.Provider value={value}>
      {children}
      {open && <PinPad onCancel={() => close(null)} onSubmit={(pin) => close(pin)} />}
    </PinContext.Provider>
  );
}

export function usePin(): PinContextValue {
  const context = useContext(PinContext);
  if (!context) throw new Error("PinProvider の外で usePin が呼ばれました");
  return context;
}

function PinPad({
  onSubmit,
  onCancel,
}: {
  onSubmit: (pin: string) => void;
  onCancel: () => void;
}) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  // PIN は親の操作を止める関門なので、出た回数と間違えた回数を見ておく。
  // 打った数字そのものは当然どこにも送らない
  useEffect(() => {
    track("step", "pin-open");
  }, []);

  const press = (digit: string) => {
    setError(null);
    setPin((current) => (current.length >= 8 ? current : current + digit));
  };

  const confirm = async () => {
    if (pin.length < 4) return;
    setChecking(true);
    try {
      // 先に検証しておくと、本命の操作が PIN 違いで失敗するのを避けられる
      await api.verifyPin(pin);
      track("action", "pin-ok");
      onSubmit(pin);
    } catch {
      setError("PIN がちがいます");
      setPin("");
      track("friction", "pin-wrong");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-4 sm:items-center">
      <div className="paper-card w-full max-w-sm animate-rise p-6">
        <h2 className="text-center text-lg font-bold">おうちの人のPIN</h2>
        <p className="mt-1 text-center text-sm text-ink-soft">
          この操作にはおうちの人の確認が必要です
        </p>

        <div className="my-6 flex justify-center gap-3">
          {Array.from({ length: 8 }, (_, index) => (
            <span
              key={index}
              className={`h-3 w-3 rounded-full transition-colors ${
                index < pin.length ? "bg-accent" : index < 4 ? "bg-line" : "bg-line/40"
              }`}
            />
          ))}
        </div>

        {error && <p className="mb-3 text-center text-sm text-red-600">{error}</p>}

        <div className="grid grid-cols-3 gap-2">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
            <PadButton key={digit} onClick={() => press(digit)}>
              {digit}
            </PadButton>
          ))}
          <PadButton onClick={() => setPin((c) => c.slice(0, -1))}>←</PadButton>
          <PadButton onClick={() => press("0")}>0</PadButton>
          <PadButton onClick={confirm} disabled={pin.length < 4 || checking} primary>
            OK
          </PadButton>
        </div>

        <button
          type="button"
          onClick={() => {
            track("friction", "pin-cancel");
            onCancel();
          }}
          className="mt-5 w-full py-2 text-sm text-ink-soft underline"
        >
          やめる
        </button>
      </div>
    </div>
  );
}

function PadButton({
  children,
  onClick,
  disabled,
  primary,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`h-14 rounded-xl text-xl font-bold transition active:scale-95 disabled:opacity-40 ${
        primary ? "bg-accent text-white" : "bg-paper-deep text-ink"
      }`}
    >
      {children}
    </button>
  );
}
