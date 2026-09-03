// ===== 速率限制中间件 =====
// 基于内存的简单限流，防止暴力破解和滥用
// 生产环境建议改用 Redis 实现分布式限流

// 存储：key -> { count, resetAt }
const buckets = new Map();

// 清理过期桶
function cleanup() {
  const now = Date.now();
  for (const [k, v] of buckets) {
    if (v.resetAt <= now) buckets.delete(k);
  }
}
setInterval(cleanup, 60000).unref();

// 限流中间件
// opts: { windowMs, max, keyFn }
function rateLimit(opts = {}) {
  const windowMs = opts.windowMs || 60000;
  const max = opts.max || 60;
  const keyFn = opts.keyFn || ((req) => req.ip);
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count++;
    if (b.count > max) {
      const retryAfter = Math.ceil((b.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ ok: false, message: '请求过于频繁，请稍后再试' });
    }
    next();
  };
}

module.exports = { rateLimit };
