// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 KonboiOne
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import RefreshingSasUrl from "./RefreshingSasUrl";

describe("RefreshingSasUrl", () => {
  const now = Date.parse("2026-09-28T15:00:00Z");
  const endpoint = "https://records.example.test/api/v1/records/sha256-a/visualization-access";

  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("shares one request and renews before the URL expires", async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          url: "https://store.blob.core.windows.net/records/payload.mcap?sp=r&sig=first",
          expiresAt: "2026-09-28T15:05:00Z",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          url: "https://store.blob.core.windows.net/records/payload.mcap?sp=r&sig=second",
          expiresAt: "2026-09-28T15:10:00Z",
        }),
      });

    const resolver = new RefreshingSasUrl(endpoint, fetch);
    const [first, same] = await Promise.all([resolver.url(), resolver.url()]);
    expect(first).toBe(same);
    expect(fetch).toHaveBeenCalledTimes(1);

    jest.spyOn(Date, "now").mockReturnValue(now + 4 * 60_000 + 1);
    expect(await resolver.url()).toContain("sig=second");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith(endpoint, { cache: "no-store" });
  });

  it("forces a fresh URL after an expired range request", async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          url: "https://store.blob.core.windows.net/records/payload.mcap?sp=r&sig=first",
          expiresAt: "2026-09-28T15:05:00Z",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          url: "https://store.blob.core.windows.net/records/payload.mcap?sp=r&sig=second",
          expiresAt: "2026-09-28T15:10:00Z",
        }),
      });

    const resolver = new RefreshingSasUrl(endpoint, fetch);
    await resolver.url();

    expect(await resolver.refresh()).toContain("sig=second");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid URL or expiry from the access endpoint", async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        url: "http://store.example.test/payload.mcap",
        expiresAt: "bad",
      }),
    });

    await expect(new RefreshingSasUrl(endpoint, fetch).url()).rejects.toThrow(
      "Invalid visualization access response",
    );
  });
});
