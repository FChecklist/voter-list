// Cloudflare Pages Function: every /api/* request goes to the same handler the tests exercise.
import { handle } from "../../src/handler";
import type { Env } from "../../src/db";
export const onRequest = (ctx: { request: Request; env: Env; waitUntil: (p: Promise<unknown>) => void }) => handle(ctx.request, { ...ctx.env, waitUntil: (p) => ctx.waitUntil(p) });
