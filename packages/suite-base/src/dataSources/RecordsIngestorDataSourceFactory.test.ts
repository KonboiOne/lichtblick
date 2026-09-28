// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 KonboiOne
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { validRecordsAccessUrl } from "./RecordsIngestorDataSourceFactory";

const recordId = `sha256-${"a".repeat(64)}`;

describe("records-ingestor data source URL", () => {
  it("accepts only a stable HTTPS record access endpoint", () => {
    expect(
      validRecordsAccessUrl(
        `https://records.example.test/api/v1/records/${recordId}/visualization-access`,
      ),
    ).toBe(true);

    expect(
      validRecordsAccessUrl(
        `http://records.example.test/api/v1/records/${recordId}/visualization-access`,
      ),
    ).toBe(false);
    expect(
      validRecordsAccessUrl(
        `https://records.example.test/api/v1/records/${recordId}/visualization-access?sig=secret`,
      ),
    ).toBe(false);
    expect(
      validRecordsAccessUrl(
        "https://records.example.test/api/v1/records/sha256-bad/visualization-access",
      ),
    ).toBe(false);
  });
});
