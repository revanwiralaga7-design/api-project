import { logger } from "../utils/logger.js";

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const status = err.statusCode || err.status || 500;
  const message = err.message || "Internal Server Error";

  // 5xx = bug/kegagalan server -> error + stack lengkap.
  // 4xx = kesalahan pemakaian (key salah, param kurang) -> warn tanpa
  // stack, biar log production gak kebanjiran stack trace non-bug.
  // (logger otomatis silent di NODE_ENV=test — lihat utils/logger.js)
  const ctx = { method: req.method, url: req.originalUrl, status, ip: req.ip };
  if (status >= 500) logger.error({ ...ctx, err }, message);
  else logger.warn(ctx, message);

  res.status(status).json({
    status: false,
    error: message,
  });
}

export default errorHandler;
