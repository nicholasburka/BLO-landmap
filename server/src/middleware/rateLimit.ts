import rateLimit from 'express-rate-limit'

export const queryRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment.' },
})

/** Strict limit on the password endpoint — this is the brute-force surface. */
export const authRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a minute.' },
})

/** Anonymous session mint — one per pageload in normal use, so a low
 *  ceiling costs legitimate users nothing but stops token-mint floods. */
export const sessionRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment.' },
})
