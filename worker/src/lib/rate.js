/** Simple fixed-window rate limit in D1. */
export async function rateLimit(db, key, limit, windowMs) {
  const now = Date.now();
  const windowStart = now - (now % windowMs);
  const row = await db.prepare(`SELECT window_start, count FROM rate_limits WHERE key = ?`).bind(key).first();
  if (!row || row.window_start !== windowStart) {
    await db
      .prepare(
        `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1`
      )
      .bind(key, windowStart)
      .run();
    return { ok: true, remaining: limit - 1 };
  }
  if (row.count >= limit) return { ok: false, remaining: 0 };
  await db.prepare(`UPDATE rate_limits SET count = count + 1 WHERE key = ?`).bind(key).run();
  return { ok: true, remaining: limit - row.count - 1 };
}
