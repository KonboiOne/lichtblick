// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 KonboiOne
// SPDX-License-Identifier: MPL-2.0

import { EventEmitter } from "eventemitter3";

import type { FileReader, FileStream } from "./CachedFilelike.types";
import PrefetchingFilelike from "./PrefetchingFilelike";

const tick = async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

function fixture(cacheSizeInBytes = 64) {
  const requests: Array<{
    offset: number;
    length: number;
    stream: EventEmitter;
    destroy: jest.Mock;
  }> = [];
  const open = jest.fn(async () => ({ size: 1000 }));
  const fileReader: FileReader = {
    open,
    fetch: jest.fn((offset, length): FileStream => {
      const stream = new EventEmitter();
      const destroy = jest.fn();
      requests.push({ offset, length, stream, destroy });
      return { on: stream.on.bind(stream), destroy };
    }),
  };
  const reader = new PrefetchingFilelike({ fileReader, cacheSizeInBytes });
  const reply = (index: number, length = requests[index]!.length) => {
    const request = requests[index]!;
    request.stream.emit(
      "data",
      Uint8Array.from({ length }, (_, i) => request.offset + i),
    );
    request.stream.emit("end");
  };
  return { reader, fileReader, requests, reply, open };
}

describe("PrefetchingFilelike", () => {
  it("prefetches separate ranges together and reuses a range for payload and index reads", async () => {
    const { reader, requests, reply } = fixture();
    await reader.open();
    reader.prefetch([
      { start: 0, end: 8 },
      { start: 16, end: 24 },
    ]);
    await tick();
    expect(requests.map(({ offset, length }) => [offset, length])).toEqual([
      [0, 8],
      [16, 8],
    ]);

    const read = reader.read(19, 2);
    reply(1);
    await expect(read).resolves.toEqual(new Uint8Array([19, 20]));
    await expect(reader.read(16, 3)).resolves.toEqual(new Uint8Array([16, 17, 18]));
    expect(requests).toHaveLength(2);
    reply(0);
    reader.close();
  });

  it("bounds speculative bytes and advances the window when the consumer moves", async () => {
    const { reader, requests, reply } = fixture(16);
    await reader.open();
    reader.prefetch(Array.from({ length: 20 }, (_, i) => ({ start: i * 4, end: i * 4 + 4 })));
    await tick();
    expect(requests).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      reply(i);
    }
    await tick();
    expect(requests).toHaveLength(4);

    await expect(reader.read(4, 1)).resolves.toEqual(new Uint8Array([4]));
    await tick();
    expect(requests).toHaveLength(5);
    expect(requests[4]!.offset).toBe(16);
    reader.close();
  });

  it("limits active range reads to sixteen", async () => {
    const { reader, requests } = fixture(1000);
    await reader.open();
    reader.prefetch(Array.from({ length: 30 }, (_, i) => ({ start: i * 4, end: i * 4 + 4 })));
    await tick();
    expect(requests).toHaveLength(16);
    reader.close();
    await tick();
    expect(requests.every(({ destroy }) => destroy.mock.calls.length === 1)).toBe(true);
    expect(requests).toHaveLength(16);
  });

  it("keeps completed ranges when a prefetch session ends", async () => {
    const { reader, requests, reply } = fixture();
    await reader.open();
    const stop = reader.prefetch([
      { start: 0, end: 8 },
      { start: 16, end: 24 },
    ]);
    await tick();
    reply(1);
    await tick();
    stop();
    await expect(reader.read(19, 2)).resolves.toEqual(new Uint8Array([19, 20]));
    expect(requests).toHaveLength(2);
    expect(requests[0]!.destroy).toHaveBeenCalledTimes(1);
    reader.close();
  });

  it("rejects incomplete reads without retrying speculative requests forever", async () => {
    const { reader, requests, reply } = fixture();
    await reader.open();
    reader.prefetch([{ start: 0, end: 8 }]);
    const read = reader.read(0, 8);
    await tick();
    reply(0, 7);
    await expect(read).rejects.toThrow("ended early");
    await tick();
    expect(requests).toHaveLength(1);
    reader.close();
  });

  it("rejects pending and future reads on close and ignores late data", async () => {
    const { reader, requests, reply } = fixture();
    const read = reader.read(0, 8);
    await tick();
    reader.close();
    await expect(read).rejects.toThrow("closed");
    reply(0);
    await expect(reader.read(0, 1)).rejects.toThrow("closed");
    expect(requests).toHaveLength(1);
  });

  it("keeps the current plan when an older iterator stops", async () => {
    const { reader, requests, reply } = fixture();
    await reader.open();
    const oldStop = reader.prefetch([{ start: 0, end: 8 }]);
    await tick();
    const stop = reader.prefetch([{ start: 16, end: 24 }]);
    oldStop();
    await tick();
    expect(requests[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(requests[1]!.destroy).not.toHaveBeenCalled();
    reply(1);
    await expect(reader.read(16, 8)).resolves.toHaveLength(8);
    stop();
    reader.close();
  });

  it("does not cancel a range that a consumer still needs", async () => {
    const { reader, requests, reply } = fixture();
    await reader.open();
    const stop = reader.prefetch([{ start: 0, end: 8 }]);
    const read = reader.read(0, 8);
    await tick();
    stop();
    expect(requests[0]!.destroy).not.toHaveBeenCalled();
    reply(0);
    await expect(read).resolves.toHaveLength(8);
    reader.close();
  });

  it("rejects oversized range bodies", async () => {
    const { reader, reply } = fixture();
    const read = reader.read(0, 8);
    await tick();
    reply(0, 9);
    await expect(read).rejects.toThrow("exceeds requested length");
    reader.close();
  });

  it("opens the underlying reader once and does not fetch empty reads", async () => {
    const { reader, open, requests } = fixture();
    await Promise.all([reader.open(), reader.open(), reader.read(0, 0)]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(0);
    reader.close();
  });

  it("keeps overlapping ranges with the same start independently", async () => {
    const { reader, reply } = fixture();
    await reader.open();
    reader.prefetch([{ start: 0, end: 8 }]);
    const large = reader.read(0, 12);
    void large.catch(() => undefined);
    await tick();
    reply(0);
    await tick();
    try {
      const small = reader.read(0, 4);
      void small.catch(() => undefined);
      expect(await Promise.race([small.then(() => true), tick().then(() => false)])).toBe(true);
      await expect(small).resolves.toEqual(new Uint8Array([0, 1, 2, 3]));
    } finally {
      reader.close();
    }
    await expect(large).rejects.toThrow("closed");
  });

  it.each([
    [-1, 1],
    [0, -1],
    [999, 2],
    [Number.MAX_SAFE_INTEGER, 2],
    [0.5, 1],
  ])("rejects an invalid range before making a request (%s, %s)", async (offset, length) => {
    const { reader, requests } = fixture();
    await expect(reader.read(offset, length)).rejects.toThrow("Invalid byte range");
    expect(requests).toHaveLength(0);
    reader.close();
  });
});
