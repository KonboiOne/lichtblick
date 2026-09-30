// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/
//
// This file incorporates work covered by the following copyright and
// permission notice:
//
//   Copyright 2019-2021 Cruise LLC
//
//   This source code is licensed under the Apache License, Version 2.0,
//   found at http://www.apache.org/licenses/LICENSE-2.0
//   You may not use this file except in compliance with the License.

import type { FileReader, FileStream } from "@lichtblick/suite-base/util/CachedFilelike.types";
import FetchReader from "@lichtblick/suite-base/util/FetchReader";
import ParallelHttpReader from "@lichtblick/suite-base/util/ParallelHttpReader";
import RefreshingSasUrl from "@lichtblick/suite-base/util/RefreshingSasUrl";
import isDesktopApp from "@lichtblick/suite-base/util/isDesktopApp";

// A file reader that reads from a remote HTTP URL, for usage in the browser (not for node.js).
export default class BrowserHttpReader implements FileReader {
  #url: string;
  #access?: RefreshingSasUrl;
  #etag?: string;
  #size?: number;

  public constructor(url: string, options?: { refreshAccess?: boolean }) {
    this.#url = url;
    if (options?.refreshAccess === true) {
      this.#access = new RefreshingSasUrl(url);
    }
  }

  public async open(): Promise<{ size: number; identifier?: string }> {
    let response: Response;
    try {
      // Use HEAD for Records Ingestor so opening a bag transfers no payload. Other remote
      // sources may not support HEAD, so keep their GET-and-abort behavior.
      // "no-store" forces an unconditional request and preserves the file size headers.
      const controller = new AbortController();
      // Records Ingestor serves the same metadata with HEAD, without opening a full bag stream.
      const request = {
        signal: controller.signal,
        cache: "no-store" as const,
        method: this.#access ? "HEAD" : "GET",
      };
      response = await fetch(this.#access ? await this.#access.url() : this.#url, request);
      if (response.status === 403 && this.#access) {
        response = await fetch(await this.#access.refresh(), request);
      }
      controller.abort();
    } catch (error) {
      let errMsg = `Fetching remote file failed. ${error}`;

      if (!isDesktopApp()) {
        errMsg +=
          "\n\nSometimes this is due to a CORS configuration error on the server. Make sure CORS is enabled.";
      }

      throw new Error(errMsg);
    }
    if (!response.ok) {
      throw new Error(
        `Fetching remote file failed. <${this.#url}> Status code: ${response.status}.`,
      );
    }
    if (response.headers.get("accept-ranges") !== "bytes") {
      let errMsg =
        "Support for HTTP Range requests was not detected on the remote file.\n\nConfirm the resource has an 'Accept-Ranges: bytes' header.";

      if (!isDesktopApp()) {
        errMsg +=
          "\n\nSometimes this is due to a CORS configuration error on the server. Make sure CORS is enabled with Access-Control-Allow-Origin, and that Access-Control-Expose-Headers includes Accept-Ranges.";
      }

      throw new Error(errMsg);
    }
    const size = response.headers.get("content-length");
    if (size == undefined) {
      throw new Error(`Remote file is missing file size. <${this.#url}>`);
    }
    this.#etag = response.headers.get("etag") ?? undefined;
    this.#size = Number(size);
    if (!Number.isSafeInteger(this.#size) || this.#size < 0) {
      throw new Error("Remote file has an invalid file size");
    }
    return {
      size: this.#size,
      identifier:
        response.headers.get("etag") ?? response.headers.get("last-modified") ?? undefined,
    };
  }

  public fetch(offset: number, length: number): FileStream {
    if (this.#access && this.#size != undefined) {
      const reader = new ParallelHttpReader(this.#access, offset, length, {
        size: this.#size,
        etag: this.#etag,
      });
      reader.read();
      return reader;
    }

    const headers = new Headers({
      range: `bytes=${offset}-${offset + (length - 1)}`,
    });
    if (this.#etag) {
      headers.set("if-match", this.#etag);
    }
    const reader = new FetchReader(this.#access ?? this.#url, { headers });
    reader.read();
    return reader;
  }
}
