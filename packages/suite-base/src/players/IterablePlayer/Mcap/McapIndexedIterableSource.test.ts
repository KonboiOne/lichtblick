// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { McapIndexedReader, McapWriter, TempBuffer } from "@mcap/core";
import { Blob } from "node:buffer";

import { loadDecompressHandlers } from "@lichtblick/mcap-support";
import { BlobReadable } from "@lichtblick/suite-base/players/IterablePlayer/Mcap/BlobReadable";
import { McapIndexedIterableSource } from "@lichtblick/suite-base/players/IterablePlayer/Mcap/McapIndexedIterableSource";

describe("McapIndexedIterableSource", () => {
  it("preserves indexed messages and stops prefetch when an iterator is cancelled", async () => {
    const tempBuffer = new TempBuffer();
    const writer = new McapWriter({ writable: tempBuffer, chunkSize: 1 });
    await writer.start({ library: "", profile: "ros1" });
    const schemaId = await writer.registerSchema({
      name: "std_msgs/String",
      encoding: "ros1msg",
      data: new TextEncoder().encode("string data"),
    });
    const camera = await writer.registerChannel({
      topic: "camera",
      schemaId,
      messageEncoding: "ros1",
      metadata: new Map(),
    });
    const other = await writer.registerChannel({
      topic: "other",
      schemaId,
      messageEncoding: "ros1",
      metadata: new Map(),
    });
    for (let sequence = 0; sequence < 4; sequence++) {
      await writer.addMessage({
        channelId: sequence % 2 === 0 ? camera : other,
        logTime: BigInt(sequence) * 1_000_000_000n,
        publishTime: BigInt(sequence) * 1_000_000_000n,
        sequence,
        data: new Uint8Array([sequence]),
      });
    }
    await writer.end();

    const readable = new BlobReadable(new Blob([tempBuffer.get()]) as unknown as globalThis.Blob);
    const reader = await McapIndexedReader.Initialize({ readable });
    const stop = jest.fn();
    const prefetch = jest.fn(() => stop);
    const source = new McapIndexedIterableSource(reader, prefetch);
    await source.initialize();
    const topics = new Map([["camera", { topic: "camera" }]]);
    const iterator = source.messageIterator({ topics });
    expect((await iterator.next()).value).toMatchObject({
      type: "message-event",
      msgEvent: { topic: "camera", message: new Uint8Array([0]) },
    });
    expect(stop).not.toHaveBeenCalled();
    await iterator.return?.(undefined);
    expect(stop).toHaveBeenCalledTimes(1);

    const messages = [];
    for await (const message of source.messageIterator({ topics })) {
      messages.push(message);
    }
    expect(messages).toMatchObject([
      { type: "message-event", msgEvent: { message: new Uint8Array([0]) } },
      { type: "message-event", msgEvent: { message: new Uint8Array([2]) } },
    ]);
    expect(prefetch).toHaveBeenCalledWith([expect.anything(), expect.anything()]);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("returns the correct metadata", async () => {
    const tempBuffer = new TempBuffer();

    const writer = new McapWriter({ writable: tempBuffer, startChannelId: 1 });
    await writer.start({ library: "", profile: "" });
    await writer.registerSchema({
      data: new Uint8Array(),
      encoding: "test",
      name: "test",
    });
    await writer.registerChannel({
      messageEncoding: "1",
      schemaId: 1,
      metadata: new Map(),
      topic: "test",
    });
    await writer.addMessage({
      channelId: 1,
      data: new Uint8Array(),
      logTime: 0n,
      publishTime: 0n,
      sequence: 1,
    });
    await writer.addMetadata({
      name: "metadata1",
      metadata: new Map(Object.entries({ key: "value" })),
    });
    await writer.end();

    const readable = new BlobReadable(new Blob([tempBuffer.get()]) as unknown as globalThis.Blob);
    const decompressHandlers = await loadDecompressHandlers();
    const reader = await McapIndexedReader.Initialize({ readable, decompressHandlers });

    const source = new McapIndexedIterableSource(reader);

    const { metadata } = await source.initialize();

    expect(metadata).toBeDefined();
    expect(metadata).toEqual([
      {
        name: "metadata1",
        metadata: { key: "value" },
      },
    ]);
  });

  it("returns an empty array when no metadata is on the file", async () => {
    const tempBuffer = new TempBuffer();

    const writer = new McapWriter({ writable: tempBuffer, startChannelId: 1 });
    await writer.start({ library: "", profile: "" });
    await writer.registerSchema({
      data: new Uint8Array(),
      encoding: "test",
      name: "test",
    });
    await writer.registerChannel({
      messageEncoding: "1",
      schemaId: 1,
      metadata: new Map(),
      topic: "test",
    });
    await writer.addMessage({
      channelId: 1,
      data: new Uint8Array(),
      logTime: 0n,
      publishTime: 0n,
      sequence: 1,
    });
    await writer.end();

    const readable = new BlobReadable(new Blob([tempBuffer.get()]) as unknown as globalThis.Blob);
    const decompressHandlers = await loadDecompressHandlers();
    const reader = await McapIndexedReader.Initialize({ readable, decompressHandlers });

    const source = new McapIndexedIterableSource(reader);

    const { metadata } = await source.initialize();

    expect(metadata).toBeDefined();
    expect(metadata).toEqual([]);
  });

  it("returns topicStats with numMessages and global start/end times separately", async () => {
    const tempBuffer = new TempBuffer();

    const writer = new McapWriter({
      writable: tempBuffer,
      startChannelId: 1,
      useStatistics: true, // Enable statistics so channelMessageCounts is populated
    });
    await writer.start({ library: "", profile: "" });
    await writer.registerSchema({
      data: new TextEncoder().encode("string data"),
      encoding: "ros1msg",
      name: "std_msgs/String",
    });
    await writer.registerChannel({
      messageEncoding: "ros1",
      schemaId: 1,
      metadata: new Map(),
      topic: "test",
    });
    // Add messages with specific timestamps
    await writer.addMessage({
      channelId: 1,
      data: new Uint8Array(),
      logTime: 1000000000n, // 1 second
      publishTime: 1000000000n,
      sequence: 1,
    });
    await writer.addMessage({
      channelId: 1,
      data: new Uint8Array(),
      logTime: 5000000000n, // 5 seconds
      publishTime: 5000000000n,
      sequence: 2,
    });
    await writer.end();

    const readable = new BlobReadable(new Blob([tempBuffer.get()]) as unknown as globalThis.Blob);
    const decompressHandlers = await loadDecompressHandlers();
    const reader = await McapIndexedReader.Initialize({ readable, decompressHandlers });

    const source = new McapIndexedIterableSource(reader);

    const { topicStats, start, end } = await source.initialize();

    expect(topicStats).toBeDefined();
    const testTopicStats = topicStats.get("test");
    expect(testTopicStats).toBeDefined();
    // topicStats only contains numMessages (MCAP footer doesn't have per-topic time boundaries)
    expect(testTopicStats?.numMessages).toBe(2);
    expect(testTopicStats?.firstMessageTime).toBeUndefined();
    expect(testTopicStats?.lastMessageTime).toBeUndefined();
    // Global start/end times are exposed separately via Initialization
    expect(start).toEqual({ sec: 1, nsec: 0 });
    expect(end).toEqual({ sec: 5, nsec: 0 });
  });

  describe("getEnd", () => {
    it("should return undefined before initialization", async () => {
      // Given an indexed source that has not been initialized
      const tempBuffer = new TempBuffer();
      const writer = new McapWriter({ writable: tempBuffer, startChannelId: 1 });
      await writer.start({ library: "", profile: "" });
      await writer.registerSchema({
        data: new Uint8Array(),
        encoding: "test",
        name: "test",
      });
      await writer.registerChannel({
        messageEncoding: "1",
        schemaId: 1,
        metadata: new Map(),
        topic: "test",
      });
      await writer.addMessage({
        channelId: 1,
        data: new Uint8Array(),
        logTime: 0n,
        publishTime: 0n,
        sequence: 1,
      });
      await writer.end();

      const readable = new BlobReadable(new Blob([tempBuffer.get()]) as unknown as globalThis.Blob);
      const decompressHandlers = await loadDecompressHandlers();
      const reader = await McapIndexedReader.Initialize({ readable, decompressHandlers });
      const source = new McapIndexedIterableSource(reader);

      // When calling getEnd before initialize
      // Then it should return undefined
      expect(source.getEnd()).toBeUndefined();
    });

    it("should return the latest message end time after initialization", async () => {
      // Given an indexed MCAP with messages spanning from 2s to 10s
      const tempBuffer = new TempBuffer();
      const writer = new McapWriter({ writable: tempBuffer, startChannelId: 1 });
      await writer.start({ library: "", profile: "" });
      await writer.registerSchema({
        data: new Uint8Array(),
        encoding: "test",
        name: "test",
      });
      await writer.registerChannel({
        messageEncoding: "1",
        schemaId: 1,
        metadata: new Map(),
        topic: "test",
      });
      await writer.addMessage({
        channelId: 1,
        data: new Uint8Array(),
        logTime: 2_000_000_000n,
        publishTime: 0n,
        sequence: 1,
      });
      await writer.addMessage({
        channelId: 1,
        data: new Uint8Array(),
        logTime: 10_000_000_000n,
        publishTime: 0n,
        sequence: 2,
      });
      await writer.end();

      const readable = new BlobReadable(new Blob([tempBuffer.get()]) as unknown as globalThis.Blob);
      const decompressHandlers = await loadDecompressHandlers();
      const reader = await McapIndexedReader.Initialize({ readable, decompressHandlers });
      const source = new McapIndexedIterableSource(reader);

      // When initializing and calling getEnd
      await source.initialize();

      // Then getEnd should return the latest message time
      expect(source.getEnd()).toEqual({ sec: 10, nsec: 0 });
    });
  });
});

it("prefetches only selected-topic chunks in the requested time window and releases the session", async () => {
  const stop = jest.fn();
  const prefetch = jest.fn(() => stop);
  const chunk = (offset: bigint, time: bigint, channel: number) => ({
    chunkStartOffset: offset,
    chunkLength: 8n,
    messageIndexLength: 2n,
    messageStartTime: time,
    messageEndTime: time + 100n,
    messageIndexOffsets: new Map([[channel, offset + 10n]]),
  });
  const reader = {
    channelsById: new Map([
      [1, { topic: "camera" }],
      [2, { topic: "unused" }],
    ]),
    chunkIndexes: [
      chunk(20n, 2_000_000_000n, 1),
      chunk(0n, 0n, 1),
      chunk(10n, 1_000_000_000n, 2),
      chunk(30n, 3_000_000_000n, 1),
    ],
    readMessages: jest.fn(async function* () {
      yield* [];
    }),
  } as unknown as McapIndexedReader;
  const source = new McapIndexedIterableSource(reader, prefetch);
  const iterator = source.messageIterator({
    topics: new Map([["camera", { topic: "camera" }]]),
    start: { sec: 1, nsec: 0 },
    end: { sec: 2, nsec: 100 },
  });
  await iterator.next();
  expect(prefetch).toHaveBeenCalledWith([{ start: 20, end: 32 }]);
  expect(stop).toHaveBeenCalledTimes(1);
});
