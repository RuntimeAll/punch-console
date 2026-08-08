"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * 搜索框。用原生 form GET 提交 —— 检索态就该在 URL 里,
 * 手机上刷新、回退、发给自己都不丢。
 */
export function SearchBox({
  defaultValue,
  hidden,
}: {
  defaultValue?: string;
  hidden?: Record<string, string | undefined>;
}) {
  return (
    <form action="/questions" method="get" className="flex gap-2">
      {Object.entries(hidden || {}).map(([k, v]) =>
        v ? <input key={k} type="hidden" name={k} value={v} /> : null,
      )}
      <Input
        name="q"
        defaultValue={defaultValue}
        placeholder="搜题面,或直接说人话:买东西找零的两步应用题"
        className="flex-1"
        autoComplete="off"
      />
      <Button type="submit">搜</Button>
    </form>
  );
}
