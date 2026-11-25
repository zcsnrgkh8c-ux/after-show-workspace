/**
 * 地点搜索必须有界返回：
 * 高德 AutoComplete 偶发不回调时，不能永远停在“搜索中…”；
 * 超时/异常都要解析为 status=error，交给编排层停止搜索态并给出可见提示。
 */
import { describe, expect, it } from "vitest";
import type { AMapNamespace } from "../vendor/types";
import { searchPlaces } from "./places";

function fakeAmap(search: (kw: string, cb: (status: unknown, result: unknown) => void) => void): AMapNamespace {
  const AutoComplete = function () {
    return { search };
  };
  return { AutoComplete } as unknown as AMapNamespace;
}

describe("searchPlaces：超时与失败出口", () => {
  it("AutoComplete 永不回调 → 超时返回 error，不无限等待", async () => {
    const started = Date.now();
    const out = await searchPlaces({
      keyword: "华东交通大学",
      city: "南昌市",
      request_seq: 7,
      amap: fakeAmap(() => {}),
      timeout_ms: 60,
    });
    expect(out.status).toBe("error");
    if (out.status === "error") {
      expect(out.error_code).toBe("timeout");
      expect(out.request_seq).toBe(7);
      expect(out.message).toContain("超时");
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("正常回调 → ok，且不会在超时后重复结算", async () => {
    const out = await searchPlaces({
      keyword: "南昌站",
      city: null,
      request_seq: 1,
      amap: fakeAmap((_kw, cb) => cb("complete", { tips: [{ name: "南昌站", location: [115.9, 28.6] }] })),
      timeout_ms: 50,
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(out.status).toBe("ok");
    if (out.status === "ok") expect(out.suggestions[0].label).toBe("南昌站");
  });

  it("构造/调用同步抛错 → provider_error", async () => {
    const out = await searchPlaces({
      keyword: "南昌站",
      city: null,
      request_seq: 2,
      amap: fakeAmap(() => {
        throw new Error("boom");
      }),
    });
    expect(out.status).toBe("error");
    if (out.status === "error") expect(out.error_code).toBe("provider_error");
  });
});
