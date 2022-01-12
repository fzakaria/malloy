/* eslint-disable no-console */
/*
 * Copyright 2021 Google LLC
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * version 2 as published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { RuntimeList } from "./runtimes";

// No prebuilt shared model, each test is complete.  Makes debugging easier.

const runtimes = new RuntimeList([
  "bigquery", //
  // "postgres", //
]);

runtimes.runtimeMap.forEach((runtime, databaseName) => {
  // Issue: #151
  it(`unknonwn dialect  - ${databaseName}`, async () => {
    const result = await runtime
      .loadQuery(
        `
        query: q is table('malloytest.aircraft')->{
          group_by: state
        }

        explore: r is from(->q){
          query: foo is {
            group_by: state
          }
        }

        query: r->foo
    `
      )
      .run();
    // console.log(result.data.toObject());
    expect(result.data.path(0, "state").value).toBe("AL");
  });
});
