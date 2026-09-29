// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 KonboiOne
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { EventEmitter } from "eventemitter3";

import type RefreshingSasUrl from "@lichtblick/suite-base/util/RefreshingSasUrl";
import { RequestQueue } from "@lichtblick/suite-base/util/RequestQueue";

export const PARALLEL_RANGE_BYTES = 8 * 1024 * 1024;
const MAX_CONCURRENT_RANGES = 16;
const requests = new RequestQueue(MAX_CONCURRENT_RANGES);

type Events = {
  data: (chunk: Uint8Array) => void;
  end: () => void;
  error: (error: Error) => void;
};

/** Reads ordered batches with at most 128 MiB of transient buffers per stream. */
export default class ParallelHttpReader extends EventEmitter<Events> {
  readonly #access: Pick<RefreshingSasUrl, "url" | "refresh">;
  readonly #offset: number;
  readonly #length: number;
  readonly #size: number;
  readonly #etag?: string;
  readonly #controller = new AbortController();
  #started = false;
  #stopped = false;
  #failure?: Error;

  public constructor(
    access: Pick<RefreshingSasUrl, "url" | "refresh">,
    offset: number,
    length: number,
    options: { size: number; etag?: string },
  ) {
    super();
    this.#access = access;
    this.#offset = offset;
    this.#length = length;
    this.#size = options.size;
    this.#etag = options.etag;
  }

  public read(): void {
    if (this.#started || this.#stopped) {
      return;
    }
    this.#started = true;
    void this.#run().then(
      () => {
        if (!this.#stopped) {
          this.#stopped = true;
          this.emit("end");
        }
      },
      (error: unknown) => {
        if (!this.#stopped) {
          this.destroy();
          this.emit(
            "error",
            error instanceof Error ? error : new Error("Parallel range read failed"),
          );
        }
      },
    );
  }

  public destroy(): void {
    this.#stopped = true;
    this.#controller.abort();
  }

  async #run(): Promise<void> {
    const end = this.#offset + this.#length;
    if (
      !Number.isSafeInteger(this.#offset) ||
      this.#offset < 0 ||
      !Number.isSafeInteger(this.#length) ||
      this.#length <= 0 ||
      !Number.isSafeInteger(end) ||
      end > this.#size
    ) {
      throw new Error("Invalid parallel byte range");
    }

    for (let start = this.#offset; start < end && !this.#stopped; ) {
      const batch: Array<Promise<Uint8Array | undefined>> = [];
      for (let index = 0; index < MAX_CONCURRENT_RANGES && start < end; index++) {
        const offset = start;
        const length = Math.min(PARALLEL_RANGE_BYTES, end - start);
        start += length;
        batch.push(
          requests
            .run(async () => await this.#load(offset, length))
            .catch((error: unknown) => {
              this.#failure ??=
                error instanceof Error ? error : new Error("Parallel range read failed");
              this.#controller.abort();
              return undefined;
            }),
        );
      }

      // Drain in byte order. Start the next batch only after this one is emitted,
      // so a slow first range cannot accumulate an unbounded read-ahead buffer.
      for (const pending of batch) {
        const data = await pending;
        if (this.#controller.signal.aborted) {
          this.#throwIfFailed();
          return;
        }
        if (data) {
          this.emit("data", data);
        }
      }
    }
  }

  #throwIfFailed(): void {
    if (this.#failure) {
      throw this.#failure;
    }
  }

  async #load(offset: number, length: number): Promise<Uint8Array> {
    const headers = new Headers({ range: `bytes=${offset}-${offset + length - 1}` });
    if (this.#etag) {
      headers.set("if-match", this.#etag);
    }
    const signal = this.#controller.signal;
    const url = await this.#access.url();
    signal.throwIfAborted();
    let response = await fetch(url, { headers, signal });
    if (response.status === 403) {
      await response.body?.cancel();
      const renewed = await this.#access.refresh();
      signal.throwIfAborted();
      response = await fetch(renewed, { headers, signal });
    }

    const expectedRange = `bytes ${offset}-${offset + length - 1}/${this.#size}`;
    if (
      response.status !== 206 ||
      response.headers.get("content-range") !== expectedRange ||
      !response.body
    ) {
      await response.body?.cancel();
      throw new Error(`Invalid parallel range response (status ${response.status})`);
    }

    const reader = response.body.getReader();
    const result = new Uint8Array(length);
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (received + value.byteLength > length) {
          throw new Error("Parallel range response exceeds requested length");
        }
        result.set(value, received);
        received += value.byteLength;
      }
      if (received !== length) {
        throw new Error("Parallel range response ended early");
      }
      return result;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
