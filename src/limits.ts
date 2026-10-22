import type { Request, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { AuthUser } from './auth.ts';

// Request rate limits. Counts are kept in this process's memory, so with several API instances each one counts
// separately (fine for a family-sized site; use a shared store such as Redis if you ever run many instances).

export interface RateLimits {
  /** Any /api request, per IP address, per 5 minutes (stops floods, including of bad tokens). */
  requestsPer5Min: number;
  /** Changes (POST/PATCH/DELETE), per signed-in user, per minute. */
  writesPerMinute: number;
  /** New trees, per signed-in user, per hour. */
  treesPerHour: number;
  /** People added to trees as members, per signed-in user, per hour. */
  invitesPerHour: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  requestsPer5Min: 1000, writesPerMinute: 120, treesPerHour: 10, invitesPerHour: 60,
};

const ipKey = (req: Request) => ipKeyGenerator(req.ip ?? '');
const userKey = (req: Request, res: Response) => (res.locals.user as AuthUser | undefined)?.id ?? ipKey(req);

function limiter(windowMs: number, limit: number, key: (req: Request, res: Response) => string, error: string,
  skip?: (req: Request) => boolean) {
  return rateLimit({
    windowMs, limit, keyGenerator: key, skip, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, res) => { res.status(429).json({ error }); },
  });
}

export function rateLimiters(l: RateLimits) {
  return {
    perIp: limiter(5 * 60_000, l.requestsPer5Min, ipKey,
      'Too many requests from your network. Please wait a few minutes and try again.'),
    writes: limiter(60_000, l.writesPerMinute, userKey,
      'You are saving changes very quickly. Please wait a minute and try again.',
      req => req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS'),
    trees: limiter(60 * 60_000, l.treesPerHour, userKey,
      'You have started a lot of trees in the last hour. Please try again later.'),
    invites: limiter(60 * 60_000, l.invitesPerHour, userKey,
      'You have added a lot of people in the last hour. Please try again later.'),
  };
}
