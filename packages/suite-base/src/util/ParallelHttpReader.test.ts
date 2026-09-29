// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 KonboiOne
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import ParallelHttpReader, { PARALLEL_RANGE_BYTES } from "./ParallelHttpReader";

const tick = async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};
const access = () => ({
  url: jest.fn(async () => "https://records.example.test/payload?sig=first"),
  refresh: jest.fn(async () => "https://records.example.test/payload?sig=renewed"),
});

async function finished(reader: ParallelHttpReader): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    reader.on("end", resolve);
    reader.on("error", reject);
  });
}

describe("ParallelHttpReader", () => {
  it("emits completed ranges in byte order, including an exact final partial range", async () => {
    const size = 2 * PARALLEL_RANGE_BYTES + 3;
    const pending: Array<{ range: string; resolve: (response: Response) => void }> = [];
    const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (_url, options) => {
      return await new Promise<Response>((resolve) => {
        pending.push({ range: new Headers(options?.headers).get("range")!, resolve });
      });
    });
    const reader = new ParallelHttpReader(access(), 0, size, { size });
    const chunks: Array<{ size: number; first: number }> = [];
    reader.on("data", (chunk) => chunks.push({ size: chunk.byteLength, first: chunk[0]! }));
    const done = finished(reader);
    reader.read();
    await tick();
    expect(pending.map((item) => item.range)).toEqual([
      "bytes=0-8388607",
      "bytes=8388608-16777215",
      "bytes=16777216-16777218",
    ]);

    const reply = (index: number, length: number) => {
      pending[index]!.resolve(
        new Response(new Uint8Array(length).fill(index + 1), {
          status: 206,
          headers: { "content-range": `${pending[index]!.range.replace("=", " ")}/${size}` },
        }),
      );
    };
    reply(1, PARALLEL_RANGE_BYTES);
    await tick();
    expect(chunks).toEqual([]);
    reply(0, PARALLEL_RANGE_BYTES);
    reply(2, 3);
    await done;
    expect(chunks).toEqual([
      { size: PARALLEL_RANGE_BYTES, first: 1 },
      { size: PARALLEL_RANGE_BYTES, first: 2 },
      { size: 3, first: 3 },
    ]);
    fetchMock.mockRestore();
  });

  it("limits the window to sixteen ranges and cancels every request on destroy", async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (_url, options) => {
      const signal = options!.signal!;
      signals.push(signal);
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            reject(new DOMException("Cancelled", "AbortError"));
          },
          { once: true },
        );
      });
    });
    const size = 17 * PARALLEL_RANGE_BYTES;
    const reader = new ParallelHttpReader(access(), 0, size, { size });
    const event = jest.fn();
    reader.on("data", event);
    reader.on("error", event);
    reader.on("end", event);
    reader.read();
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(16);
    reader.destroy();
    await tick();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(16);
    expect(event).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it.each([
    [200, "bytes 10-11/100", [1, 2]],
    [412, "bytes 10-11/100", []],
    [206, "bytes 0-1/100", [1, 2]],
    [206, "bytes 10-11/101", [1, 2]],
    [206, "bytes 10-11/100", [1]],
    [206, "bytes 10-11/100", [1, 2, 3]],
  ])("rejects invalid or incomplete range responses (%s, %s, %s)", async (status, range, bytes) => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response(new Uint8Array(bytes), { status, headers: { "content-range": range } }),
      );
    const reader = new ParallelHttpReader(access(), 10, 2, { size: 100 });
    const done = finished(reader);
    reader.read();
    await expect(done).rejects.toThrow(/range response/);
    fetchMock.mockRestore();
  });

  it.each([
    [-1, 1],
    [0, 0],
    [99, 2],
    [Number.MAX_SAFE_INTEGER, 2],
  ])("rejects invalid input before starting a request (%s, %s)", async (offset, length) => {
    const fetchMock = jest.spyOn(global, "fetch");
    const reader = new ParallelHttpReader(access(), offset, length, { size: 100 });
    const done = finished(reader);
    reader.read();
    await expect(done).rejects.toThrow("Invalid parallel byte range");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("renews an expired SAS once and keeps the range and ETag", async () => {
    const urls = access();
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2]), {
          status: 206,
          headers: { "content-range": "bytes 10-11/100" },
        }),
      );
    const reader = new ParallelHttpReader(urls, 10, 2, { size: 100, etag: '"version-1"' });
    const done = finished(reader);
    reader.read();
    await done;
    expect(urls.refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://records.example.test/payload?sig=first",
      "https://records.example.test/payload?sig=renewed",
    ]);
    for (const [, options] of fetchMock.mock.calls) {
      expect(new Headers(options?.headers).get("range")).toBe("bytes=10-11");
      expect(new Headers(options?.headers).get("if-match")).toBe('"version-1"');
    }
    fetchMock.mockRestore();
  });
});
