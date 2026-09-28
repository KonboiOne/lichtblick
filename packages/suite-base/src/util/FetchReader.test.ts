// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { globalRequestQueue } from "@lichtblick/suite-base/util/RequestQueue";
import { BasicBuilder } from "@lichtblick/test-builders";

import FetchReader from "./FetchReader";

// Mock the global request queue
jest.mock("@lichtblick/suite-base/util/RequestQueue", () => ({
  globalRequestQueue: {
    run: jest.fn(),
  },
}));

const mockGlobalRequestQueue = globalRequestQueue as jest.Mocked<typeof globalRequestQueue>;
const url = "https://example.com/data.mcap";

describe("FetchReader", () => {
  let mockFetch: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch = jest.spyOn(global, "fetch");

    // Default: globalRequestQueue.run passes through the function
    mockGlobalRequestQueue.run.mockImplementation(async (fn) => fn);
  });

  afterEach(() => {
    mockFetch.mockRestore();
  });

  describe("constructor and fetch queueing", () => {
    it("passes options and abort signal to fetch when queued request executes", async () => {
      const options: RequestInit = {
        headers: { "Custom-Header": BasicBuilder.string() },
        method: "GET",
      };

      const mockResponse = new Response(new ReadableStream(), { status: 200 });
      mockFetch.mockResolvedValue(mockResponse);

      const reader = new FetchReader(url, options);

      // Execute the queued fetch
      const queuedFn = mockGlobalRequestQueue.run.mock.calls[0]![0];
      await queuedFn();

      expect(mockFetch).toHaveBeenCalledWith(url, {
        ...options,
        signal: expect.any(AbortSignal),
      });

      reader.destroy();
    });

    it("queues fetch request through globalRequestQueue", () => {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const runGlobalRequestQueueMock = mockGlobalRequestQueue.run;
      new FetchReader(url);

      // Verify fetch is queued, not called directly
      expect(runGlobalRequestQueueMock).toHaveBeenCalledTimes(1);
      expect(runGlobalRequestQueueMock).toHaveBeenCalledWith(expect.any(Function));
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("refreshes an expired credential and retries the same range once", async () => {
      mockFetch
        .mockResolvedValueOnce(new Response(null, { status: 403 }))
        .mockResolvedValueOnce(new Response(new ReadableStream(), { status: 206 }));

      const provider = {
        url: jest.fn().mockResolvedValue("https://store.blob.core.windows.net/file.mcap?sig=old"),
        refresh: jest
          .fn()
          .mockResolvedValue("https://store.blob.core.windows.net/file.mcap?sig=new"),
      };
      const options = { headers: { Range: "bytes=10-20" } };
      const reader = new FetchReader(provider, options);
      const queuedFn = mockGlobalRequestQueue.run.mock.calls[0]![0];

      expect((await queuedFn()).status).toBe(206);
      expect(provider.refresh).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenNthCalledWith(1, expect.stringContaining("sig=old"), {
        ...options,
        signal: expect.any(AbortSignal),
      });
      expect(mockFetch).toHaveBeenNthCalledWith(2, expect.stringContaining("sig=new"), {
        ...options,
        signal: expect.any(AbortSignal),
      });

      reader.destroy();
    });
  });
});
