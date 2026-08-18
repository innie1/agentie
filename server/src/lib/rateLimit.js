const buckets = new Map();

export function rateLimit({ windowMs = 60_000, max = 180 } = {}) {
  return (req, res, next) => {
    const identity = req.user?.id || req.ip || "unknown";
    const key = `${identity}:${Math.floor(Date.now() / windowMs)}`;
    const count = (buckets.get(key) || 0) + 1;
    buckets.set(key, count);
    if (buckets.size > 10_000) {
      const minimum = Math.floor(Date.now() / windowMs) - 2;
      for (const storedKey of buckets.keys()) if (Number(storedKey.split(":").at(-1)) < minimum) buckets.delete(storedKey);
    }
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, max - count)));
    if (count > max) return res.status(429).json({ error: "Too many requests. Please retry shortly." });
    next();
  };
}
