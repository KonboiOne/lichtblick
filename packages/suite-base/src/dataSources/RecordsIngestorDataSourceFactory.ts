// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 KonboiOne
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  IDataSourceFactory,
  DataSourceFactoryInitializeArgs,
} from "@lichtblick/suite-base/context/PlayerSelectionContext";
import { IterablePlayer } from "@lichtblick/suite-base/players/IterablePlayer";
import { WorkerSerializedIterableSource } from "@lichtblick/suite-base/players/IterablePlayer/WorkerSerializedIterableSource";
import { expandVideoSeekBackfill } from "@lichtblick/suite-base/players/IterablePlayer/videoSeekBackfill";
import { Player } from "@lichtblick/suite-base/players/types";

const ACCESS_PATH = /^\/api\/v1\/records\/sha256-[0-9a-f]{64}\/visualization-access$/;

export function validRecordsAccessUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      ACCESS_PATH.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export default class RecordsIngestorDataSourceFactory implements IDataSourceFactory {
  public id = "records-ingestor";
  public type: IDataSourceFactory["type"] = "connection";
  public displayName = "Records Ingestor";
  public hidden = true;
  public formConfig = {
    fields: [
      {
        id: "url",
        label: "Record access URL",
        validate: (value: string): Error | undefined =>
          validRecordsAccessUrl(value)
            ? undefined
            : new Error("Enter a Records Ingestor access URL"),
      },
    ],
  };

  public initialize(args: DataSourceFactoryInitializeArgs): Player | undefined {
    const url = args.params?.url;
    if (!url) {
      return;
    }
    if (!validRecordsAccessUrl(url)) {
      throw new Error("Invalid Records Ingestor access URL");
    }

    const initWorker = () =>
      new Worker(
        // foxglove-depcheck-used: babel-plugin-transform-import-meta
        new URL(
          "@lichtblick/suite-base/players/IterablePlayer/Mcap/McapIterableSourceWorker.worker",
          import.meta.url,
        ),
      );
    const source = new WorkerSerializedIterableSource({
      initWorker,
      initArgs: { url, refreshAccess: true },
    });

    return new IterablePlayer({
      source,
      name: url.split("/").at(-2) ?? "record",
      metricsCollector: args.metricsCollector,
      urlParams: { url },
      sourceId: this.id,
      readAheadDuration: { sec: 10, nsec: 0 },
      expandBackfill: expandVideoSeekBackfill,
    });
  }
}
