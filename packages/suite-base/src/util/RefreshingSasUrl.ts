// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 KonboiOne
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

const REFRESH_MARGIN_MS = 60_000;

type Access = { url: string; expiresAt: number };

/** Keeps short-lived Blob credentials out of the data-source URL and browser history. */
export default class RefreshingSasUrl {
  readonly #endpoint: string;
  readonly #fetch: typeof globalThis.fetch;
  #access?: Access;
  #pending?: Promise<string>;

  public constructor(endpoint: string, fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)) {
    this.#endpoint = endpoint;
    this.#fetch = fetch;
  }

  public async url(): Promise<string> {
    if (this.#access && this.#access.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
      return this.#access.url;
    }

    return await this.#load();
  }

  public async refresh(): Promise<string> {
    return await this.#load();
  }

  async #load(): Promise<string> {
    if (!this.#pending) {
      this.#pending = this.#request().finally(() => {
        this.#pending = undefined;
      });
    }

    return await this.#pending;
  }

  async #request(): Promise<string> {
    const response = await this.#fetch(this.#endpoint, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Visualization access failed with status ${response.status}`);
    }

    const access = parseAccess(await response.json());
    if (!access) {
      throw new Error("Invalid visualization access response");
    }

    this.#access = access;
    return access.url;
  }
}

function parseAccess(value: unknown): Access | undefined {
  if (typeof value !== "object" || value == undefined) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.url !== "string" || typeof candidate.expiresAt !== "string") {
    return undefined;
  }

  try {
    const url = new URL(candidate.url);
    const expiry = Date.parse(candidate.expiresAt);

    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".blob.core.windows.net") ||
      url.searchParams.get("sp") !== "r" ||
      !url.searchParams.has("sig") ||
      !Number.isFinite(expiry) ||
      expiry - Date.now() <= REFRESH_MARGIN_MS
    ) {
      return undefined;
    }

    return { url: candidate.url, expiresAt: expiry };
  } catch {
    return undefined;
  }
}
