// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedCatalogEntry, SharedCatalogPage } from "@mytowncart-billing/connector-mytowncart";
import { SharedCatalogPicker } from "./SharedCatalogPicker";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockSearchSharedCatalog = vi.fn();

vi.mock("../../lib/marketplace", () => ({
  getConnector: () => ({
    searchSharedCatalog: mockSearchSharedCatalog,
  }),
}));

function setInputValue(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  if (nativeSetter) {
    nativeSetter.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("SharedCatalogPicker", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  const renderComponent = async (onSelect = vi.fn()) => {
    await act(async () => {
      root.render(<SharedCatalogPicker onSelect={onSelect} />);
    });
  };

  const sampleEntry: SharedCatalogEntry = {
    id: "cat-1",
    display_name: "Demo Rice 1 kg",
    name: "Demo Rice",
    variant_label: "1 kg",
    barcode: "890000000011",
    product_category: "cat-groceries",
    category_name: "Catalog demo groceries",
    brand_name: "Demo brand",
    description: "Sample pack",
    image: null,
    updated_at: new Date().toISOString(),
  };

  const samplePage: SharedCatalogPage = {
    count: 1,
    next: null,
    results: [sampleEntry],
  };

  it("does not search on initial mount when input is empty", async () => {
    await renderComponent();
    expect(mockSearchSharedCatalog).not.toHaveBeenCalled();
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input).toBeDefined();
    expect(input.value).toBe("");
  });

  it("automatically searches after debounce when typing", async () => {
    mockSearchSharedCatalog.mockResolvedValue(samplePage);
    await renderComponent();

    const input = container.querySelector("input") as HTMLInputElement;

    await act(async () => {
      setInputValue(input, "rice");
    });

    // Before timer fires, search has not been called
    expect(mockSearchSharedCatalog).not.toHaveBeenCalled();

    // Fast-forward past the 300ms debounce
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(mockSearchSharedCatalog).toHaveBeenCalledTimes(1);
    expect(mockSearchSharedCatalog).toHaveBeenCalledWith("rice", 1);

    // Results are rendered
    expect(container.textContent).toContain("Demo Rice 1 kg");
    expect(container.textContent).toContain("890000000011");
    expect(container.textContent).toContain("Use this pack");
  });

  it("debounces rapid keystrokes so only the latest value triggers search", async () => {
    mockSearchSharedCatalog.mockResolvedValue(samplePage);
    await renderComponent();

    const input = container.querySelector("input") as HTMLInputElement;

    await act(async () => {
      setInputValue(input, "r");
    });
    await vi.advanceTimersByTimeAsync(100);

    await act(async () => {
      setInputValue(input, "ri");
    });
    await vi.advanceTimersByTimeAsync(100);

    await act(async () => {
      setInputValue(input, "rice");
    });

    expect(mockSearchSharedCatalog).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(mockSearchSharedCatalog).toHaveBeenCalledTimes(1);
    expect(mockSearchSharedCatalog).toHaveBeenCalledWith("rice", 1);
  });

  it("searches immediately when pressing Enter without waiting for debounce", async () => {
    mockSearchSharedCatalog.mockResolvedValue(samplePage);
    await renderComponent();

    const input = container.querySelector("input") as HTMLInputElement;

    await act(async () => {
      setInputValue(input, "rice");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(mockSearchSharedCatalog).toHaveBeenCalledTimes(1);
    expect(mockSearchSharedCatalog).toHaveBeenCalledWith("rice", 1);

    // Advancing timers should not cause a duplicate search
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(mockSearchSharedCatalog).toHaveBeenCalledTimes(1);
  });

  it("searches immediately when clicking Search button", async () => {
    mockSearchSharedCatalog.mockResolvedValue(samplePage);
    await renderComponent();

    const input = container.querySelector("input") as HTMLInputElement;
    const searchButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Search",
    );

    await act(async () => {
      setInputValue(input, "rice");
      searchButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockSearchSharedCatalog).toHaveBeenCalledTimes(1);
    expect(mockSearchSharedCatalog).toHaveBeenCalledWith("rice", 1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(mockSearchSharedCatalog).toHaveBeenCalledTimes(1);
  });

  it("clears results and does not search when input is erased", async () => {
    mockSearchSharedCatalog.mockResolvedValue(samplePage);
    await renderComponent();

    const input = container.querySelector("input") as HTMLInputElement;

    await act(async () => {
      setInputValue(input, "rice");
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(container.textContent).toContain("Demo Rice 1 kg");

    // Clear input
    await act(async () => {
      setInputValue(input, "");
    });

    expect(container.textContent).not.toContain("Demo Rice 1 kg");
    // Only 1 call was made (for "rice"), clearing does not call search
    expect(mockSearchSharedCatalog).toHaveBeenCalledTimes(1);
  });

  it("calls onSelect when clicking 'Use this pack'", async () => {
    const onSelect = vi.fn().mockResolvedValue(undefined);
    mockSearchSharedCatalog.mockResolvedValue(samplePage);
    await renderComponent(onSelect);

    const input = container.querySelector("input") as HTMLInputElement;

    await act(async () => {
      setInputValue(input, "rice");
      await vi.advanceTimersByTimeAsync(300);
    });

    const useButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Use this pack",
    );
    expect(useButton).toBeDefined();

    await act(async () => {
      useButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(sampleEntry);
  });

  it("displays error message if search fails", async () => {
    mockSearchSharedCatalog.mockRejectedValue(new Error("Network timeout"));
    await renderComponent();

    const input = container.querySelector("input") as HTMLInputElement;

    await act(async () => {
      setInputValue(input, "rice");
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(container.textContent).toContain("Network timeout");
  });

  it("supports pagination when results have next page", async () => {
    const page1: SharedCatalogPage = {
      count: 2,
      next: "http://example.com/catalog/?page=2",
      results: [sampleEntry],
    };
    const page2: SharedCatalogPage = {
      count: 2,
      next: null,
      results: [{ ...sampleEntry, id: "cat-2", display_name: "Demo Rice 5 kg" }],
    };

    mockSearchSharedCatalog.mockResolvedValueOnce(page1);
    await renderComponent();

    const input = container.querySelector("input") as HTMLInputElement;

    await act(async () => {
      setInputValue(input, "rice");
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(container.textContent).toContain("Demo Rice 1 kg");

    const nextButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Next",
    );
    expect(nextButton).toBeDefined();

    mockSearchSharedCatalog.mockResolvedValueOnce(page2);

    await act(async () => {
      nextButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockSearchSharedCatalog).toHaveBeenCalledWith("rice", 2);
    expect(container.textContent).toContain("Demo Rice 5 kg");
  });
});
