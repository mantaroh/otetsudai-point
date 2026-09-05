import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

export const bootstrapKey = ["bootstrap"] as const;
export const meKey = ["me"] as const;

/**
 * 起動時の一括取得。
 *
 * リアルタイム同期(WebSocket)は入れていない。
 * 「親が外出先で貼ったシールが、リビングのタブレットに数秒で出る」程度で困らないので、
 * 画面が前面に戻ったときの再取得と、ゆるいポーリングで足りる。
 */
export function useBootstrap() {
  return useQuery({
    queryKey: bootstrapKey,
    queryFn: api.bootstrap,
    retry: false,
    staleTime: 5_000,
    // まだ一度も取れていない(未ログイン・家庭が無い)あいだは、再取得しない。
    // 更新すべき台帳がそもそも無いうえ、再取得のたびに画面を作り直すことになり、
    // はじめの設定を入力している最中に内容が消えてしまう。
    refetchInterval: (query) => (query.state.data ? 15_000 : false),
    refetchOnWindowFocus: (query) => query.state.data !== undefined,
  });
}

export function useMe() {
  return useQuery({ queryKey: meKey, queryFn: api.me, retry: false });
}

export function useRefreshBootstrap() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: bootstrapKey });
}
