// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 KonboiOne
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import isDesktopApp from "@lichtblick/suite-base/util/isDesktopApp";

import BrowserHttpReader from "./BrowserHttpReader";

jest.mock("@lichtblick/suite-base/util/isDesktopApp", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const mockIsDesktop = isDesktopApp as jest.MockedFunction<typeof isDesktopApp>;
const url = "https://example.com/data.mcap";

function rangedResponse(
  init: { status?: number; headers?: Record<string, string>; cancelSpy?: jest.Mock } = {},
): Response {
  const response = new Response(new Uint8Array([0]), {
    status: init.status ?? 206,
    headers: init.headers,
  });
  if (init.cancelSpy) {
    Object.defineProperty(response, "body", {
      value: { cancel: init.cancelSpy },
    });
  }
  return response;
}

describe("BrowserHttpReader", () => {
  let mockFetch: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch = jest.spyOn(global, "fetch");
    mockIsDesktop.mockReturnValue(false);
  });

  afterEach(() => {
    mockFetch.mockRestore();
  });

  describe("open() ranged size probe (fast path)", () => {
    it("resolves size and identifier from Content-Range on a 206 response without a fallback request", async () => {
      mockFetch.mockResolvedValue(
        rangedResponse({
          headers: { "content-range": "bytes 0-0/12345", etag: "abc123" },
        }),
      );

      const reader = new BrowserHttpReader(url);
      const result = await reader.open();

      expect(result).toEqual({ size: 12345, identifier: "abc123" });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        url,
        expect.objectContaining({ headers: { range: "bytes=0-0" }, cache: "no-store" }),
      );
    });

    it("falls back to last-modified when etag is absent", async () => {
      mockFetch.mockResolvedValue(
        rangedResponse({
          headers: { "content-range": "bytes 0-0/999", "last-modified": "Mon, 01 Jan 2026" },
        }),
      );

      const result = await new BrowserHttpReader(url).open();

      expect(result).toEqual({ size: 999, identifier: "Mon, 01 Jan 2026" });
    });

    it("consumes the one-byte body of a successful ranged probe", async () => {
      const response = rangedResponse({ headers: { "content-range": "bytes 0-0/12345" } });
      mockFetch.mockResolvedValue(response);

      await new BrowserHttpReader(url).open();

      expect(response.bodyUsed).toBe(true);
    });
  });

  describe("open() same-origin edge ranges", () => {
    const size = 200;
    const tailBytes = new Uint8Array(100).fill(2);
    const headBytes = new Uint8Array(100).fill(1);

    function edgeResponse(
      data: Uint8Array<ArrayBuffer>,
      contentRange: string,
      etag = "abc",
    ): Response {
      return new Response(data, {
        status: 206,
        headers: { "content-range": contentRange, etag },
      });
    }

    beforeEach(() => {
      Object.defineProperty(globalThis, "location", {
        value: { origin: "https://example.com" },
        configurable: true,
      });
    });

    afterEach(() => {
      Reflect.deleteProperty(globalThis, "location");
    });

    it("returns the size and prefetched head and tail from two parallel ranged requests", async () => {
      // Given a same-origin server answering the tail and head ranges
      mockFetch
        .mockResolvedValueOnce(edgeResponse(tailBytes, `bytes 100-199/${size}`))
        .mockResolvedValueOnce(edgeResponse(headBytes, `bytes 0-99/${size}`));

      // When opening
      const result = await new BrowserHttpReader(url).open();

      // Then the size and both ranges come back without any other request
      expect(result).toEqual({
        size,
        identifier: "abc",
        prefetched: [
          { offset: 100, data: tailBytes },
          { offset: 0, data: headBytes },
        ],
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        url,
        expect.objectContaining({ headers: { range: "bytes=-65536" } }),
      );
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        url,
        expect.objectContaining({ headers: { range: "bytes=0-65535" } }),
      );
    });

    it("drops the head when its identifier differs from the tail", async () => {
      // Given a head response from a different file version
      mockFetch
        .mockResolvedValueOnce(edgeResponse(tailBytes, `bytes 100-199/${size}`, "v1"))
        .mockResolvedValueOnce(edgeResponse(headBytes, `bytes 0-99/${size}`, "v2"));

      // When opening
      const result = await new BrowserHttpReader(url).open();

      // Then only the tail is prefetched
      expect(result.prefetched).toEqual([{ offset: 100, data: tailBytes }]);
    });

    it("falls back to the one-byte probe when the tail request is not a 206", async () => {
      // Given a server that ignores the suffix range
      mockFetch
        .mockResolvedValueOnce(rangedResponse({ status: 200 }))
        .mockResolvedValueOnce(edgeResponse(headBytes, `bytes 0-99/${size}`))
        .mockResolvedValueOnce(
          rangedResponse({ headers: { "content-range": `bytes 0-0/${size}` } }),
        );

      // When opening
      const result = await new BrowserHttpReader(url).open();

      // Then the size comes from the one-byte probe, with nothing prefetched
      expect(result).toEqual({ size, identifier: undefined });
      expect(mockFetch).toHaveBeenLastCalledWith(
        url,
        expect.objectContaining({ headers: { range: "bytes=0-0" } }),
      );
    });

    it("falls back when the tail body is shorter than its Content-Range", async () => {
      // Given a truncated tail response
      mockFetch
        .mockResolvedValueOnce(edgeResponse(new Uint8Array(10), `bytes 100-199/${size}`))
        .mockResolvedValueOnce(edgeResponse(headBytes, `bytes 0-99/${size}`))
        .mockResolvedValueOnce(
          rangedResponse({ headers: { "content-range": `bytes 0-0/${size}` } }),
        );

      // When opening
      const result = await new BrowserHttpReader(url).open();

      // Then the incomplete data is not used
      expect(result.prefetched).toBeUndefined();
      expect(result.size).toBe(size);
    });

    it("uses only the one-byte probe for cross-origin URLs", async () => {
      // Given a URL on another origin
      mockFetch.mockResolvedValueOnce(
        rangedResponse({ headers: { "content-range": `bytes 0-0/${size}` } }),
      );

      // When opening
      await new BrowserHttpReader("https://other.example.org/data.mcap").open();

      // Then no suffix range is requested
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://other.example.org/data.mcap",
        expect.objectContaining({ headers: { range: "bytes=0-0" } }),
      );
    });
  });

  it.each([
    "bytes 0-0/9007199254740992",
    "bytes 9007199254740992-9007199254740992/9007199254740994",
  ])("rejects unsafe byte offsets or file sizes in %s", async (contentRange) => {
    mockFetch
      .mockResolvedValueOnce(rangedResponse({ headers: { "content-range": contentRange } }))
      .mockResolvedValueOnce(
        new Response(null, {
          headers: { "accept-ranges": "bytes", "content-length": "100" },
        }),
      );

    expect(await new BrowserHttpReader(url).open()).toEqual({ size: 100, identifier: undefined });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  describe("open() fallback to full-GET-then-abort probe", () => {
    it("still falls back when cancelling an unusable probe body fails", async () => {
      const cancelSpy = jest.fn().mockRejectedValue(new Error("stream errored"));
      mockFetch
        .mockResolvedValueOnce(rangedResponse({ status: 200, cancelSpy }))
        .mockResolvedValueOnce(
          new Response(null, {
            status: 200,
            headers: { "accept-ranges": "bytes", "content-length": "500" },
          }),
        );

      const result = await new BrowserHttpReader(url).open();

      expect(result.size).toBe(500);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("falls back when the server ignores the Range header (status 200)", async () => {
      const cancelSpy = jest.fn().mockResolvedValue(undefined);
      mockFetch
        .mockResolvedValueOnce(rangedResponse({ status: 200, cancelSpy }))
        .mockResolvedValueOnce(
          new Response(null, {
            status: 200,
            headers: { "accept-ranges": "bytes", "content-length": "500" },
          }),
        );

      const result = await new BrowserHttpReader(url).open();

      expect(result).toEqual({ size: 500, identifier: undefined });
      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("falls back when the 206 response has no Content-Range header", async () => {
      mockFetch.mockResolvedValueOnce(rangedResponse({ headers: {} })).mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { "accept-ranges": "bytes", "content-length": "500" },
        }),
      );

      const result = await new BrowserHttpReader(url).open();

      expect(result.size).toBe(500);
    });

    it("falls back when Content-Range is present but unparsable", async () => {
      mockFetch
        .mockResolvedValueOnce(rangedResponse({ headers: { "content-range": "bytes */*" } }))
        .mockResolvedValueOnce(
          new Response(null, {
            status: 200,
            headers: { "accept-ranges": "bytes", "content-length": "500" },
          }),
        );

      const result = await new BrowserHttpReader(url).open();

      expect(result.size).toBe(500);
    });

    it("falls back when the ranged probe request throws", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { "accept-ranges": "bytes", "content-length": "500" },
        }),
      );

      const result = await new BrowserHttpReader(url).open();

      expect(result.size).toBe(500);
    });
  });

  describe("open() fallback probe error handling (unchanged pre-existing behavior)", () => {
    beforeEach(() => {
      // Every test in this block exercises the fallback path, so make the ranged probe a no-op miss.
      mockFetch.mockResolvedValueOnce(rangedResponse({ status: 200 }));
    });

    it("throws when the fallback fetch itself fails", async () => {
      mockFetch.mockRejectedValueOnce(new Error("boom"));

      await expect(new BrowserHttpReader(url).open()).rejects.toThrow(
        "Fetching remote file failed",
      );
    });

    it("includes a CORS hint in the browser (non-desktop) error message", async () => {
      mockIsDesktop.mockReturnValue(false);
      mockFetch.mockRejectedValueOnce(new Error("boom"));

      await expect(new BrowserHttpReader(url).open()).rejects.toThrow(/CORS/);
    });

    it("throws when the fallback response is not ok", async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));

      await expect(new BrowserHttpReader(url).open()).rejects.toThrow("Status code: 404");
    });

    it("throws when accept-ranges is missing from the fallback response", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 200, headers: { "content-length": "500" } }),
      );

      await expect(new BrowserHttpReader(url).open()).rejects.toThrow(
        "Support for HTTP Range requests was not detected",
      );
    });

    it("throws when content-length is missing from the fallback response", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 200, headers: { "accept-ranges": "bytes" } }),
      );

      await expect(new BrowserHttpReader(url).open()).rejects.toThrow(
        "Remote file is missing file size",
      );
    });
  });

  describe("fetch()", () => {
    it("issues a ranged request for the requested offset/length", () => {
      const reader = new BrowserHttpReader(url);
      const stream = reader.fetch(10, 20);

      expect(stream).toBeDefined();
    });
  });
});

describe("BrowserHttpReader with renewable access", () => {
  const endpoint = "https://records.example.test/api/v1/records/sha256-a/visualization-access";
  const blobUrl = "https://store.blob.core.windows.net/records/payload.mcap?sp=r&sig=secret";

  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, "fetch");
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            url: blobUrl,
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: {
            "accept-ranges": "bytes",
            "content-length": "100",
            etag: '"version-1"',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2]), {
          status: 206,
          headers: { "content-range": "bytes 10-11/100" },
        }),
      );
  });

  afterEach(() => {
    fetchMock.mockRestore();
    Reflect.deleteProperty(globalThis, "location");
  });

  it.each([
    "https://records.example.test",
    "https://viewer.example.test",
  ])("opens the Blob with HEAD and pins subsequent ranges to its ETag from %s", async (origin) => {
    Object.defineProperty(globalThis, "location", { value: { origin }, configurable: true });
    const reader = new BrowserHttpReader(endpoint, { refreshAccess: true });
    expect(await reader.open()).toEqual({
      size: 100,
      identifier: '"version-1"',
    });

    const stream = reader.fetch(10, 2);
    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, endpoint, {
      cache: "no-store",
    });
    expect(fetchMock.mock.calls[1]![0]).toBe(blobUrl);
    expect(fetchMock.mock.calls[1]![1].method).toBe("HEAD");
    expect(fetchMock.mock.calls[2]![0]).toBe(blobUrl);
    expect(fetchMock.mock.calls[2]![1].headers.get("range")).toBe("bytes=10-11");
    expect(fetchMock.mock.calls[2]![1].headers.get("if-match")).toBe('"version-1"');
  });
});

it("splits a large Records Ingestor read into parallel ordered ranges", async () => {
  const endpoint = "https://records.example.test/api/v1/records/sha256-a/visualization-access";
  const payload =
    "https://records.example.test/api/v1/records/sha256-a/visualization-payload?sp=r&sr=b&spr=https&sig=secret";
  const size = 24 * 1024 * 1024;
  const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (requestUrl, options) => {
    if (requestUrl === endpoint) {
      return new Response(
        JSON.stringify({ url: payload, expiresAt: new Date(Date.now() + 300_000).toISOString() }),
      );
    }
    if (options?.method === "HEAD") {
      return new Response(null, {
        headers: { "accept-ranges": "bytes", "content-length": String(size) },
      });
    }
    const range = new Headers(options?.headers).get("range")!;
    const [first, last] = range.slice(6).split("-").map(Number) as [number, number];
    return new Response(new Uint8Array(last - first + 1), {
      status: 206,
      headers: { "content-range": `bytes ${first}-${last}/${size}` },
    });
  });

  try {
    const reader = new BrowserHttpReader(endpoint, { refreshAccess: true });
    await reader.open();
    const stream = reader.fetch(0, size);
    const lengths: number[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Uint8Array) => lengths.push(chunk.byteLength));
      stream.on("end", resolve);
      stream.on("error", reject);
    });

    expect(lengths).toEqual([8 * 1024 * 1024, 8 * 1024 * 1024, 8 * 1024 * 1024]);
    expect(
      fetchMock.mock.calls
        .slice(2)
        .map(([, options]) => new Headers(options?.headers).get("range")),
    ).toEqual(["bytes=0-8388607", "bytes=8388608-16777215", "bytes=16777216-25165823"]);
  } finally {
    fetchMock.mockRestore();
  }
});

it("rejects a mismatched Content-Range on a small Records Ingestor read", async () => {
  const endpoint = "https://records.example.test/api/v1/records/sha256-a/visualization-access";
  const payload = "https://store.blob.core.windows.net/records/payload.mcap?sp=r&sig=secret";
  const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (requestUrl, options) => {
    if (requestUrl === endpoint) {
      return new Response(
        JSON.stringify({ url: payload, expiresAt: new Date(Date.now() + 300_000).toISOString() }),
      );
    }
    if (options?.method === "HEAD") {
      return new Response(null, { headers: { "accept-ranges": "bytes", "content-length": "100" } });
    }
    return new Response(new Uint8Array([1, 2]), {
      status: 206,
      headers: { "content-range": "bytes 0-1/100" },
    });
  });
  try {
    const reader = new BrowserHttpReader(endpoint, { refreshAccess: true });
    await reader.open();
    const stream = reader.fetch(10, 2);
    await expect(
      new Promise<void>((resolve, reject) => {
        stream.on("end", resolve);
        stream.on("error", reject);
      }),
    ).rejects.toThrow("Invalid parallel range response");
  } finally {
    fetchMock.mockRestore();
  }
});

it.each([
  "https://example.com",
  "https://other.example.org",
])("pins ordinary remote ranges to the ETag after opening from %s", async (origin) => {
  Object.defineProperty(globalThis, "location", { value: { origin }, configurable: true });
  const mockFetch = jest.spyOn(global, "fetch").mockImplementation(async (_url, options) => {
    const range = new Headers(options?.headers).get("range");
    const [start, end] =
      range === "bytes=0-0" ? [0, 0] : range === "bytes=10-11" ? [10, 11] : [0, 99];
    return new Response(new Uint8Array(end - start + 1), {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/100`, etag: '"version-1"' },
    });
  });

  try {
    const reader = new BrowserHttpReader(url);
    await reader.open();
    const stream = reader.fetch(10, 2);
    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
    });

    const options = mockFetch.mock.calls.at(-1)![1];
    expect(new Headers(options?.headers).get("if-match")).toBe('"version-1"');
  } finally {
    mockFetch.mockRestore();
    Reflect.deleteProperty(globalThis, "location");
  }
});
