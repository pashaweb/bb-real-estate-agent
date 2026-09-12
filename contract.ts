// The RPC contract shared by server.ts and host.ts.
//
// Reading an Idealista page needs a real browser on the user's machine, which
// only the full-trust host entry can drive. The server owns settings, storage
// and scoring; the host owns Chrome.

import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

export const hostContract = defineRpcContract({
  browserStatus: {
    input: z
      .object({
        port: z.number().int().min(1).max(65535),
        profileDir: z.string().nullable(),
        chromeBin: z.string().nullable(),
      })
      .strict(),
    output: z
      .object({
        running: z.boolean(),
        port: z.number(),
        browser: z.string().optional(),
      })
      .strict(),
  },
  /** Reads the standalone app's SQLite, on the machine that invoked the command. */
  readLegacyDb: {
    input: z.object({ path: z.string().min(1) }).strict(),
    output: z
      .object({
        rows: z.array(
          z.object({
            url: z.string(),
            listing: z.string(),
            verdictText: z.string().nullable(),
            verdictScore: z.number().nullable(),
            verdictAt: z.string().nullable(),
          })
        ),
      })
      .strict(),
  },
  fetchListing: {
    input: z
      .object({
        url: z.string().url(),
        port: z.number().int().min(1).max(65535),
        profileDir: z.string().nullable(),
        chromeBin: z.string().nullable(),
      })
      .strict(),
    output: z
      .object({
        blocked: z.boolean(),
        url: z.string(),
        title: z.string(),
        text: z.string(),
        message: z.string().optional(),
        structured: z
          .object({
            title: z.string().nullable().optional(),
            subtitle: z.string().nullable().optional(),
            price: z.string().nullable().optional(),
            features: z.array(z.string()).optional(),
            description: z.string().nullable().optional(),
          })
          .nullable()
          .optional(),
      })
      .strict(),
  },
});
