// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// jsdom replaces the global URL class, which node:fs rejects -> use plain paths.
const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "data");

describe.skipIf(!existsSync(join(dataDir, "core.json")))("UI smoke (real data, jsdom)", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", async (path: string) => {
      const file = join(dataDir, String(path).replace(/^data\//, ""));
      if (!existsSync(file)) return { ok: false, status: 404, json: async () => null };
      const body = JSON.parse(readFileSync(file, "utf8"));
      return { ok: true, status: 200, json: async () => body };
    });
  });
  afterEach(() => { cleanup(); localStorage.clear(); });

  it("browse 10105, pin a keyword, create preset, switching language keeps preset content", async () => {
    render(<App />);
    const search = await screen.findByPlaceholderText("搜索名称 / ID", {}, { timeout: 10000 });
    fireEvent.change(search, { target: { value: "10105" } });
    fireEvent.click(await within(document.querySelector(".id-list") as HTMLElement).findByText("李箱"));
    expect(await screen.findByText("沉着冷静")).toBeTruthy();
    expect(screen.getByText("咬紧臼齿")).toBeTruthy();
    expect(screen.getByText("越到此等时刻…")).toBeTruthy();

    // keyword chip -> pinned card
    const vib = screen.getAllByRole("button", { name: "震颤" })[0]!;
    fireEvent.click(vib);
    const pinned = document.querySelector(".pinned") as HTMLElement;
    expect(within(pinned).getByText("Vibration")).toBeTruthy();

    // editor
    fireEvent.click(screen.getByRole("button", { name: "技能组配置" }));
    fireEvent.click(screen.getByRole("button", { name: "按当前人格新建" }));
    expect(await screen.findByText("基础技能区")).toBeTruthy();
    expect(screen.getByText("配置有效")).toBeTruthy();
    const tables = document.querySelectorAll("table.coins");
    expect([...tables].map((t) => t.querySelectorAll("tbody tr").length)).toEqual([2, 1, 3]);

    // add a DOT on S1 coin 1
    const addDot = within(tables[0] as HTMLElement).getAllByRole("combobox")[0]!;
    fireEvent.change(addDot, { target: { value: "Combustion" } });
    const dotTag = () => (tables[0] as HTMLElement).querySelector(".dot-row .tag")?.textContent;
    expect(dotTag()).toBe("烧伤");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    const savedZh = JSON.parse(localStorage.getItem("lcalc.presets.v1")!);
    const id = savedZh.order[0];

    // switch translation pack -> labels change, stored preset text does not
    const packSelect = document.querySelector(".pack select") as HTMLSelectElement;
    await act(async () => { fireEvent.change(packSelect, { target: { value: "en" } }); });
    await waitFor(() => expect((document.querySelector("table.coins") as HTMLElement).querySelector(".dot-row .tag")?.textContent).toBe("Burn"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    const savedEn = JSON.parse(localStorage.getItem("lcalc.presets.v1")!);
    expect(savedEn.presets[id]).toBe(savedZh.presets[id]);
            expect(savedEn.presets[id]).toContain('"Combustion"');

    // result tab renders verified damage breakdown and gaps
    fireEvent.click(screen.getByRole("button", { name: "场景与结果" }));
    expect(await screen.findByText(/结果总览/)).toBeTruthy();
    expect(screen.getByText(/各技能项伤害明细/)).toBeTruthy();
  }, 30000);
});
