// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 KonboiOne
// SPDX-License-Identifier: MPL-2.0

import type { FileReader } from "./CachedFilelike.types";
import { RequestQueue } from "./RequestQueue";
import type { Range } from "./ranges";

const PREFETCH_WINDOW = 16;
const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;

type Entry = {
  range: Range;
  promise: Promise<Uint8Array>;
  settled: boolean;
  cancelled: boolean;
  readers: number;
  cancel?: (error: Error) => void;
};

/** Fetches indexed ranges in parallel without reading the gaps between them. */
export default class PrefetchingFilelike {
  readonly #fileReader: FileReader;
  readonly #cacheLimit: number;
  readonly #requests = new RequestQueue(PREFETCH_WINDOW);
  readonly #cache = new Map<string, Entry>();
  readonly #pending = new Set<Entry>();
  #cacheBytes = 0;
  #opening?: Promise<void>;
  #size?: number;
  #closed = false;
  #ranges: readonly Range[] = [];
  #head = 0;
  #generation = 0;

  public constructor(options: { fileReader: FileReader; cacheSizeInBytes?: number }) {
    this.#fileReader = options.fileReader;
    this.#cacheLimit = options.cacheSizeInBytes ?? DEFAULT_CACHE_BYTES;
    if (!Number.isSafeInteger(this.#cacheLimit) || this.#cacheLimit <= 0) {
      throw new Error("Invalid prefetch cache size");
    }
  }

  public async open(): Promise<void> {
    this.#assertOpen();
    this.#opening ??= this.#fileReader.open().then(({ size }) => {
      this.#assertOpen();
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error("Invalid file size");
      }
      this.#size = size;
    });
    await this.#opening;
  }

  public size(): number {
    if (this.#size == undefined) {
      throw new Error("PrefetchingFilelike has not been opened");
    }
    return this.#size;
  }

  public prefetch(ranges: readonly Range[]): () => void {
    this.#assertOpen();
    for (const range of ranges) {
      this.#validate(range.start, range.end - range.start);
      if (range.end === range.start) {
        throw new Error("Invalid byte range");
      }
    }
    const generation = ++this.#generation;
    this.#ranges = ranges;
    this.#head = 0;
    this.#cancelUnused();
    this.#pump();

    return () => {
      if (generation !== this.#generation || this.#closed) {
        return;
      }
      this.#ranges = [];
      this.#cancelUnused();
    };
  }

  public async read(offset: number, length: number): Promise<Uint8Array> {
    await this.open();
    this.#assertOpen();
    this.#validate(offset, length);
    if (length === 0) {
      return new Uint8Array();
    }

    const end = offset + length;
    const index = this.#ranges.findIndex((range) => range.start <= offset && end <= range.end);
    if (index >= 0) {
      this.#head = Math.max(this.#head, index);
      this.#pump();
    }
    let entry = Array.from(this.#cache.values()).find(
      (item) => item.range.start <= offset && end <= item.range.end,
    );
    entry ??= this.#create({ start: offset, end }, "demand");
    entry.readers++;
    if (this.#cache.get(this.#key(entry.range)) === entry) {
      this.#cache.delete(this.#key(entry.range));
      this.#cache.set(this.#key(entry.range), entry);
    }

    try {
      const data = await entry.promise;
      this.#assertOpen();
      return data.subarray(offset - entry.range.start, end - entry.range.start);
    } finally {
      entry.readers--;
      this.#pump();
    }
  }

  public close(): void {
    this.#closed = true;
    this.#ranges = [];
    for (const entry of this.#pending) {
      entry.cancelled = true;
      entry.cancel?.(new Error("PrefetchingFilelike is closed"));
    }
    this.#cache.clear();
    this.#cacheBytes = 0;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("PrefetchingFilelike is closed");
    }
  }

  #validate(offset: number, length: number): void {
    const end = offset + length;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      !Number.isSafeInteger(end) ||
      end > this.size()
    ) {
      throw new Error("Invalid byte range");
    }
  }

  #pump(): void {
    if (this.#closed) {
      return;
    }
    const upcomingRanges = this.#ranges.slice(this.#head, this.#head + PREFETCH_WINDOW);
    for (const range of upcomingRanges) {
      const entry = this.#cache.get(this.#key(range));
      if (entry?.range.end === range.end) {
        continue;
      }
      if (!this.#reserve(range.end - range.start, upcomingRanges)) {
        break;
      }
      this.#create(range, "prefetch");
    }
  }

  #reserve(length: number, protectedRanges: readonly Range[]): boolean {
    while (this.#cacheBytes + length > this.#cacheLimit) {
      const candidate = Array.from(this.#cache.values()).find(
        (entry) =>
          entry.settled &&
          entry.readers === 0 &&
          !protectedRanges.some(
            (range) => range.start === entry.range.start && range.end === entry.range.end,
          ),
      );
      if (!candidate) {
        return false;
      }
      this.#remove(candidate);
    }
    return true;
  }

  #key(range: Range): string {
    return `${range.start}-${range.end}`;
  }

  #remove(entry: Entry): void {
    if (this.#cache.get(this.#key(entry.range)) === entry) {
      this.#cache.delete(this.#key(entry.range));
      this.#cacheBytes -= entry.range.end - entry.range.start;
    }
  }

  #create(range: Range, mode: "demand" | "prefetch"): Entry {
    const length = range.end - range.start;
    const entry: Entry = {
      range,
      promise: Promise.resolve(new Uint8Array()),
      settled: false,
      cancelled: false,
      readers: 0,
    };
    // Large demanded reads remain transient, as in CachedFilelike. Only prefetch
    // and retained data use the cache budget; streaming parsing can remove this copy later.
    if (mode === "prefetch" || this.#reserve(length, [])) {
      const previous = this.#cache.get(this.#key(range));
      if (previous) {
        this.#remove(previous);
      }
      this.#cache.set(this.#key(range), entry);
      this.#cacheBytes += length;
    }
    this.#pending.add(entry);
    entry.promise = this.#requests.run(async () => {
      this.#assertOpen();
      if (entry.cancelled) {
        throw new Error("Prefetch cancelled");
      }
      return await this.#load(entry);
    });
    // Speculative failures are observed here and surfaced if the consumer reads
    // that entry. Keep the failed entry until eviction to avoid an automatic retry loop.
    void entry.promise.then(
      () => {
        this.#settled(entry);
      },
      () => {
        this.#settled(entry);
      },
    );
    return entry;
  }

  #settled(entry: Entry): void {
    entry.settled = true;
    this.#pending.delete(entry);
    this.#pump();
  }

  #cancelUnused(): void {
    for (const entry of this.#pending) {
      if (
        entry.readers === 0 &&
        !this.#ranges.some(
          (range) => range.start === entry.range.start && range.end === entry.range.end,
        )
      ) {
        entry.cancelled = true;
        entry.cancel?.(new Error("Prefetch cancelled"));
        this.#remove(entry);
      }
    }
  }

  async #load(entry: Entry): Promise<Uint8Array> {
    const length = entry.range.end - entry.range.start;
    return await new Promise<Uint8Array>((resolve, reject) => {
      const data = new Uint8Array(length);
      const stream = this.#fileReader.fetch(entry.range.start, length);
      let received = 0;
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) {
          return;
        }
        finished = true;
        stream.destroy();
        if (error) {
          reject(error);
        } else {
          resolve(data);
        }
      };
      entry.cancel = finish;
      stream.on("error", finish);
      stream.on("end", () => {
        finish(new Error("Range response ended early"));
      });
      stream.on("data", (chunk: Uint8Array) => {
        if (finished) {
          return;
        }
        if (received + chunk.byteLength > length) {
          finish(new Error("Range response exceeds requested length"));
          return;
        }
        data.set(chunk, received);
        received += chunk.byteLength;
        if (received === length) {
          finish();
        }
      });
    });
  }
}
