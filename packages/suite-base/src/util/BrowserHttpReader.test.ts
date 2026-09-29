// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 KonboiOne
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import BrowserHttpReader from "./BrowserHttpReader";

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
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { status: 206 }));
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it("opens the Blob with HEAD and pins subsequent ranges to its ETag", async () => {
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
